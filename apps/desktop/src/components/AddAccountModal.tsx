import { useEffect, useState } from "react";
import { Autocomplete, Button, Group, Modal, Select, Stack, TextInput } from "@mantine/core";
import type { AccountType } from "@cash-money/core";
import { useApp } from "../state";

const TYPES: { value: AccountType; label: string }[] = [
  { value: "checking", label: "Checking / Cash" },
  { value: "creditCard", label: "Credit card" },
  { value: "tracking", label: "Tracking (off-budget)" },
];

export function AddAccountModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { budget, addAccount } = useApp();
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("checking");
  const [household, setHousehold] = useState("");

  useEffect(() => {
    if (opened) {
      setName("");
      setType("checking");
      setHousehold("");
    }
  }, [opened]);

  const households = [...new Set(budget.accounts.map((a) => a.household).filter((h): h is string => !!h))];
  const valid = name.trim().length > 0;

  const submit = () => {
    if (!valid) return;
    addAccount({ name: name.trim(), type, household: household.trim() || undefined });
    onClose();
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Add account" centered>
      <Stack>
        <TextInput data-autofocus label="Account name" placeholder="e.g. Savings" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <Select label="Type" data={TYPES} value={type} onChange={(v) => v && setType(v as AccountType)} allowDeselect={false} />
        <Autocomplete
          label="Household"
          placeholder="e.g. Personal"
          description="Groups accounts for the Plan split (leave blank for none)"
          data={households}
          value={household}
          onChange={setHousehold}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid}>
            Add account
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
