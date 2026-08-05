import { useEffect, useState } from "react";
import { Button, Group, Modal, Stack, TextInput } from "@mantine/core";

/** Small modal that collects a single name — used for new sections and categories. */
export function NameModal({
  opened,
  onClose,
  title,
  label,
  placeholder,
  initialName = "",
  submitLabel = "Add",
  onSubmit,
}: {
  opened: boolean;
  onClose: () => void;
  title: string;
  label: string;
  placeholder?: string;
  initialName?: string;
  submitLabel?: string;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  useEffect(() => {
    if (opened) setName(initialName);
  }, [opened, initialName]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    onClose();
  };

  return (
    <Modal opened={opened} onClose={onClose} title={title} centered>
      <Stack>
        <TextInput
          data-autofocus
          label={label}
          placeholder={placeholder}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim()}>
            {submitLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
