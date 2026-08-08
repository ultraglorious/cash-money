import { ActionIcon, Badge, Button, Group, NavLink, ScrollArea, Stack, Text, ThemeIcon, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  IconBuildingBank,
  IconChartHistogram,
  IconCloud,
  IconCreditCard,
  IconArrowsExchange,
  IconFileImport,
  IconLayoutGrid,
  IconPigMoney,
  IconPlus,
  IconSettings,
  IconTargetArrow,
} from "@tabler/icons-react";
import type { Account, Ulid } from "@cash-money/core";
import { useApp } from "../state";
import { money } from "../format";
import { amountColor, householdColor } from "../theme";
import { AddAccountModal } from "./AddAccountModal";
import { BudgetFileModal } from "./BudgetFileModal";
import { ManageAccountsModal } from "./ManageAccountsModal";
import { ImportWizard } from "../features/import/ImportWizard";
import { LinkTransfersModal } from "../features/transactions/LinkTransfersModal";
import { Wordmark } from "./Wordmark";

function accountIcon(a: Account) {
  if (a.type === "creditCard") return IconCreditCard;
  if (a.type === "tracking") return IconPigMoney;
  return IconBuildingBank;
}

export function Sidebar() {
  const { budget, projection, currency, view, setView, setAccountOrder } = useApp();
  const [addOpen, addModal] = useDisclosure(false);
  const [importOpen, importModal] = useDisclosure(false);
  const [manageOpen, manageModal] = useDisclosure(false);
  const [fileOpen, fileModal] = useDisclosure(false);
  const [linkOpen, linkModal] = useDisclosure(false);
  const balances = projection.accountBalances();
  const households = projection.households;
  const balOf = (id: Ulid) => balances.get(id) ?? 0;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const sorted = [...budget.accounts].filter((a) => !a.closed).sort((a, b) => a.sortOrder - b.sortOrder);
  const cash = sorted.filter((a) => a.type === "checking");
  const credit = sorted.filter((a) => a.type === "creditCard");
  const tracking = sorted.filter((a) => a.type === "tracking");
  const total = (accts: Account[]) => accts.reduce((s, a) => s + balOf(a.id), 0);

  const onDragEnd = (e: DragEndEvent) => {
    const activeId = e.active.id as Ulid;
    const overId = e.over?.id as Ulid | undefined;
    if (!overId || activeId === overId) return;
    const a = budget.accounts.find((x) => x.id === activeId);
    const o = budget.accounts.find((x) => x.id === overId);
    if (!a || !o || a.type !== o.type) return; // reorder within a type group only
    const order = sorted.map((x) => x.id);
    setAccountOrder(arrayMove(order, order.indexOf(activeId), order.indexOf(overId)));
  };

  return (
    <Stack h="100%" gap={0}>
      <Stack gap={4} px="md" py="md">
        <Wordmark size={30} />
        <Text size="xs" c="dimmed" truncate>
          {budget.budget.name} · {budget.budget.currency.code}
        </Text>
      </Stack>

      <ScrollArea style={{ flex: 1 }} px="xs">
        <NavLink active={view.kind === "plan"} label="Plan" leftSection={<IconTargetArrow size={18} />} onClick={() => setView({ kind: "plan" })} variant="filled" />
        <NavLink active={view.kind === "analytics"} label="Analytics" leftSection={<IconChartHistogram size={18} />} onClick={() => setView({ kind: "analytics" })} variant="filled" />

        <Group justify="space-between" px="sm" mt="md" mb={4}>
          <Text size="xs" c="dimmed" fw={700} tt="uppercase">Accounts</Text>
          <Group gap={2}>
            <Tooltip label="Manage accounts" withArrow>
              <ActionIcon size="sm" variant="subtle" color="gray" onClick={manageModal.open} aria-label="Manage accounts"><IconSettings size={15} /></ActionIcon>
            </Tooltip>
            <Tooltip label="Add account" withArrow>
              <ActionIcon size="sm" variant="subtle" color="gray" onClick={addModal.open} aria-label="Add account"><IconPlus size={15} /></ActionIcon>
            </Tooltip>
          </Group>
        </Group>

        <NavLink
          active={view.kind === "all-accounts"}
          label="All Accounts"
          leftSection={<IconLayoutGrid size={18} />}
          rightSection={<Text size="xs" c={amountColor(total(sorted))} fw={600}>{money(total(sorted), currency)}</Text>}
          onClick={() => setView({ kind: "all-accounts" })}
        />

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <AccountGroup label="Cash" accounts={cash} total={total} balOf={balOf} households={households} currency={currency} view={view} setView={setView} />
          <AccountGroup label="Credit Cards" accounts={credit} total={total} balOf={balOf} households={households} currency={currency} view={view} setView={setView} />
          <AccountGroup label="Tracking" accounts={tracking} total={total} balOf={balOf} households={households} currency={currency} view={view} setView={setView} />
        </DndContext>
      </ScrollArea>

      <Stack gap={0} px="sm" py="xs" style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
        <Button variant="subtle" color="gray" size="xs" fullWidth justify="flex-start" leftSection={<IconFileImport size={15} />} onClick={importModal.open}>
          Import…
        </Button>
        <Button variant="subtle" color="gray" size="xs" fullWidth justify="flex-start" leftSection={<IconArrowsExchange size={15} />} onClick={linkModal.open}>
          Link transfers…
        </Button>
        <Button variant="subtle" color="gray" size="xs" fullWidth justify="flex-start" leftSection={<IconCloud size={15} />} onClick={fileModal.open}>
          Budget file…
        </Button>
      </Stack>

      <AddAccountModal opened={addOpen} onClose={addModal.close} />
      <ManageAccountsModal opened={manageOpen} onClose={manageModal.close} />
      <BudgetFileModal opened={fileOpen} onClose={fileModal.close} />
      <ImportWizard opened={importOpen} onClose={importModal.close} />
      <LinkTransfersModal opened={linkOpen} onClose={linkModal.close} />
    </Stack>
  );
}

function AccountGroup({
  label, accounts, total, balOf, households, currency, view, setView,
}: {
  label: string;
  accounts: Account[];
  total: (a: Account[]) => number;
  balOf: (id: Ulid) => number;
  households: string[];
  currency: ReturnType<typeof useApp>["currency"];
  view: ReturnType<typeof useApp>["view"];
  setView: ReturnType<typeof useApp>["setView"];
}) {
  if (accounts.length === 0) return null;
  return (
    <>
      <GroupLabel label={label} total={money(total(accounts), currency)} color={amountColor(total(accounts))} />
      <SortableContext items={accounts.map((a) => a.id)} strategy={verticalListSortingStrategy}>
        {accounts.map((a) => (
          <AccountRow
            key={a.id}
            a={a}
            households={households}
            balance={balOf(a.id)}
            currency={currency}
            active={view.kind === "account" && view.accountId === a.id}
            onSelect={() => setView({ kind: "account", accountId: a.id })}
          />
        ))}
      </SortableContext>
    </>
  );
}

function AccountRow({
  a, households, balance, currency, active, onSelect,
}: {
  a: Account;
  households: string[];
  balance: number;
  currency: ReturnType<typeof useApp>["currency"];
  active: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: a.id });
  const Icon = accountIcon(a);
  const color = a.household ? householdColor(a.household, households) : "gray";
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }} {...attributes} {...listeners}>
      <NavLink
        active={active}
        label={a.name}
        description={a.household}
        leftSection={
          <Tooltip label={a.household ?? "No household"} openDelay={400} withArrow>
            <ThemeIcon size={26} radius="sm" variant="light" color={color}><Icon size={15} /></ThemeIcon>
          </Tooltip>
        }
        rightSection={<Text size="xs" c={amountColor(balance)} fw={500}>{money(balance, currency)}</Text>}
        onClick={onSelect}
      />
    </div>
  );
}

function GroupLabel({ label, total, color }: { label: string; total: string; color?: string }) {
  return (
    <Group justify="space-between" px="sm" mt="sm" mb={2}>
      <Text size="xs" c="dimmed" fw={600}>{label}</Text>
      <Badge size="xs" variant="light" color={color === "red" ? "red" : "gray"}>{total}</Badge>
    </Group>
  );
}
