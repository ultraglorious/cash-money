import { Badge, Group, Modal, Paper, Stack, Switch, Text } from "@mantine/core";
import type { AccountType } from "@cash-money/core";
import { useApp } from "../state";
import { money } from "../format";
import { amountColor } from "../theme";
import { InlineEditableText } from "./InlineEditableText";

function typeLabel(t: AccountType): string {
  return t === "creditCard" ? "Credit card" : t === "tracking" ? "Tracking" : "Cash";
}

export function ManageAccountsModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { budget, projection, currency, setAccountClosed, renameAccount } = useApp();
  const balances = projection.accountBalances();
  const accounts = [...budget.accounts].sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <Modal opened={opened} onClose={onClose} title="Manage accounts" centered>
      <Stack gap="xs">
        {accounts.map((a) => (
          <Paper key={a.id} withBorder p="xs" radius="sm" opacity={a.closed ? 0.6 : 1}>
            <Group justify="space-between" wrap="nowrap">
              <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                <InlineEditableText value={a.name} onSubmit={(n) => renameAccount(a.id, n)} fw={500} />
                <Badge size="xs" variant="light" color="gray">{typeLabel(a.type)}</Badge>
                {a.household ? <Badge size="xs" variant="light" color="grape">{a.household}</Badge> : null}
              </Group>
              <Group gap="md" wrap="nowrap">
                <Text size="sm" c={amountColor(balances.get(a.id) ?? 0)}>{money(balances.get(a.id) ?? 0, currency)}</Text>
                <Switch size="sm" checked={!a.closed} onChange={(e) => setAccountClosed(a.id, !e.currentTarget.checked)} aria-label={a.closed ? "Show account" : "Hide account"} />
              </Group>
            </Group>
          </Paper>
        ))}
        <Text size="xs" c="dimmed">
          Turn a toggle off to hide an account (e.g. investments you no longer hold). Hidden accounts keep their history
          but drop out of the sidebar and totals. Double-click a name to rename it.
        </Text>
      </Stack>
    </Modal>
  );
}
