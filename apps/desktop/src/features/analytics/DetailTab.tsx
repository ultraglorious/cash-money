import { Fragment, useMemo, useState } from "react";
import { ActionIcon, Group, ScrollArea, Table, Text } from "@mantine/core";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { detailTree, monthRange, type Cents, type DetailNode, type MonthKey } from "@cash-money/core";
import { useBudgetState } from "../../state";
import { money } from "../../format";
import { amountColor } from "../../theme";
import { monthLabel } from "./palette";

/**
 * The numbers behind everything: a drillable net-flow table, account →
 * section → category → payee, one column per month in the range plus a total.
 */
export function DetailTab({ from, to }: { from: MonthKey; to: MonthKey }) {
  const { budget, currency } = useBudgetState();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const tree = useMemo(() => detailTree(budget, from, to), [budget, from, to]);
  const months = monthRange(from, to);

  const toggle = (path: string) => {
    setOpen((s) => {
      const next = new Set(s);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  };

  const cell = (amount: Cents | undefined) =>
    amount === undefined || amount === 0 ? (
      <Text size="xs" c="dimmed" ta="right">—</Text>
    ) : (
      <Text size="xs" ta="right" c={amountColor(amount)}>{money(amount, currency)}</Text>
    );

  const renderRows = (nodes: DetailNode[], depth: number, prefix: string): React.ReactNode =>
    nodes.map((n) => {
      const path = `${prefix}/${n.key}`;
      const expandable = (n.children?.length ?? 0) > 0;
      const expanded = open.has(path);
      return (
        <Fragment key={path}>
          <Table.Tr onClick={() => expandable && toggle(path)} style={{ cursor: expandable ? "pointer" : "default" }}>
            <Table.Td style={{ paddingLeft: 10 + depth * 18, whiteSpace: "nowrap" }}>
              <Group gap={4} wrap="nowrap">
                {expandable ? (
                  <ActionIcon size="xs" variant="subtle" color="gray" aria-label={expanded ? "Collapse" : "Expand"}>
                    {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                  </ActionIcon>
                ) : (
                  <span style={{ width: 18 }} />
                )}
                <Text size="xs" fw={depth === 0 ? 600 : 400} lineClamp={1}>{n.label}</Text>
              </Group>
            </Table.Td>
            {months.map((m) => (
              <Table.Td key={m}>{cell(n.monthly[m])}</Table.Td>
            ))}
            <Table.Td style={{ borderLeft: "1px solid var(--mantine-color-default-border)" }}>
              <Text size="xs" ta="right" fw={600} c={amountColor(n.total)}>{money(n.total, currency)}</Text>
            </Table.Td>
          </Table.Tr>
          {expanded && n.children && renderRows(n.children, depth + 1, path)}
        </Fragment>
      );
    });

  return (
    <ScrollArea type="auto">
      <Table verticalSpacing={2} withColumnBorders={false} miw={280 + months.length * 96}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Account / section / category / payee</Table.Th>
            {months.map((m) => (
              <Table.Th key={m} ta="right" w={96}>{monthLabel(m)}</Table.Th>
            ))}
            <Table.Th ta="right" w={110}>Total</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {tree.length === 0 ? (
            <Table.Tr>
              <Table.Td colSpan={months.length + 2}><Text size="sm" c="dimmed">Nothing in this range.</Text></Table.Td>
            </Table.Tr>
          ) : (
            renderRows(tree, 0, "")
          )}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}
