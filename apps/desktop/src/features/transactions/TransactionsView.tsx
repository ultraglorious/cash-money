import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ActionIcon, Badge, Box, Button, Checkbox, Collapse, Group, Menu, Select, Text, TextInput, Title, Tooltip } from "@mantine/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  IconArrowsSplit,
  IconCheck,
  IconChecks,
  IconChevronDown,
  IconChevronUp,
  IconClock,
  IconDots,
  IconPlus,
  IconRepeat,
  IconSearch,
  IconSelector,
  IconTags,
  IconTrash,
} from "@tabler/icons-react";
import { newId, ops, type Cents, type Transaction, type Ulid } from "@cash-money/core";
import { useApp } from "../../state";
import { categoryOptions } from "../../categoryOptions";
import { money } from "../../format";
import { amountColor } from "../../theme";
import { EditorRow, type EditorSubmit } from "./EditorRow";
import { PayeesModal } from "./PayeesModal";
import { SplitEditorModal } from "./SplitEditorModal";
import { registerTemplate } from "./layout";

const todayIso = () => new Date().toISOString().slice(0, 10);
const FREQ_LABEL: Record<string, string> = { weekly: "weekly", biweekly: "2-weekly", monthly: "monthly", yearly: "yearly" };

export function TransactionsView() {
  const { budget, projection, currency, view, accountName, categoryName, addTransaction, updateTransaction, approveTransaction, approveTransactions, deleteTransaction, deleteTransactions, setClearedStatus, setSplits } = useApp();
  const [query, setQuery] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<Ulid | null>(null);
  const [splitting, setSplitting] = useState<Transaction | null>(null);
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" } | null>(null);
  const [schedOpen, setSchedOpen] = useState(true);
  const [payeesOpen, setPayeesOpen] = useState(false);
  const [selected, setSelected] = useState<Set<Ulid>>(new Set());

  const single = view.kind === "account" ? (view.accountId as Ulid) : null;
  const activeAccount = single ?? (account as Ulid | null);
  const template = registerTemplate(!!single);

  const categoryLabel = (t: Transaction): string => {
    if (t.transfer) return `Transfer: ${accountName(t.transfer.counterAccountId)}`;
    if (t.splits) return `Split (${t.splits.length})`;
    return categoryName(t.categoryId);
  };

  const payees = useMemo(
    () => [...new Set(budget.transactions.map((t) => t.payee).filter((p) => p.trim() && !p.startsWith("Transfer :")))].sort(),
    [budget],
  );
  const lastCatByPayee = useMemo(() => {
    const m = new Map<string, Ulid>();
    [...budget.transactions].sort((a, b) => (a.date < b.date ? 1 : -1)).forEach((t) => {
      if (t.categoryId && t.payee && !m.has(t.payee)) m.set(t.payee, t.categoryId);
    });
    return m;
  }, [budget]);

  const categoryData = categoryOptions(budget);
  const accountData = budget.accounts.map((a) => ({ value: a.id, label: a.name }));

  const cycleSort = (col: string) => setSort((s) => (s?.col !== col ? { col, dir: "asc" } : s.dir === "asc" ? { col, dir: "desc" } : null));
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
        if (!sort) return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
        const va = sortValue(a, sort.col);
        const vb = sortValue(b, sort.col);
        const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
        return sort.dir === "asc" ? cmp : -cmp;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budget, query, activeAccount, sort]);

  // Scheduled (unapproved) transactions are pending: they don't hit the budget
  // until approved. Surface them separately, soonest first, above the register.
  const scheduled = useMemo(() => rows.filter((t) => !t.approved).sort((a, b) => (a.date < b.date ? -1 : 1)), [rows]);
  const approved = useMemo(() => rows.filter((t) => t.approved), [rows]);
  const scheduledTotal = scheduled.reduce((s, t) => s + t.amount, 0);

  const parentRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: approved.length, getScrollElement: () => parentRef.current, estimateSize: () => 44, overscan: 14 });

  const title = single ? accountName(single) : "All Accounts";
  const balance = single ? projection.accountBalances().get(single) ?? 0 : null;
  const reconciledThrough = single ? budget.accounts.find((a) => a.id === single)?.reconciledThrough : undefined;
  // Cleared = what the bank shows; working (the big number) also counts
  // uncleared rows you've entered — money already spoken for.
  const clearedBalance = useMemo(
    () =>
      single
        ? budget.transactions
            .filter((t) => t.accountId === single && t.approved && t.cleared !== "uncleared")
            .reduce((s, t) => s + t.amount, 0)
        : null,
    [budget, single],
  );

  // ---- Multi-select ----------------------------------------------------------
  useEffect(() => setSelected(new Set()), [activeAccount]); // a selection never outlives its account view
  const toggleSelect = (id: Ulid) => {
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const selectedIds = [...selected];
  const selectedTxs = useMemo(() => budget.transactions.filter((t) => selected.has(t.id)), [budget, selected]);
  const selectedUnapproved = selectedTxs.filter((t) => !t.approved).map((t) => t.id);
  const bulk = (fn: (ids: Ulid[]) => void) => {
    fn(selectedIds);
    setSelected(new Set());
  };

  const addFromEditor = (data: EditorSubmit) => {
    // Future-dated entries are scheduled: they wait for approval on their day.
    const approved = data.date <= todayIso();
    // A card swipe isn't PAID until its bill is — new credit-card entries
    // start uncleared; debit entries settle immediately and start cleared.
    const isCard = budget.accounts.find((a) => a.id === data.accountId)?.type === "creditCard";
    const tx: Transaction = {
      id: newId(),
      accountId: data.accountId,
      date: data.date,
      effectiveDate: data.date,
      payee: data.payee,
      memo: data.memo,
      amount: data.amount,
      cleared: !approved || isCard ? "uncleared" : data.cleared,
      approved,
      ...(data.recurrence ? { recurrence: data.recurrence } : {}),
      ...(data.splits ? { splits: data.splits } : data.categoryId ? { categoryId: data.categoryId } : {}),
    };
    addTransaction(tx);
    // A repeating entry dated today (or earlier) enters the register right
    // away, so its next occurrence must be scheduled here; future-dated ones
    // get theirs when approved.
    if (approved && tx.recurrence) {
      const next = ops.scheduledSuccessor(tx);
      if (next) addTransaction(next);
    }
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
      recurrence: data.recurrence,
      ...(data.splits ? { splits: data.splits, categoryId: undefined } : { categoryId: data.categoryId, splits: undefined }),
    });
    setEditingId(null);
  };

  return (
    <Box style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 48px)" }}>
      <Group justify="space-between" mb="sm">
        <Group gap="sm" align="baseline">
          <Title order={3}>{title}</Title>
          {balance !== null && (
            <Tooltip label="Working balance — includes uncleared transactions you've already entered." withArrow>
              <Text size="lg" fw={600} c={amountColor(balance)}>{money(balance, currency)}</Text>
            </Tooltip>
          )}
          {clearedBalance !== null && clearedBalance !== balance && (
            <Tooltip label="Cleared balance — only cleared and reconciled rows; this is what the bank shows." withArrow>
              <Text size="xs" c="dimmed">cleared {money(clearedBalance, currency)}</Text>
            </Tooltip>
          )}
          {reconciledThrough && (
            <Tooltip label="A bank statement confirmed this account's transactions up to this date." withArrow>
              <Text size="xs" c="dimmed">✓ reconciled through {reconciledThrough}</Text>
            </Tooltip>
          )}
        </Group>
        <Button leftSection={<IconPlus size={16} />} onClick={() => { setEditingId(null); setAdding(true); }} disabled={adding}>
          Add transaction
        </Button>
      </Group>

      <Group mb="xs">
        <TextInput leftSection={<IconSearch size={16} />} placeholder="Search payee, memo, category…" value={query} onChange={(e) => setQuery(e.currentTarget.value)} style={{ flex: 1 }} />
        {!single && <Select placeholder="All accounts" clearable value={account} onChange={setAccount} data={accountData} w={220} />}
        <Button variant="default" leftSection={<IconTags size={16} />} onClick={() => setPayeesOpen(true)}>
          Payees
        </Button>
      </Group>

      {selected.size > 0 && (
        <Group gap="xs" mb="xs" px="sm" py={6} style={{ background: "var(--mantine-color-indigo-light)", borderRadius: 8 }}>
          <Text size="sm" fw={600}>{selected.size} selected</Text>
          {selectedUnapproved.length > 0 && (
            <Button size="xs" variant="light" color="orange" leftSection={<IconChecks size={14} />} onClick={() => bulk(() => approveTransactions(selectedUnapproved))}>
              Approve {selectedUnapproved.length}
            </Button>
          )}
          <Button size="xs" variant="light" color="teal" onClick={() => bulk((ids) => setClearedStatus(ids, "cleared"))}>Mark cleared</Button>
          <Button size="xs" variant="light" color="gray" onClick={() => bulk((ids) => setClearedStatus(ids, "uncleared"))}>Mark uncleared</Button>
          <Button
            size="xs"
            variant="light"
            color="red"
            leftSection={<IconTrash size={14} />}
            onClick={() => {
              if (window.confirm(`Delete ${selected.size} transaction${selected.size === 1 ? "" : "s"}?`)) bulk(deleteTransactions);
            }}
          >
            Delete
          </Button>
          <Button size="xs" variant="subtle" color="gray" onClick={() => setSelected(new Set())}>Clear selection</Button>
        </Group>
      )}

      {scheduled.length > 0 && (
        <Box mb="sm" style={{ border: "1px solid var(--mantine-color-orange-4)", borderRadius: 8, overflow: "hidden" }}>
          <Group justify="space-between" px="md" py={6} style={{ background: "var(--mantine-color-orange-light)" }}>
            <Group gap="xs" style={{ cursor: "pointer" }} onClick={() => setSchedOpen((o) => !o)}>
              <IconClock size={16} />
              <Text size="sm" fw={700}>Scheduled</Text>
              <Badge size="sm" color="orange" variant="filled">{scheduled.length}</Badge>
              <Text size="sm" c={amountColor(scheduledTotal)} fw={600}>{money(scheduledTotal, currency)}</Text>
              <Text size="xs" c="dimmed">— not yet counted in your budget</Text>
            </Group>
            <Tooltip label="Approves every scheduled transaction listed below" withArrow>
              <Button size="xs" variant="light" color="orange" leftSection={<IconChecks size={14} />} onClick={() => approveTransactions(scheduled.map((t) => t.id))}>
                Approve all
              </Button>
            </Tooltip>
          </Group>
          <Collapse in={schedOpen}>
            {scheduled.map((t) => {
              const due = t.date <= todayIso();
              if (editingId === t.id && !t.splits && !t.transfer) {
                return (
                  <EditorRow key={t.id} single={single} initial={t} payees={payees} lastCategoryOf={(p) => lastCatByPayee.get(p)} categoryData={categoryData} accountData={accountData} onSubmit={(d) => saveEdit(t, d)} onCancel={() => setEditingId(null)} />
                );
              }
              return (
                <Box
                  key={t.id}
                  onDoubleClick={() => !t.splits && !t.transfer && setEditingId(t.id)}
                  style={{
                    display: "grid", gridTemplateColumns: template, columnGap: 8, alignItems: "center", padding: "6px 10px",
                    borderTop: "1px solid var(--mantine-color-orange-2)",
                    background: due ? "light-dark(var(--mantine-color-orange-1), rgba(255,146,43,0.16))" : "light-dark(var(--mantine-color-orange-0), rgba(255,146,43,0.06))",
                    cursor: !t.splits && !t.transfer ? "pointer" : "default",
                  }}
                >
                  <Checkbox size="xs" checked={selected.has(t.id)} onChange={() => toggleSelect(t.id)} aria-label="Select row" />
                  <TxCells t={t} single={single} accountName={accountName} categoryLabel={categoryLabel} currency={currency} />
                  <Group gap={4} wrap="nowrap">
                    <StatusBadge t={t} onApprove={() => approveTransaction(t.id)} onSetCleared={(c) => updateTransaction(t.id, { cleared: c })} />
                    {t.recurrence && (
                      <Tooltip label={`Repeats ${FREQ_LABEL[t.recurrence.freq]} — approving schedules the next one`} withArrow>
                        <Badge size="xs" color="grape" variant="light" leftSection={<IconRepeat size={10} />}>{FREQ_LABEL[t.recurrence.freq]}</Badge>
                      </Tooltip>
                    )}
                  </Group>
                  <Group gap={2} wrap="nowrap" justify="flex-end">
                    <Tooltip label="Approve — count it in the budget" withArrow>
                      <ActionIcon variant="light" color="teal" size="sm" onClick={() => approveTransaction(t.id)} aria-label="Approve">
                        <IconCheck size={14} />
                      </ActionIcon>
                    </Tooltip>
                    <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => deleteTransaction(t.id)} aria-label="Delete">
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Group>
                </Box>
              );
            })}
          </Collapse>
        </Box>
      )}

      <Text size="xs" c="dimmed" mb={4}>
        {approved.length} transaction{approved.length === 1 ? "" : "s"} · double-click a row to edit
      </Text>

      {/* Column header */}
      <Box style={{ display: "grid", gridTemplateColumns: template, columnGap: 8, padding: "6px 10px", borderBottom: "1px solid var(--mantine-color-default-border)", fontWeight: 600, fontSize: 13, alignItems: "center" }}>
        <Checkbox
          size="xs"
          aria-label="Select all visible rows"
          checked={approved.length > 0 && approved.every((t) => selected.has(t.id))}
          indeterminate={approved.some((t) => selected.has(t.id)) && !approved.every((t) => selected.has(t.id))}
          onChange={(e) => setSelected(e.currentTarget.checked ? new Set(approved.map((t) => t.id)) : new Set())}
        />
        <SortCell col="date" label="Date" sort={sort} onSort={cycleSort} />
        {!single && <SortCell col="account" label="Account" sort={sort} onSort={cycleSort} />}
        <SortCell col="payee" label="Payee" sort={sort} onSort={cycleSort} />
        <SortCell col="category" label="Category" sort={sort} onSort={cycleSort} />
        <SortCell col="memo" label="Memo" sort={sort} onSort={cycleSort} />
        <SortCell col="amount" label="Amount" align="right" sort={sort} onSort={cycleSort} />
        <SortCell col="status" label="Status" sort={sort} onSort={cycleSort} />
        <Box />
      </Box>

      {adding && (
        <EditorRow single={single} payees={payees} lastCategoryOf={(p) => lastCatByPayee.get(p)} categoryData={categoryData} accountData={accountData} onSubmit={addFromEditor} onCancel={() => setAdding(false)} />
      )}

      <div ref={parentRef} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div style={{ height: virt.getTotalSize(), position: "relative" }}>
          {virt.getVirtualItems().map((vi) => {
            const t = approved[vi.index]!;
            const editing = editingId === t.id && !t.splits && !t.transfer;
            return (
              <div key={t.id} ref={virt.measureElement} data-index={vi.index} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` }}>
                {editing ? (
                  <EditorRow single={single} initial={t} payees={payees} lastCategoryOf={(p) => lastCatByPayee.get(p)} categoryData={categoryData} accountData={accountData} onSubmit={(d) => saveEdit(t, d)} onCancel={() => setEditingId(null)} />
                ) : (
                  <Box
                    onDoubleClick={() => !t.splits && !t.transfer && setEditingId(t.id)}
                    style={{ display: "grid", gridTemplateColumns: template, columnGap: 8, alignItems: "center", padding: "6px 10px", borderBottom: "1px solid var(--mantine-color-default-border)", cursor: !t.splits && !t.transfer ? "pointer" : "default", background: selected.has(t.id) ? "var(--mantine-color-indigo-light)" : undefined }}
                  >
                    <Checkbox size="xs" checked={selected.has(t.id)} onChange={() => toggleSelect(t.id)} aria-label="Select row" />
                    <TxCells t={t} single={single} accountName={accountName} categoryLabel={categoryLabel} currency={currency} />
                    <Group gap={4} wrap="nowrap">
                      <StatusBadge t={t} onApprove={() => approveTransaction(t.id)} onSetCleared={(c) => updateTransaction(t.id, { cleared: c })} />
                      {t.recurrence && (
                        <Tooltip label={`Repeats ${FREQ_LABEL[t.recurrence.freq]}`} withArrow>
                          <Badge size="xs" color="grape" variant="light" px={4}><IconRepeat size={10} /></Badge>
                        </Tooltip>
                      )}
                    </Group>
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target><ActionIcon variant="subtle" color="gray" aria-label="Row actions"><IconDots size={16} /></ActionIcon></Menu.Target>
                      <Menu.Dropdown>
                        {!t.transfer && <Menu.Item leftSection={<IconArrowsSplit size={14} />} onClick={() => setSplitting(t)}>{t.splits ? "Edit split" : "Split"}</Menu.Item>}
                        {!t.approved && <Menu.Item leftSection={<IconChecks size={14} />} onClick={() => approveTransaction(t.id)}>Approve</Menu.Item>}
                        <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => deleteTransaction(t.id)}>Delete</Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Box>
                )}
              </div>
            );
          })}
        </div>
        {approved.length === 0 && !adding && (
          <Text size="sm" c="dimmed" ta="center" py="xl">
            {scheduled.length > 0 ? "No approved transactions yet — approve the scheduled ones above." : "No transactions."}
          </Text>
        )}
      </div>

      <SplitEditorModal
        opened={!!splitting}
        onClose={() => setSplitting(null)}
        amount={splitting?.amount ?? (0 as Cents)}
        initialSplits={splitting?.splits}
        onSave={(splits) => { if (splitting) setSplits(splitting.id, splits); setSplitting(null); }}
        onUnsplit={splitting?.splits ? () => { setSplits(splitting.id, undefined, splitting.splits?.[0]?.categoryId); setSplitting(null); } : undefined}
      />
      <PayeesModal opened={payeesOpen} onClose={() => setPayeesOpen(false)} />
    </Box>
  );
}

/**
 * The status lifecycle, clickable: scheduled (pending, not counted) → approve →
 * uncleared (real, but not yet settled — e.g. on a card bill you haven't paid)
 * → cleared (actually paid). Reconciled is statement-confirmed and asks before
 * unlocking. Clicks stop propagating so they never trigger the row editor.
 */
function StatusBadge({ t, onApprove, onSetCleared }: {
  t: Transaction;
  onApprove: () => void;
  onSetCleared: (c: Transaction["cleared"]) => void;
}) {
  const stop = { onDoubleClick: (e: MouseEvent) => e.stopPropagation(), style: { cursor: "pointer" } };
  if (!t.approved) {
    const due = t.date <= todayIso();
    return (
      <Tooltip label="Pending your approval — click to enter it into the budget as uncleared" withArrow>
        <Badge size="xs" color="orange" variant={due ? "filled" : "light"} {...stop} onClick={(e) => { e.stopPropagation(); onApprove(); }}>
          {due ? "due" : "scheduled"}
        </Badge>
      </Tooltip>
    );
  }
  const next: Record<Transaction["cleared"], Transaction["cleared"]> = { uncleared: "cleared", cleared: "uncleared", reconciled: "uncleared" };
  const tip = {
    cleared: "Paid — settled at the bank. Click to mark uncleared.",
    uncleared: "Real but not yet settled (e.g. awaiting the card bill). Click to mark cleared.",
    reconciled: "Confirmed by a bank statement. Click to unlock as uncleared.",
  }[t.cleared];
  const click = (e: MouseEvent) => {
    e.stopPropagation();
    if (t.cleared === "reconciled" && !window.confirm("This row was confirmed by a bank statement. Mark it uncleared anyway?")) return;
    onSetCleared(next[t.cleared]);
  };
  return (
    <Tooltip label={tip} withArrow>
      <Badge size="xs" color={t.cleared === "reconciled" ? "blue" : t.cleared === "cleared" ? "teal" : "gray"} variant="light" {...stop} onClick={click}>
        {t.cleared}
      </Badge>
    </Tooltip>
  );
}

/** The shared read-only cells of one register row (scheduled and approved lists). */
function TxCells({ t, single, accountName, categoryLabel, currency }: {
  t: Transaction;
  single: Ulid | null;
  accountName: (id: Ulid) => string;
  categoryLabel: (t: Transaction) => string;
  currency: ReturnType<typeof useApp>["currency"];
}) {
  return (
    <>
      <Text size="sm">{t.date}</Text>
      {!single && <Text size="sm" lineClamp={1}>{accountName(t.accountId)}</Text>}
      <Text size="sm" lineClamp={1}>{t.payee}</Text>
      <Text size="sm" lineClamp={1} c={t.transfer ? "blue" : t.splits ? "grape" : undefined}>{categoryLabel(t)}</Text>
      <Text size="sm" c="dimmed" lineClamp={1}>{t.memo}</Text>
      <Text size="sm" fw={500} ta="right" c={amountColor(t.amount)}>{money(t.amount, currency)}</Text>
    </>
  );
}

function SortCell({ col, label, align, sort, onSort }: { col: string; label: string; align?: "right"; sort: { col: string; dir: "asc" | "desc" } | null; onSort: (col: string) => void }) {
  const dir = sort?.col === col ? sort.dir : null;
  return (
    <Group gap={4} wrap="nowrap" justify={align === "right" ? "flex-end" : "flex-start"} style={{ cursor: "pointer", userSelect: "none" }} onClick={() => onSort(col)}>
      <span>{label}</span>
      {dir === "asc" ? <IconChevronUp size={13} /> : dir === "desc" ? <IconChevronDown size={13} /> : <IconSelector size={13} style={{ opacity: 0.35 }} />}
    </Group>
  );
}
