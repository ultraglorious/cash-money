import { useMemo, useState } from "react";
import { ActionIcon, Badge, Group, Modal, ScrollArea, Stack, Text, TextInput } from "@mantine/core";
import { IconCheck, IconPencil, IconSearch, IconX } from "@tabler/icons-react";
import { useActions, useBudgetState } from "../../state";

/**
 * Bulk payee management: every distinct payee with its usage count, renameable
 * in place. Renaming "X" to an existing payee "Y" merges them — that's the
 * point (tidying bank-mangled names onto the one you actually use).
 */
export function PayeesModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { budget } = useBudgetState();
  const { renamePayee } = useActions();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const payees = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of budget.transactions) {
      const p = t.payee.trim();
      if (!p || t.transfer || p.startsWith("Transfer :")) continue;
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [budget]);

  const q = query.trim().toLowerCase();
  const visible = q ? payees.filter(([p]) => p.toLowerCase().includes(q)) : payees;

  const startEdit = (payee: string) => {
    setEditing(payee);
    setDraft(payee);
  };
  const saveEdit = () => {
    if (editing && draft.trim() && draft.trim() !== editing) renamePayee(editing, draft.trim());
    setEditing(null);
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Payees" size="lg" centered>
      <Stack gap="xs">
        <TextInput
          leftSection={<IconSearch size={16} />}
          placeholder="Filter payees…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <Text size="xs" c="dimmed">
          Renaming a payee updates every transaction that uses it; renaming onto an existing payee merges the two.
        </Text>
        <ScrollArea.Autosize mah={420}>
          <Stack gap={2}>
            {visible.map(([payee, count]) => (
              <Group key={payee} justify="space-between" wrap="nowrap" px={6} py={3} style={{ borderRadius: 6 }} className="payee-row">
                {editing === payee ? (
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
                    <Text size="sm" lineClamp={1} style={{ flex: 1 }}>{payee}</Text>
                    <Group gap={6} wrap="nowrap">
                      <Badge size="sm" color="gray" variant="light">{count}</Badge>
                      <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => startEdit(payee)} aria-label={`Rename ${payee}`}>
                        <IconPencil size={14} />
                      </ActionIcon>
                    </Group>
                  </>
                )}
              </Group>
            ))}
            {visible.length === 0 && <Text size="sm" c="dimmed" ta="center" py="md">No payees match.</Text>}
          </Stack>
        </ScrollArea.Autosize>
      </Stack>
    </Modal>
  );
}
