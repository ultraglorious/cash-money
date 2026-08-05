import { useEffect, useState } from "react";
import { Button, Group, Modal, NumberInput, Select, Stack, Text } from "@mantine/core";
import type { Cents, Ulid } from "@cash-money/core";
import { useApp } from "../state";
import { money } from "../format";

/** Reallocate assigned money from one category to another in the current month. */
export function MoveMoneyModal({
  opened,
  onClose,
  fromCategoryId,
}: {
  opened: boolean;
  onClose: () => void;
  fromCategoryId?: Ulid;
}) {
  const { budget, month, currency, moveMoney, projection, categoryName } = useApp();
  const [from, setFrom] = useState<string | null>(fromCategoryId ?? null);
  const [to, setTo] = useState<string | null>(null);
  const [amount, setAmount] = useState<number | string>("");

  useEffect(() => {
    if (opened) {
      setFrom(fromCategoryId ?? null);
      setTo(null);
      setAmount("");
    }
  }, [opened, fromCategoryId]);

  const options = budget.groups
    .filter((g) => g.kind !== "income")
    .map((g) => ({
      group: g.name,
      items: budget.categories.filter((c) => c.groupId === g.id).map((c) => ({ value: c.id, label: c.name })),
    }))
    .filter((grp) => grp.items.length > 0);

  const fromAvailable = from ? projection.availableOf(from as Ulid, month) : 0;
  const valid = from && to && from !== to && amount !== "" && Number(amount) > 0;

  const submit = () => {
    if (!valid || !from || !to) return;
    moveMoney(month, from as Ulid, to as Ulid, Math.round(Number(amount) * 100) as Cents);
    onClose();
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Move money" centered>
      <Stack>
        <Select label="From" data={options} value={from} onChange={setFrom} searchable />
        {from ? (
          <Text size="xs" c="dimmed">
            {categoryName(from as Ulid)} has {money(fromAvailable, currency)} available
          </Text>
        ) : null}
        <Select label="To" data={options} value={to} onChange={setTo} searchable />
        <NumberInput
          label="Amount"
          prefix="€"
          decimalScale={2}
          fixedDecimalScale
          min={0}
          value={amount}
          onChange={setAmount}
          thousandSeparator=","
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid}>
            Move
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
