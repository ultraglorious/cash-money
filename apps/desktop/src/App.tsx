import { AppShell } from "@mantine/core";
import { useApp } from "./state";
import { Sidebar } from "./components/Sidebar";
import { PlansView } from "./features/plans/PlansView";
import { TransactionsView } from "./features/transactions/TransactionsView";
import { AnalyticsView } from "./features/analytics/AnalyticsView";

export function App() {
  const { view } = useApp();

  return (
    <AppShell navbar={{ width: 280, breakpoint: 0 }} padding="lg">
      <AppShell.Navbar>
        <Sidebar />
      </AppShell.Navbar>
      <AppShell.Main>
        {view.kind === "plan" && <PlansView />}
        {view.kind === "analytics" && <AnalyticsView />}
        {(view.kind === "account" || view.kind === "all-accounts") && <TransactionsView />}
      </AppShell.Main>
    </AppShell>
  );
}
