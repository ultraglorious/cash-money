import { useEffect, useState } from "react";
import { Text, TextInput, type MantineSize } from "@mantine/core";

/** Text that becomes an inline TextInput on double-click; commits on Enter/blur. */
export function InlineEditableText({
  value,
  onSubmit,
  size = "sm",
  fw,
  c,
}: {
  value: string;
  onSubmit: (next: string) => void;
  size?: MantineSize;
  fw?: number;
  c?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (editing) setDraft(value);
  }, [editing, value]);

  const commit = () => {
    const t = draft.trim();
    if (t && t !== value) onSubmit(t);
    setEditing(false);
  };

  if (editing) {
    return (
      <TextInput
        size="xs"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        styles={{ input: { fontWeight: fw, height: 28, minHeight: 28 } }}
      />
    );
  }
  return (
    <Text
      size={size}
      fw={fw}
      c={c}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      style={{ cursor: "text" }}
      title="Double-click to rename"
    >
      {value}
    </Text>
  );
}
