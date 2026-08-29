import { useEffect, useState } from "react";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Chip,
  Collapse,
  Group,
  Menu,
  NumberInput,
  Paper,
  Popover,
  Stack,
  Switch,
  Table,
  Text,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { MonthPicker } from "@mantine/dates";
import { useDisclosure } from "@mantine/hooks";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  IconArrowsExchange,
  IconCalendarEvent,
  IconChevronLeft,
  IconChevronRight,
  IconDots,
  IconEye,
  IconEyeOff,
  IconGripVertical,
  IconHeartHandshake,
  IconLayoutList,
  IconPlus,
  IconSortAZ,
  IconSortDescendingNumbers,
  IconTrash,
  IconWand,
} from "@tabler/icons-react";
import { assignSuggestions, type AssignSuggestion, type AssignSuggestionKey, type CategoryMonthView, type GroupMonthView, type Ulid } from "@cash-money/core";
import type { Cents } from "@cash-money/core";
import { useApp } from "../../state";
import { currentMonthClamped, dateToMonthKey, money, monthLabel, monthToDate } from "../../format";
import { amountColor, householdColor } from "../../theme";
import { NameModal } from "../../components/NameModal";
import { MoveMoneyModal } from "../../components/MoveMoneyModal";
import { InlineEditableText } from "../../components/InlineEditableText";

interface NameModalConfig {
  title: string;
  label: string;
  placeholder?: string;
  initial?: string;
  submitLabel?: string;
  onSubmit: (name: string) => void;
}
interface CoverCandidate {
  categoryId: Ulid;
  name: string;
  available: number;
}

const byOrder = (a: { sortOrder: number }, b: { sortOrder: number }) => a.sortOrder - b.sortOrder;

/** Only let a drag collide with drop targets of a compatible type. */
const typedCollision: CollisionDetection = (args) => {
  const type = args.active.data.current?.type;
  const containers = args.droppableContainers.filter((c) => {
    const t = c.data.current?.type;
    if (type === "household") return t === "household";
    if (type === "section") return t === "section";
    return t === "category" || t === "section"; // categories drop onto categories or a section
  });
  return closestCenter({ ...args, droppableContainers: containers });
};

export function PlansView() {
  const app = useApp();
  const { projection, months, month, setMonth, currency } = app;
  const view = projection.monthView(month);
  const rtaTotal = projection.readyToAssignOf(month);
  const rtaByHh = projection.readyToAssignByHousehold(month);
  const households = projection.households;

  const [showHidden, setShowHidden] = useState(false);
  const [hiddenHh, setHiddenHh] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [nameModal, setNameModal] = useState<NameModalConfig | null>(null);
  const [moveOpen, moveCtrl] = useDisclosure(false);
  const [moveFrom, setMoveFrom] = useState<Ulid | undefined>(undefined);
  const [pickerOpen, picker] = useDisclosure(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const type = e.active.data.current?.type;
    const overId = e.over?.id;
    if (!overId) return;

    if (type === "household") {
      const from = households.indexOf(e.active.id as string);
      const to = households.indexOf(overId as string);
      if (from < 0 || to < 0 || from === to) return;
      app.setHouseholdOrder(arrayMove([...households], from, to));
      return;
    }

    if (type === "section") {
      const groupId = e.active.id as Ulid;
      const overGroupId = overId as Ulid;
      if (groupId === overGroupId) return;
      const g = app.budget.groups.find((x) => x.id === groupId);
      const og = app.budget.groups.find((x) => x.id === overGroupId);
      if (!g || !og || g.household !== og.household) return; // reorder within a household
      const sections = app.budget.groups.filter((x) => x.household === g.household && x.kind !== "income").sort(byOrder).map((x) => x.id);
      const from = sections.indexOf(groupId);
      const to = sections.indexOf(overGroupId);
      if (from < 0 || to < 0) return;
      app.setGroupOrder(arrayMove(sections, from, to));
      return;
    }

    const catId = e.active.id as Ulid;
    const over = overId as Ulid;
    if (over === catId) return;
    const cats = app.budget.categories;
    const isGroup = app.budget.groups.some((g) => g.id === over);
    const toGroupId = isGroup ? over : cats.find((c) => c.id === over)?.groupId;
    if (!toGroupId) return;
    const siblings = cats.filter((c) => c.groupId === toGroupId && c.id !== catId).sort(byOrder);
    const targetIndex = isGroup ? siblings.length : Math.max(0, siblings.findIndex((c) => c.id === over));
    app.reorderCategory(catId, toGroupId, targetIndex < 0 ? siblings.length : targetIndex);
  };

  const idx = months.indexOf(month);
  const openMove = (from?: Ulid) => {
    setMoveFrom(from);
    moveCtrl.open();
  };
  const toggle = (key: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const groupsByHh = new Map<string, GroupMonthView[]>();
  for (const g of view.groups) {
    const h = g.group.household ?? "General";
    (groupsByHh.get(h) ?? groupsByHh.set(h, []).get(h)!).push(g);
  }
  const visible = households.filter((h) => groupsByHh.has(h) && !hiddenHh.includes(h));

  const allKeys = [
    ...visible.map((h) => "H:" + h),
    ...visible.flatMap((h) => groupsByHh.get(h)!.map((g) => "S:" + g.group.id)),
  ];
  const anythingExpanded = allKeys.some((k) => !collapsed.has(k));
  const toggleAll = () => setCollapsed(anythingExpanded ? new Set(allKeys) : new Set());

  return (
    <Stack gap="lg">
      <Paper radius="lg" p="lg" style={{ background: "linear-gradient(135deg, var(--mantine-color-indigo-6), var(--mantine-color-violet-6))", color: "white" }}>
        <Group justify="space-between" align="center" wrap="nowrap">
          <Group gap="xs">
            <ActionIcon variant="white" color="dark" radius="xl" onClick={() => idx > 0 && setMonth(months[idx - 1]!)} disabled={idx <= 0} aria-label="Previous month">
              <IconChevronLeft size={18} />
            </ActionIcon>
            <Popover opened={pickerOpen} onChange={(o) => !o && picker.close()} position="bottom-start" withArrow shadow="md">
              <Popover.Target>
                <UnstyledButton onClick={picker.toggle} aria-label="Pick month">
                  <Title order={3} style={{ minWidth: 130, textAlign: "center", color: "white" }}>{monthLabel(month)}</Title>
                </UnstyledButton>
              </Popover.Target>
              <Popover.Dropdown>
                <MonthPicker
                  value={monthToDate(month)}
                  minDate={months.length ? monthToDate(months[0]!) : undefined}
                  maxDate={months.length ? monthToDate(months[months.length - 1]!) : undefined}
                  onChange={(d) => { if (d) setMonth(dateToMonthKey(d)); picker.close(); }}
                />
              </Popover.Dropdown>
            </Popover>
            <ActionIcon variant="white" color="dark" radius="xl" onClick={() => idx < months.length - 1 && setMonth(months[idx + 1]!)} disabled={idx >= months.length - 1} aria-label="Next month">
              <IconChevronRight size={18} />
            </ActionIcon>
            <Tooltip label="Jump to current month" withArrow>
              <ActionIcon variant="subtle" color="white" radius="xl" onClick={() => setMonth(currentMonthClamped(months))} aria-label="Current month">
                <IconCalendarEvent size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
          <Stack gap={0} align="flex-end">
            <Text size="xs" tt="uppercase" fw={700} style={{ opacity: 0.85 }}>Ready to Assign</Text>
            <Tooltip
              disabled={households.length < 2}
              withArrow
              multiline
              label={
                <Stack gap={2}>
                  {households.map((h) => (
                    <Group key={h} gap="lg" justify="space-between" wrap="nowrap">
                      <Text size="xs">{h}</Text>
                      <Text size="xs" fw={700}>{money(rtaByHh.get(h) ?? 0, currency)}</Text>
                    </Group>
                  ))}
                </Stack>
              }
            >
              <Title order={1} style={{ lineHeight: 1, cursor: households.length > 1 ? "help" : "default" }}>{money(rtaTotal, currency)}</Title>
            </Tooltip>
          </Stack>
        </Group>
      </Paper>

      <Group justify="space-between">
        <Group>
          {households.length > 1 && (
            <Chip.Group multiple value={households.filter((h) => !hiddenHh.includes(h))} onChange={(v) => setHiddenHh(households.filter((h) => !v.includes(h)))}>
              <Group gap="xs">
                {households.map((h) => (
                  <Chip key={h} value={h} size="sm" variant="light" color={householdColor(h, households)}>{h}</Chip>
                ))}
              </Group>
            </Chip.Group>
          )}
        </Group>
        <Group>
          <Button variant="subtle" size="sm" leftSection={<IconLayoutList size={16} />} onClick={toggleAll}>
            {anythingExpanded ? "Collapse all" : "Expand all"}
          </Button>
          <Switch label="Show hidden" size="sm" checked={showHidden} onChange={(e) => setShowHidden(e.currentTarget.checked)} />
          <Button leftSection={<IconArrowsExchange size={16} />} variant="default" onClick={() => openMove(undefined)}>Move money</Button>
        </Group>
      </Group>

      <DndContext sensors={sensors} collisionDetection={typedCollision} onDragStart={(e) => setDragging(e.active.id as string)} onDragEnd={handleDragEnd}>
        <SortableContext items={visible} strategy={verticalListSortingStrategy}>
          <Stack gap="lg">
            {visible.map((h) => (
              <HouseholdPanel
                key={h}
                household={h}
                households={households}
                rta={rtaByHh.get(h) ?? 0}
                groups={groupsByHh.get(h)!}
                showHidden={showHidden}
                collapsed={collapsed}
                onToggle={toggle}
                openName={setNameModal}
                openMove={openMove}
              />
            ))}
          </Stack>
        </SortableContext>
        <DragOverlay>
          {dragging ? (
            <Badge variant="filled" color="indigo" size="lg">
              {households.includes(dragging)
                ? dragging
                : app.budget.groups.find((g) => g.id === dragging)?.name ?? app.categoryName(dragging as Ulid)}
            </Badge>
          ) : null}
        </DragOverlay>
      </DndContext>

      <NameModal
        opened={!!nameModal}
        onClose={() => setNameModal(null)}
        title={nameModal?.title ?? ""}
        label={nameModal?.label ?? ""}
        placeholder={nameModal?.placeholder}
        initialName={nameModal?.initial ?? ""}
        submitLabel={nameModal?.submitLabel ?? "Add"}
        onSubmit={(name) => nameModal?.onSubmit(name)}
      />
      <MoveMoneyModal opened={moveOpen} onClose={moveCtrl.close} fromCategoryId={moveFrom} />
    </Stack>
  );
}

function HouseholdPanel({
  household, households, rta, groups, showHidden, collapsed, onToggle, openName, openMove,
}: {
  household: string;
  households: string[];
  rta: number;
  groups: GroupMonthView[];
  showHidden: boolean;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  openName: (c: NameModalConfig) => void;
  openMove: (from?: Ulid) => void;
}) {
  const app = useApp();
  const color = householdColor(household, households);
  const key = "H:" + household;
  const isCollapsed = collapsed.has(key);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: household,
    data: { type: "household" },
  });

  const candidates: CoverCandidate[] = groups
    .flatMap((g) => g.categories)
    .filter((c) => c.available > 0)
    .map((c) => ({ categoryId: c.categoryId, name: app.categoryName(c.categoryId), available: c.available }));

  return (
    <Box
      ref={setNodeRef}
      style={{
        borderLeft: `4px solid var(--mantine-color-${color}-6)`,
        background: `var(--mantine-color-${color}-light)`,
        borderRadius: 12,
        padding: 12,
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
    >
      <Group justify="space-between" align="center" mb={isCollapsed ? 0 : "sm"}>
        <Group gap="xs">
          <ActionIcon ref={setActivatorNodeRef} {...attributes} {...listeners} variant="subtle" color={color} size="sm" style={{ cursor: "grab" }} aria-label="Drag household">
            <IconGripVertical size={16} />
          </ActionIcon>
          <ActionIcon variant="subtle" color={color} onClick={() => onToggle(key)} aria-label="Toggle household">
            {isCollapsed ? <IconChevronRight size={18} /> : <IconChevronRight size={18} style={{ transform: "rotate(90deg)" }} />}
          </ActionIcon>
          <Title order={4} c={`${color}.8`}>{household}</Title>
          <Badge size="xl" variant={rta < 0 ? "filled" : "light"} color={rta < 0 ? "red" : rta > 0 ? "teal" : "gray"} style={{ textTransform: "none" }}>
            {money(rta, app.currency)} to assign
          </Badge>
        </Group>
        <Button size="xs" variant="light" color={color} leftSection={<IconPlus size={14} />} onClick={() => openName({ title: `Add section to ${household}`, label: "Section name", placeholder: "e.g. Everyday Expenses", onSubmit: (name) => app.addGroup(name, household) })}>
          Add section
        </Button>
      </Group>
      <Collapse in={!isCollapsed}>
        <SortableContext items={groups.map((g) => g.group.id)} strategy={verticalListSortingStrategy}>
          <Stack gap="sm">
            {groups.map((g) => (
              <SectionCard key={g.group.id} g={g} candidates={candidates} showHidden={showHidden} collapsed={collapsed} onToggle={onToggle} openName={openName} openMove={openMove} />
            ))}
          </Stack>
        </SortableContext>
      </Collapse>
    </Box>
  );
}

function SectionCard({
  g, candidates, showHidden, collapsed, onToggle, openName, openMove,
}: {
  g: GroupMonthView;
  candidates: CoverCandidate[];
  showHidden: boolean;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  openName: (c: NameModalConfig) => void;
  openMove: (from?: Ulid) => void;
}) {
  const app = useApp();
  const { budget, currency } = app;
  const key = "S:" + g.group.id;
  const isCollapsed = collapsed.has(key);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: g.group.id,
    data: { type: "section" },
  });

  const visibleCats = g.categories.filter((c) => showHidden || !budget.categories.find((x) => x.id === c.categoryId)?.hidden);
  const catIds = visibleCats.map((c) => c.categoryId);

  const sortByAssigned = () =>
    app.setCategoryOrder(g.group.id, [...g.categories].sort((a, b) => b.assigned - a.assigned).map((c) => c.categoryId));
  const sortAlpha = () =>
    app.setCategoryOrder(g.group.id, [...g.categories].sort((a, b) => app.categoryName(a.categoryId).localeCompare(app.categoryName(b.categoryId))).map((c) => c.categoryId));

  return (
    <Paper
      ref={setNodeRef}
      withBorder radius="md" p="md" shadow="xs"
      opacity={isDragging ? 0.5 : g.group.hidden ? 0.7 : 1}
      style={{ background: "light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))", transform: CSS.Transform.toString(transform), transition }}
    >
      <Group justify="space-between" mb={isCollapsed ? 0 : "xs"}>
        <Group gap={4}>
          <ActionIcon ref={setActivatorNodeRef} {...attributes} {...listeners} variant="subtle" color="gray" size="sm" style={{ cursor: "grab" }} aria-label="Drag section">
            <IconGripVertical size={15} />
          </ActionIcon>
          <ActionIcon variant="subtle" color="gray" onClick={() => onToggle(key)} aria-label="Toggle section">
            {isCollapsed ? <IconChevronRight size={16} /> : <IconChevronRight size={16} style={{ transform: "rotate(90deg)" }} />}
          </ActionIcon>
          <InlineEditableText value={g.group.name} onSubmit={(name) => app.renameGroup(g.group.id, name)} fw={700} size="md" />
          {g.group.hidden ? <Badge size="sm" variant="light" color="gray">hidden</Badge> : null}
        </Group>
        <Group gap="sm">
          <Text size="sm" c={amountColor(g.available)} fw={600}>{money(g.available, currency)}</Text>
          <ActionIcon variant="subtle" aria-label="Add category" onClick={() => openName({ title: "Add category", label: "Category name", placeholder: "e.g. Groceries", onSubmit: (name) => app.addCategory(g.group.id, name) })}>
            <IconPlus size={16} />
          </ActionIcon>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target><ActionIcon variant="subtle" color="gray" aria-label="Section actions"><IconDots size={16} /></ActionIcon></Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconSortDescendingNumbers size={14} />} onClick={sortByAssigned}>Sort by assigned</Menu.Item>
              <Menu.Item leftSection={<IconSortAZ size={14} />} onClick={sortAlpha}>Sort A–Z</Menu.Item>
              <Menu.Divider />
              <Menu.Item leftSection={g.group.hidden ? <IconEye size={14} /> : <IconEyeOff size={14} />} onClick={() => app.setGroupHidden(g.group.id, !g.group.hidden)}>{g.group.hidden ? "Show" : "Hide"}</Menu.Item>
              <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => app.deleteGroup(g.group.id)}>Delete section</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>
      <Collapse in={!isCollapsed}>
        <Table verticalSpacing="xs" highlightOnHover layout="fixed">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Category</Table.Th>
              <Table.Th w={150} ta="right">Assigned</Table.Th>
              <Table.Th w={120} ta="right">Activity</Table.Th>
              <Table.Th w={130} ta="right">Available</Table.Th>
              <Table.Th w={40} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            <SortableContext items={catIds} strategy={verticalListSortingStrategy}>
              {visibleCats.map((c) => (
                <CategoryRow key={c.categoryId} c={c} group={g} candidates={candidates} openMove={openMove} />
              ))}
            </SortableContext>
            {g.categories.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={5}>
                  <Text size="sm" c="dimmed" ta="center" py="xs">No categories yet — use the + to add one.</Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Collapse>
    </Paper>
  );
}

function CategoryRow({
  c, group, candidates, openMove,
}: {
  c: CategoryMonthView;
  group: GroupMonthView;
  candidates: CoverCandidate[];
  openMove: (from?: Ulid) => void;
}) {
  const app = useApp();
  const { budget, categoryName } = app;
  const cat = budget.categories.find((x) => x.id === c.categoryId);
  const normalGroups = budget.groups.filter((x) => x.kind === "normal" && x.household === group.group.household);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: c.categoryId, data: { type: "category" } });

  return (
    <Table.Tr ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}>
      <Table.Td>
        <Group gap={4} wrap="nowrap">
          <ActionIcon ref={setActivatorNodeRef} {...attributes} {...listeners} variant="subtle" color="gray" size="sm" style={{ cursor: "grab" }} aria-label="Drag category">
            <IconGripVertical size={14} />
          </ActionIcon>
          <InlineEditableText value={categoryName(c.categoryId)} onSubmit={(name) => app.renameCategory(c.categoryId, name)} />
          {cat?.hidden ? <Badge size="xs" color="gray" variant="light">hidden</Badge> : null}
        </Group>
      </Table.Td>
      <Table.Td>
        <AssignedCell categoryId={c.categoryId} value={c.assigned} />
      </Table.Td>
      <Table.Td ta="right"><Text size="sm" c="dimmed">{money(c.activity, app.currency)}</Text></Table.Td>
      <Table.Td ta="right"><AvailableCell categoryId={c.categoryId} available={c.available} candidates={candidates} /></Table.Td>
      <Table.Td>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target><ActionIcon variant="subtle" color="gray" aria-label="Category actions"><IconDots size={16} /></ActionIcon></Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<IconArrowsExchange size={14} />} onClick={() => openMove(c.categoryId)}>Move money…</Menu.Item>
            <Menu.Item leftSection={cat?.hidden ? <IconEye size={14} /> : <IconEyeOff size={14} />} onClick={() => app.setCategoryHidden(c.categoryId, !cat?.hidden)}>{cat?.hidden ? "Show" : "Hide"}</Menu.Item>
            {normalGroups.length > 1 && (
              <>
                <Menu.Divider />
                <Menu.Label>Move to section</Menu.Label>
                {normalGroups.filter((ng) => ng.id !== cat?.groupId).map((ng) => (
                  <Menu.Item key={ng.id} onClick={() => app.moveCategory(c.categoryId, ng.id)}>{ng.name}</Menu.Item>
                ))}
              </>
            )}
            <Menu.Divider />
            <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => app.deleteCategory(c.categoryId)}>Delete</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Table.Td>
    </Table.Tr>
  );
}

function AvailableCell({ categoryId, available, candidates }: { categoryId: Ulid; available: number; candidates: CoverCandidate[] }) {
  const app = useApp();
  if (available >= 0) return <Badge variant="light" color={available > 0 ? "teal" : "gray"}>{money(available, app.currency)}</Badge>;
  const shortfall = -available;
  const options = candidates.filter((c) => c.categoryId !== categoryId);
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <UnstyledButton aria-label="Cover shortfall">
          <Badge variant="filled" color="red" style={{ cursor: "pointer" }} rightSection={<IconHeartHandshake size={12} />}>{money(available, app.currency)}</Badge>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Cover {money(shortfall, app.currency)} from…</Menu.Label>
        {options.length === 0 && <Menu.Item disabled>No category has money to spare</Menu.Item>}
        {options.map((c) => (
          <Menu.Item key={c.categoryId} onClick={() => app.coverShortfall(app.month, c.categoryId, categoryId)} rightSection={<Text size="xs" c="dimmed">{money(c.available, app.currency)}</Text>}>{c.name}</Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

const SUGGESTION_LABEL: Record<AssignSuggestionKey, (s: AssignSuggestion) => string> = {
  lastMonth: () => "Assigned last month",
  spentLastMonth: () => "Spent last month",
  averageAssigned: (s) => `Average assigned (${s.months} months)`,
  averageSpent: (s) => `Average spent (${s.months} months)`,
  lastFunded: (s) => `Last funded, ${monthLabel(s.month!)}`,
  typicalWhenFunded: (s) => `Typical when funded (${s.months} times)`,
  spentLastTime: (s) => `Spent last time, ${monthLabel(s.month!)}`,
  resetAssigned: () => "Reset assigned",
  resetAvailable: () => "Reset available",
};

/** The resets read as amounts on their own; say what they'll do instead. */
const SUGGESTION_HINT: Partial<Record<AssignSuggestionKey, string>> = {
  resetAssigned: "take back what you assigned this month",
  resetAvailable: "empty the envelope, to zero",
};

function AssignedCell({ categoryId, value }: { categoryId: Ulid; value: number }) {
  const { month, setAssigned, currency, projection } = useApp();
  const suggestions = assignSuggestions(projection, categoryId, month);
  // Edits live in a local draft and commit on blur/Enter — dispatching per
  // keystroke would recompute the whole projection (and persist intermediate
  // values like the "1" of "1250") on every keypress.
  const [draft, setDraft] = useState<number | string>(value / 100);
  useEffect(() => setDraft(value / 100), [value]);
  const commit = () => {
    const cents = Math.round(Number(draft || 0) * 100) as Cents;
    if (cents !== value) setAssigned(month, categoryId, cents);
  };
  return (
    <Group gap={2} wrap="nowrap">
      <NumberInput
        size="xs" variant="filled" prefix={currency.symbol} decimalScale={2} fixedDecimalScale hideControls thousandSeparator=","
        styles={{ input: { textAlign: "right" } }}
        style={{ flex: 1 }}
        value={draft}
        onChange={setDraft}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
      />
      {suggestions.length > 0 && (
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <Tooltip label="Fill from what you already did" withArrow openDelay={400}>
              <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Quick assign">
                <IconWand size={14} />
              </ActionIcon>
            </Tooltip>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Quick assign</Menu.Label>
            {suggestions.map((s) => (
              <Menu.Item
                key={s.key}
                rightSection={<Text size="xs" c="dimmed" ml="md">{money(s.amount, currency)}</Text>}
                onClick={() => { setDraft(s.amount / 100); if (s.amount !== value) setAssigned(month, categoryId, s.amount); }}
              >
                {SUGGESTION_LABEL[s.key](s)}
                {SUGGESTION_HINT[s.key] && <Text size="xs" c="dimmed">{SUGGESTION_HINT[s.key]}</Text>}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      )}
    </Group>
  );
}
