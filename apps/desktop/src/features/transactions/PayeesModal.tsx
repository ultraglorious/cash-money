import { useMemo, useState } from "react";
import { ActionIcon, Badge, Box, Group, Modal, Pill, ScrollArea, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { IconCheck, IconPencil, IconPlus, IconSearch, IconX } from "@tabler/icons-react";
import type { Payee } from "@cash-money/core";
import { useActions, useBudgetState } from "../../state";

/**
 * The payee master list: every payee, how often you've used it, and the
 * technical strings a bank uses for it.
 *
 * A payee's identity is its id, not its spelling, so renaming it here (or
 * anywhere) leaves its aliases pointing at it. Renaming onto a name already in
 * use merges the two and keeps both sets of aliases — that's the point, tidying
 * bank-mangled names onto the one you actually use.
 */
export function PayeesModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { budget } = useBudgetState();
  const { renamePayee, rememberPayeeAlias, removePayeeAlias } = useActions();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");

  const rows = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of budget.transactions) {
      const p = t.payee.trim();
      if (!p || t.transfer || p.startsWith("Transfer :")) continue;
      counts.set(p.toLowerCase(), (counts.get(p.toLowerCase()) ?? 0) + 1);
    }
    // The master list is the source of names; transactions only supply counts.
    return [...(budget.payees ?? [])]
      .map((p) => ({ payee: p, count: counts.get(p.name.toLowerCase()) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.payee.name.localeCompare(b.payee.name));
  }, [budget]);

  const q = query.trim().toLowerCase();
  const visible = q
    ? rows.filter(({ payee }) => payee.name.toLowerCase().includes(q) || payee.aliases.some((a) => a.includes(q)))
    : rows;

  const saveEdit = () => {
    if (editing && draft.trim() && draft.trim() !== editing) renamePayee(editing, draft.trim());
    setEditing(null);
  };
  const saveAlias = (p: Payee) => {
    if (aliasDraft.trim()) rememberPayeeAlias(p.name, aliasDraft.trim());
    setAliasDraft("");
    setAddingTo(null);
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Payees" size="xl" centered>
      <Stack gap="xs">
        <TextInput
          leftSection={<IconSearch size={16} />}
          placeholder="Filter payees and their aliases…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <Text size="xs" c="dimmed">
          Renaming a payee updates every transaction that uses it and keeps its aliases; renaming onto an existing payee
          merges the two. An alias is what a bank calls this payee — imports use them to name rows the way you would.
        </Text>
        <ScrollArea.Autosize mah={460}>
          <Stack gap={4}>
            {visible.map(({ payee, count }) => (
              <Box key={payee.id} px={6} py={4} style={{ borderRadius: 6 }}>
                <Group justify="space-between" wrap="nowrap">
                  {editing === payee.name ? (
                    <Group gap={4} wrap="nowrap" style={{ flex: 1 }}>
                      <TextInput
                        size="xs"
                        value={draft}
                        onChange={(e) => setDraft(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit();
                          if (e.key === "Escape") setEditing(null);
                        }}
                        style={{ flex: 1 }}
                        autoFocus
                      />
                      <ActionIcon size="sm" color="teal" variant="light" onClick={saveEdit} aria-label="Save name">
                        <IconCheck size={14} />
                      </ActionIcon>
                      <ActionIcon size="sm" color="gray" variant="subtle" onClick={() => setEditing(null)} aria-label="Cancel rename">
                        <IconX size={14} />
                      </ActionIcon>
                    </Group>
                  ) : (
                    <>
                      <Text size="sm" lineClamp={1} style={{ flex: 1 }}>{payee.name}</Text>
                      <Group gap={6} wrap="nowrap">
                        <Badge size="sm" color="gray" variant="light">{count}</Badge>
                        <Tooltip label="Add an alias — a name a bank uses for this payee" withArrow>
                          <ActionIcon
                            size="sm"
                            variant="subtle"
                            color="gray"
                            onClick={() => { setAddingTo(payee.id); setAliasDraft(""); }}
                            aria-label={`Add an alias for ${payee.name}`}
                          >
                            <IconPlus size={14} />
                          </ActionIcon>
                        </Tooltip>
                        <ActionIcon
                          size="sm"
                          variant="subtle"
                          color="gray"
                          onClick={() => { setEditing(payee.name); setDraft(payee.name); }}
                          aria-label={`Rename ${payee.name}`}
                        >
                          <IconPencil size={14} />
                        </ActionIcon>
                      </Group>
                    </>
                  )}
                </Group>
                {(payee.aliases.length > 0 || addingTo === payee.id) && (
                  <Group gap={4} mt={4} wrap="wrap">
                    {payee.aliases.map((alias) => (
                      <Pill key={alias} size="sm" withRemoveButton onRemove={() => removePayeeAlias(payee.id, alias)}>
                        {alias}
                      </Pill>
                    ))}
                    {addingTo === payee.id && (
                      <TextInput
                        size="xs"
                        placeholder="what the bank calls it"
                        value={aliasDraft}
                        onChange={(e) => setAliasDraft(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveAlias(payee);
                          if (e.key === "Escape") { setAliasDraft(""); setAddingTo(null); }
                        }}
                        onBlur={() => saveAlias(payee)}
                        autoFocus
                        w={240}
                      />
                    )}
                  </Group>
                )}
              </Box>
            ))}
            {visible.length === 0 && <Text size="sm" c="dimmed" ta="center" py="md">No payees match.</Text>}
          </Stack>
        </ScrollArea.Autosize>
      </Stack>
    </Modal>
  );
}
