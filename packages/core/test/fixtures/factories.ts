import type { Cents } from "../../src/money.js";
import { EUR } from "../../src/money.js";
import type { Ulid } from "../../src/ids.js";
import type { ISODate } from "../../src/time.js";
import { monthKeyOf } from "../../src/time.js";
import { SCHEMA_VERSION } from "../../src/model/types.js";
import type {
  Account,
  Budget,
  Category,
  CategoryGroup,
  MonthlyAssignment,
  Transaction,
} from "../../src/model/types.js";

/**
 * Deterministic, clearly-synthetic fixtures for tests. All identifiers are fake
 * (never real names/accounts). Ids are stable ULID-shaped strings so tests can
 * assert byte-stable serialization.
 */

/** A valid-ULID-shaped deterministic id from a short suffix. */
export function tid(suffix: string): Ulid {
  const s = suffix.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, "0");
  return ("0".repeat(Math.max(0, 26 - s.length)) + s).slice(-26) as Ulid;
}

export function budget(overrides: Partial<Budget> = {}): Budget {
  return {
    id: tid("BUD1"),
    name: "Test Budget",
    currency: EUR,
    createdAt: "2026-01-01",
    schemaVersion: SCHEMA_VERSION,
    ...overrides,
  };
}

export function account(overrides: Partial<Account> = {}): Account {
  return {
    id: tid("ACC1"),
    name: "Checking",
    type: "checking",
    onBudget: true,
    closed: false,
    sortOrder: 0,
    ...overrides,
  };
}

export function group(overrides: Partial<CategoryGroup> = {}): CategoryGroup {
  return {
    id: tid("GRP1"),
    name: "Everyday",
    kind: "normal",
    sortOrder: 0,
    hidden: false,
    ...overrides,
  };
}

export function category(overrides: Partial<Category> = {}): Category {
  return {
    id: tid("CAT1"),
    groupId: tid("GRP1"),
    name: "Groceries",
    sortOrder: 0,
    hidden: false,
    ...overrides,
  };
}

export function assignment(overrides: Partial<MonthlyAssignment> = {}): MonthlyAssignment {
  return {
    id: tid("ASG1"),
    month: "2026-01",
    categoryId: tid("CAT1"),
    assigned: 50000 as Cents,
    ...overrides,
  };
}

export function txn(overrides: Partial<Transaction> = {}): Transaction {
  const date: ISODate = overrides.date ?? "2026-01-15";
  return {
    id: tid("TXN1"),
    accountId: tid("ACC1"),
    date,
    effectiveDate: overrides.effectiveDate ?? date,
    payee: "Shop",
    memo: "",
    amount: -1234 as Cents,
    cleared: "cleared",
    approved: true,
    categoryId: tid("CAT1"),
    ...overrides,
  };
}

export { monthKeyOf };
