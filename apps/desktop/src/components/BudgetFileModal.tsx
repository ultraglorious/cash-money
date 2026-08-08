import { useState } from "react";
import { Alert, Button, Code, Group, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconCheck, IconFolderOpen, IconFolderShare } from "@tabler/icons-react";
import { useActions, useBudgetState } from "../state";
import { isTauri } from "../platform/tauriFs";

/**
 * Where the budget lives: one `.cashmoney` file the app follows. Move it into
 * a cloud-synced folder (iCloud Drive, Dropbox, …) to use the same budget on
 * another computer — one machine at a time; the app refuses to clobber a file
 * that changed underneath it.
 */
export function BudgetFileModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { budgetFilePath, budget } = useBudgetState();
  const { moveBudgetFile, openBudgetFile } = useActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const move = async () => {
    setError(null);
    const { save } = await import("@tauri-apps/plugin-dialog");
    const dest = await save({
      defaultPath: budgetFilePath ?? `${budget.budget.name}.cashmoney`,
      filters: [{ name: "Budget", extensions: ["cashmoney"] }],
    });
    if (!dest) return;
    const path = dest.toLowerCase().endsWith(".cashmoney") ? dest : `${dest}.cashmoney`;
    setBusy(true);
    try {
      await moveBudgetFile(path);
      notifications.show({
        title: "Budget file moved",
        message: `Now saving to ${path}`,
        color: "teal",
        icon: <IconCheck size={16} />,
      });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const openOther = async () => {
    setError(null);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ multiple: false, filters: [{ name: "Budget", extensions: ["cashmoney"] }] });
    if (!picked || Array.isArray(picked)) return;
    setBusy(true);
    try {
      await openBudgetFile(picked);
      notifications.show({
        title: "Budget opened",
        message: `Now following ${picked}`,
        color: "teal",
        icon: <IconCheck size={16} />,
      });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Budget file" centered>
      <Stack gap="sm">
        {!isTauri() && (
          <Alert color="yellow" icon={<IconAlertTriangle size={16} />}>
            The budget file only exists in the desktop app (this browser preview uses demo data).
          </Alert>
        )}
        <Text size="sm">Everything lives in this one file:</Text>
        <Code block style={{ wordBreak: "break-all" }}>{budgetFilePath ?? "— (browser preview)"}</Code>
        <Text size="xs" c="dimmed">
          Move it into iCloud Drive (or any synced folder) to use the same budget on another computer.
          Use it on one computer at a time — if the file changes underneath the app, saving pauses and
          asks before anything is overwritten. A <Code>.bak</Code> of the previous session is kept
          alongside it. “Move to…” starts following the new location; the old file stays where it was.
        </Text>
        {error && <Alert color="red" icon={<IconAlertTriangle size={16} />}>{error}</Alert>}
        <Group>
          <Button size="xs" variant="light" leftSection={<IconFolderShare size={15} />} onClick={() => void move()} disabled={!isTauri() || busy}>
            Move to…
          </Button>
          <Button size="xs" variant="default" leftSection={<IconFolderOpen size={15} />} onClick={() => void openOther()} disabled={!isTauri() || busy}>
            Switch to another budget file…
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
