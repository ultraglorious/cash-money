import {
  EUR,
  newId,
  SCHEMA_VERSION,
  type Account,
  type Category,
  type CategoryGroup,
  type LoadedBudget,
} from "@cash-money/core";

/** A minimal, valid starter budget for a fresh install (before any import). */
export function newEmptyBudget(): LoadedBudget {
  const inflow: CategoryGroup = { id: newId(), name: "Inflow", kind: "income", sortOrder: 0, hidden: false };
  const everyday: CategoryGroup = { id: newId(), name: "Everyday Expenses", kind: "normal", sortOrder: 1, hidden: false };
  const rta: Category = { id: newId(), groupId: inflow.id, name: "Ready to Assign", sortOrder: 0, hidden: false };
  const checking: Account = { id: newId(), name: "Checking", type: "checking", onBudget: true, closed: false, sortOrder: 0 };

  return {
    budget: {
      id: newId(),
      name: "My Budget",
      currency: EUR,
      createdAt: new Date().toISOString().slice(0, 10),
      schemaVersion: SCHEMA_VERSION,
    },
    accounts: [checking],
    groups: [inflow, everyday],
    categories: [rta],
    assignments: [],
    transactions: [],
  };
}
