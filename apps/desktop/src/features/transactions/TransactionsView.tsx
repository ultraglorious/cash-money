import { useMemo, useState } from "react";
import { ActionIcon, Badge, Button, Group, Menu, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import {
  IconArrowsSplit,
  IconChecks,
  IconChevronDown,
  IconChevronUp,
  IconDots,
  IconPlus,
  IconSearch,
  IconSelector,
  IconTrash,
} from "@tabler/icons-react";
import { newId, type Cents, type Transaction, type Ulid } from "@cash-money/core";
import { useApp } from "../../state";
import { money } from "../../format";
import { amountColor } from "../../theme";
import { EditorRow, type EditorSubmit } from "./EditorRow";
import { SplitEditorModal } from "./SplitEditorModal";

export function TransactionsView() {
  const { budget, projection, currency, view, accountName, categoryName, addTransaction, updateTransaction, approveTransaction, deleteTransaction, setSplits } = useApp();
  const [query, setQuery] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<Ulid | null>(null);
  const [splitting, setSplitting] = useState<Transaction | null>(null);
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" } | null>(null);

  const single = view.kind === "account" ? (view.accountId as Ulid) : null;
  const activeAccount = single ?? (account as Ulid | null);

  const categoryLabel = (t: Transaction): string => {
    if (t.transfer) return `Transfer: ${accountName(t.transfer.counterAccountId)}`;
    if (t.splits) return `Split (${t.splits.length})`;
    return categoryName(t.categoryId);
  };

  const cycleSort = (col: string) =>
    setSort((s) => (s?.col !== col ? { col, dir: "asc" } : s.dir === "asc" ? { col, dir: "desc" } : null));
  const sortValue = (t: Transaction, col: string): string | number => {
    switch (col) {
      case "date": return t.date;
      case "account": return accountName(t.accountId);
      case "payee": return t.payee;
      case "category": return categoryLabel(t);
      case "memo": return t.memo;
      case "amount": return t.amount;
      case "status": return t.approved ? t.cleared : "scheduled";
      default: return "";
    }
  };

  // Autocomplete data + per-payee last category (most recent first).
  const payees = useMemo(
    () => [...new Set(budget.transactions.map((t) => t.payee).filter((p) => p.trim() && !p.startsWith("Transfer :")))].sort(),
    [budget],
  );
  const lastCatByPayee = useMemo(() => {
    const m = new Map<string, Ulid>();
    [...budget.transactions]
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .forEach((t) => {
        if (t.categoryId && t.payee && !m.has(t.payee)) m.set(t.payee, t.categoryId);
      });
    return m;
  }, [budget]);

  const categoryData = budget.groups
    .filter((g) => g.kind !== "income")
    .map((g) => ({ group: g.name, items: budget.categories.filter((c) => c.groupId === g.id).map((c) => ({ value: c.id, label: c.name })) }))
    .filter((grp) => grp.items.length > 0);
  const accountData = budget.accounts.map((a) => ({ value: a.id, label: a.name }));

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return budget.transactions
      .filter((t) => (activeAccount ? t.accountId === activeAccount : true))
      .filter((t) => {
        if (!q) return true;
        const hay = [t.payee, t.memo, categoryLabel(t), ...(t.splits?.map((s) => s.memo) ?? [])].join(" ").toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => {
        if (!sort) return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; // default: newest first
        const va = sortValue(a, sort.col);
        const vb = sortValue(b, sort.col);
        const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
        return sort.dir === "asc" ? cmp : -cmp;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budget, query, activeAccount, sort]);

  const title = single ? accountName(single) : "All Accounts";
  const balance = single ? projection.accountBalances().get(single) ?? 0 : null;
  const colCount = single ? 7 : 8;

  const addFromEditor = (data: EditorSubmit) => {
    const tx: Transaction = {
      id: newId(),
      accountId: data.accountId,
      date: data.date,
      effectiveDate: data.date,
      payee: data.payee,
      memo: data.memo,
      amount: data.amount,
      cleared: data.cleared,
      approved: true,
      ...(data.splits ? { splits: data.splits } : data.categoryId ? { categoryId: data.categoryId } : {}),
    };
    addTransaction(tx);
    setAdding(false);
  };

  const saveEdit = (t: Transaction, data: EditorSubmit) => {
    const keepEffective = t.effectiveDate !== t.date;
    updateTransaction(t.id, {
      accountId: data.accountId,
      date: data.date,
      effectiveDate: keepEffective ? t.effectiveDate : data.date,
      payee: data.payee,
      memo: data.memo,
      amount: data.amount,
      cleared: data.cleared,
      ...(data.splits ? { splits: data.splits, categoryId: undefined } : { categoryId: data.categoryId, splits: undefined }),
    });
    setEditingId(null);
  };

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Group gap="sm" align="baseline">
          <Title order={3}>{title}</Title>
          {balance !== null && (
            <Text size="lg" fw={600} c={amountColor(balance)}>
              {money(balance, currency)}
            </Text>
          )}
        </Group>
        <Button leftSection={<IconPlus size={16} />} onClick={() => { setEditingId(null); setAdding(true); }} disabled={adding}>
          Add transaction
        </Button>
      </Group>

      <Group>
        <TextInput leftSection={<IconSearch size={16} />} placeholder="Search payee, memo, category…" value={query} onChange={(e) => setQuery(e.currentTarget.value)} style={{ flex: 1 }} />
        {!single && <Select placeholder="All accounts" clearable value={account} onChange={setAccount} data={accountData} w={220} />}
      </Group>

      <Text size="xs" c="dimmed">
        {rows.length} transaction{rows.length === 1 ? "" : "s"} · double-click a row to edit
      </Text>

      <Table.ScrollContainer minWidth={860}>
        <Table verticalSpacing="xs" highlightOnHover stickyHeader>
          <Table.Thead>
            <Table.Tr>
              <SortTh col="date" label="Date" sort={sort} onSort={cycleSort} />
              {!single && <SortTh col="account" label="Account" sort={sort} onSort={cycleSort} />}
              <SortTh col="payee" label="Payee" sort={sort} onSort={cycleSort} />
              <SortTh col="category" label="Category" sort={sort} onSort={cycleSort} />
              <SortTh col="memo" label="Memo" sort={sort} onSort={cycleSort} />
              <SortTh col="amount" label="Amount" align="right" sort={sort} onSort={cycleSort} />
              <SortTh col="status" label="Status" sort={sort} onSort={cycleSort} />
              <Table.Th w={40} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {adding && (
              <EditorRow
                single={single}
                payees={payees}
                lastCategoryOf={(p) => lastCatByPayee.get(p)}
                categoryData={categoryData}
                accountData={accountData}
                onSubmit={addFromEditor}
                onCancel={() => setAdding(false)}
              />
            )}
            {rows.map((t) =>
              editingId === t.id && !t.splits && !t.transfer ? (
                <EditorRow
                  key={t.id}
                  single={single}
                  initial={t}
                  payees={payees}
                  lastCategoryOf={(p) => lastCatByPayee.get(p)}
                  categoryData={categoryData}
                  accountData={accountData}
                  onSubmit={(data) => saveEdit(t, data)}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <Table.Tr
                  key={t.id}
                  onDoubleClick={() => !t.splits && !t.transfer && setEditingId(t.id)}
                  style={{ cursor: !t.splits && !t.transfer ? "pointer" : "default" }}
                >
                  <Table.Td>{t.date}</Table.Td>
                  {!single && <Table.Td>{accountName(t.accountId)}</Table.Td>}
                  <Table.Td>{t.payee}</Table.Td>
                  <Table.Td>
                    <Text size="sm" c={t.transfer ? "blue" : t.splits ? "grape" : undefined}>
                      {categoryLabel(t)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed" lineClamp={1}>{t.memo}</Text>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Text size="sm" fw={500} c={amountColor(t.amount)}>{money(t.amount, currency)}</Text>
                  </Table.Td>
                  <Table.Td>
                    {!t.approved ? (
                      <Badge size="xs" color="orange" variant="light">scheduled</Badge>
                    ) : (
                      <Badge size="xs" color={t.cleared === "cleared" ? "teal" : "gray"} variant="light">{t.cleared}</Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target>
                        <ActionIcon variant="subtle" color="gray" aria-label="Row actions"><IconDots size={16} /></ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        {!t.transfer && <Menu.Item leftSection={<IconArrowsSplit size={14} />} onClick={() => setSplitting(t)}>{t.splits ? "Edit split" : "Split"}</Menu.Item>}
                        {!t.approved && <Menu.Item leftSection={<IconChecks size={14} />} onClick={() => approveTransaction(t.id)}>Approve</Menu.Item>}
                        <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => deleteTransaction(t.id)}>Delete</Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Table.Td>
                </Table.Tr>
              ),
            )}
            {rows.length === 0 && !adding && (
              <Table.Tr>
                <Table.Td colSpan={colCount}>
                  <Text size="sm" c="dimmed" ta="center" py="md">No transactions.</Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <SplitEditorModal
        opened={!!splitting}
        onClose={() => setSplitting(null)}
        amount={splitting?.amount ?? (0 as Cents)}
        initialSplits={splitting?.splits}
        onSave={(splits) => {
          if (splitting) setSplits(splitting.id, splits);
          setSplitting(null);
        }}
        onUnsplit={
          splitting?.splits
            ? () => {
                setSplits(splitting.id, undefined, splitting.splits?.[0]?.categoryId);
                setSplitting(null);
              }
            : undefined
        }
      />
    </Stack>
  );
}

function SortTh({
  col, label, align, sort, onSort,
}: {
  col: string;
  label: string;
  align?: "right";
  sort: { col: string; dir: "asc" | "desc" } | null;
  onSort: (col: string) => void;
}) {
  const activeDir = sort?.col === col ? sort.dir : null;
  return (
    <Table.Th ta={align} style={{ cursor: "pointer", userSelect: "none" }} onClick={() => onSort(col)}>
      <Group gap={4} justify={align === "right" ? "flex-end" : "flex-start"} wrap="nowrap">
        <span>{label}</span>
        {activeDir === "asc" ? <IconChevronUp size={13} /> : activeDir === "desc" ? <IconChevronDown size={13} /> : <IconSelector size={13} style={{ opacity: 0.35 }} />}
      </Group>
    </Table.Th>
  );
}
