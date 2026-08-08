import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Checkbox, Group, Modal, ScrollArea, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArrowRight, IconInfoCircle } from "@tabler/icons-react";
import { findTransferCandidates, type TransferCandidate, type Ulid } from "@cash-money/core";
import { useActions, useBudgetState } from "../../state";
import { money } from "../../format";

const key = (c: TransferCandidate) => `${c.outflowId}|${c.inflowId}`;
const UNDO_NOTIFICATION = "link-transfers-undo";

/**
 * Money moved between your own budgets arrives from an export as two unrelated
 * rows — an envelope spend on one side, income on the other. This finds those
 * pairs and links them in one go, so they read as the transfers they always
 * were instead of needing a payee edited by hand.
 *
 * Confident matches are ticked; anything resting on coincidence is listed
 * separately and left for you to judge. Linking never changes a number —
 * it renames the two rows and records that they belong together.
 */
export function LinkTransfersModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { budget, currency } = useBudgetState();
  const { linkTransfers, undoBulk } = useActions();
  const accountName = (id: Ulid) => budget.accounts.find((a) => a.id === id)?.name ?? "—";

  const candidates = useMemo(() => (opened ? findTransferCandidates(budget) : []), [budget, opened]);
  const confident = candidates.filter((c) => c.confidence === "high");
  const unsure = candidates.filter((c) => c.confidence !== "high");

  const [ticked, setTicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (opened) setTicked(new Set(confident.map(key)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, candidates.length]);

  const toggle = (k: string) =>
    setTicked((s) => {
      const next = new Set(s);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });

  const commit = () => {
    const pairs = candidates.filter((c) => ticked.has(key(c))).map(({ outflowId, inflowId }) => ({ outflowId, inflowId }));
    if (pairs.length === 0) return;
    const { linked, drift } = linkTransfers(pairs);

    // Linking is only ever meant to describe money that already moved. If the
    // projection disagrees, nothing is applied — say so instead of quietly
    // leaving a wrong number behind.
    if (drift.length > 0) {
      notifications.show({
        color: "red",
        autoClose: false,
        title: "Nothing was linked",
        message: `That would have changed ${drift.length === 1 ? "a figure" : `${drift.length} figures`} in your budget, and linking is only supposed to rename things. Your budget is untouched — this is a bug worth reporting.`,
      });
      return;
    }

    // This carries the only undo affordance for an edit that can span years of
    // rows, so it stays until dismissed rather than expiring in four seconds.
    notifications.show({
      id: UNDO_NOTIFICATION,
      color: "teal",
      autoClose: false,
      title: `Linked ${linked} transfer${linked === 1 ? "" : "s"}`,
      message: (
        <Group gap="xs" align="center">
          <Text size="sm">Both sides now read as one transfer, with every figure unchanged.</Text>
          <Button
            size="compact-xs"
            variant="light"
            onClick={() => {
              undoBulk();
              notifications.hide(UNDO_NOTIFICATION);
              notifications.show({ color: "gray", message: "Linking undone — the rows read as they did before." });
            }}
          >
            Undo
          </Button>
        </Group>
      ),
    });
    onClose();
  };

  const Row = ({ c }: { c: TransferCandidate }) => (
    <Group
      key={key(c)}
      wrap="nowrap"
      gap="sm"
      px={8}
      py={6}
      style={{ borderRadius: 6, background: ticked.has(key(c)) ? "var(--mantine-color-indigo-light)" : undefined, cursor: "pointer" }}
      onClick={() => toggle(key(c))}
    >
      <Checkbox size="xs" checked={ticked.has(key(c))} onChange={() => toggle(key(c))} aria-label="Link this pair" />
      <Text size="sm" w={92} c="dimmed">{c.outflowDate}</Text>
      <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" lineClamp={1}>{accountName(c.outflowAccountId)}</Text>
        <IconArrowRight size={14} style={{ flexShrink: 0, opacity: 0.5 }} />
        <Text size="sm" lineClamp={1}>{accountName(c.inflowAccountId)}</Text>
      </Group>
      <Text size="sm" fw={500} ta="right" w={110}>{money(c.amount, currency)}</Text>
      <Text size="xs" c="dimmed" w={230} lineClamp={1} title={c.reason}>{c.reason}</Text>
      {c.dayGap > 0 && <Badge size="xs" variant="light" color="gray">{c.dayGap}d apart</Badge>}
    </Group>
  );

  return (
    <Modal opened={opened} onClose={onClose} title="Link transfers" size="80rem" centered>
      <Stack gap="sm">
        <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light" py={8}>
          <Text size="sm">
            Both rows stay exactly as they are — same dates, same amounts, and the sending side keeps the envelope that
            funded it. Linking only renames the pair and records that the two halves belong together, so nothing you see
            in Plan or Analytics shifts.
          </Text>
        </Alert>

        {candidates.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="xl">
            Nothing left to link — every transfer between your accounts is already paired up.
          </Text>
        ) : (
          <ScrollArea.Autosize mah={460}>
            <Stack gap="xs">
              {confident.length > 0 && (
                <>
                  <Group gap="xs">
                    <Text size="sm" fw={600}>Confident matches</Text>
                    <Badge size="sm" color="teal" variant="light">{confident.length}</Badge>
                    <Button size="compact-xs" variant="subtle" onClick={() => setTicked(new Set(confident.map(key)))}>Tick all</Button>
                    <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setTicked(new Set())}>Untick all</Button>
                  </Group>
                  <Stack gap={2}>{confident.map((c) => <Row key={key(c)} c={c} />)}</Stack>
                </>
              )}
              {unsure.length > 0 && (
                <>
                  <Group gap="xs" mt="sm">
                    <Text size="sm" fw={600}>Worth a look</Text>
                    <Badge size="sm" color="yellow" variant="light">{unsure.length}</Badge>
                    <Text size="xs" c="dimmed">same amount and close in time, but the evidence stops there</Text>
                  </Group>
                  <Stack gap={2}>{unsure.map((c) => <Row key={key(c)} c={c} />)}</Stack>
                </>
              )}
            </Stack>
          </ScrollArea.Autosize>
        )}

        <Group justify="space-between">
          <Text size="sm" c="dimmed">{ticked.size} selected</Text>
          <Group gap="xs">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button onClick={commit} disabled={ticked.size === 0}>
              Link {ticked.size} pair{ticked.size === 1 ? "" : "s"}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
