import { Component, type ReactNode } from "react";
import { Alert, Button, Center, Stack, Text } from "@mantine/core";

/**
 * Last-resort guard: a throwing render or reducer must not white-screen the
 * app. Data on disk is safe (saves are serialized and the reducer is pure), so
 * the honest recovery is a reload.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <Center h="100vh" p="xl">
        <Alert color="red" title="Something went wrong" maw={560}>
          <Stack gap="sm">
            <Text size="sm">
              The app hit an unexpected error. Your data on disk is unaffected — reload to continue.
            </Text>
            <Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>
              {String(this.state.error)}
            </Text>
            <Button size="xs" variant="light" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </Stack>
        </Alert>
      </Center>
    );
  }
}
