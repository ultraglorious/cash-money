# Architecture

This explains how cash-money is built and *why*. It assumes you can program but
may not know TypeScript/React — unfamiliar terms are defined inline or in the
[README primer](../README.md#language--tooling-primer).

## The big picture: a pure core + a thin shell

```
        ┌─────────────────────────────────────────────┐
        │  apps/desktop  (React + Mantine, via Tauri)  │   the GUI you see
        │  renders state, dispatches "operations"      │
        └───────────────────────┬─────────────────────┘
                                 │ calls (function calls only)
        ┌───────────────────────▼─────────────────────┐
        │  packages/core  (plain TypeScript, no UI)     │   all the logic
        │  model · engine · import · ops · persistence  │
        └───────────────────────┬─────────────────────┘
                                 │ depends on interfaces ("ports"), not on the OS
                     ┌───────────▼───────────┐
                     │ FileSystemPort         │  disk (real app) or memory (tests)
                     └────────────────────────┘
```

**Why split it this way?**

- **Testability.** `packages/core` has no browser, no framework, no filesystem —
  so its ~100 tests run in about a second. The tricky money/merge logic is
  validated here, not through slow, flaky UI tests.
- **Portability.** The same core could power a different UI (web, mobile,
  command-line) with no changes. The UI is deliberately dumb.
- **Reasoning.** Money bugs are expensive. Keeping the math in small **pure
  functions** (same input → same output, no side effects) makes it auditable.

## The data model (`packages/core/src/model/types.ts`)

Everything is plain data (structs). In plain terms:

- **Budget** — the top-level container: a name, its currency, and the display
  order of households.
- **Account** — a place money lives (`checking`, `creditCard`, or off-budget
  `tracking` like investments). Carries an optional **household** label.
- **CategoryGroup** ("section") — a heading like "Everyday Expenses". Has a
  `kind` (`normal`, `income`, or `creditCardPayments`) and a household.
- **Category** — an envelope like "Groceries", belonging to a group.
- **MonthlyAssignment** — how much you budgeted to one category in one month.
  This is an *input* (a decision), so it's stored; everything else is derived.
- **Transaction** — one line in a register. Signed amount (inflow +, outflow −),
  a `date` and an `effectiveDate` (which month it counts toward — usually the
  same), `cleared` status, an `approved` flag (scheduled/future entries are
  unapproved until you approve them), and either a `categoryId`, a set of
  **splits** (across several categories), or a **transfer** link to another
  account.

Money is always an **integer number of minor units** (cents), never a
floating-point number — see `money.ts`. Floats can't represent `0.10 + 0.20`
exactly; integers can. All parsing goes through strings to avoid ever touching a
float.

## The envelope engine (`packages/core/src/engine/`)

`computeProjection(budget)` turns the stored data into everything the UI shows.
It's one pure function. The core recurrence, per category per month in order:

```
activity(c, m)  = Σ signed amounts of c's lines whose effectiveDate is in month m
available(c, m) = available(c, m−1) + assigned(c, m) + activity(c, m)
readyToAssign(m) = Σ income(≤m) − Σ assigned(≤m)      // income you haven't budgeted yet
```

**Credit cards (the subtle part).** When you spend on a credit card in a budgeted
category, the money you budgeted is *moved* into that card's payment envelope, so
you always have cash set aside to pay the card. Implemented as: a categorized
card purchase adds to the payment category's activity (money in), and paying the
card (a transfer into the card account) subtracts from it (money out). A purchase
nets to zero across the two envelopes; a payment reduces total available (money
left to retire debt). This is validated against real exported plan numbers.

**Households & Ready-to-Assign.** Each household's Ready-to-Assign is its own
income + money transferred *into* it from another household − what it assigned.
The per-household numbers always sum to the global total (there's a test for
that). Money moved between households (e.g. funding a joint account) counts as
the receiving household's income, exactly as it did when they were separate
budgets.

**Off-budget accounts.** Tracking accounts (investments) don't affect envelopes;
their balances are shown but excluded from the budget math. Unapproved
(scheduled) transactions are excluded until approved.

## The import/merge pipeline (`packages/core/src/import/`)

Turns exported CSVs into a merged budget. Pure, ordered stages, each in its own
file so it can be tested in isolation:

1. **`csv.ts`** — parse the Register + Plan CSVs with a real CSV parser (handles a
   byte-order mark and commas inside quoted memos).
2. **`normalize.ts`** — typed rows: signed integer amounts, ISO dates, trimmed +
   case-folded names for matching, and a `kind` (normal / income / transfer).
3. **`transactions.ts`** — reconstruct split transactions from their child rows.
4. **`transfers.ts`** — the crux:
   - dedupe within-budget transfers (two mirrored rows → one linked pair);
   - **stitch cross-budget transfers**: money moved between two separate exported
     budgets is recorded on each side as an ordinary payee, not a transfer. We
     match those by equal-and-opposite amount within a small date window and
     collapse them into one transfer — while *excluding* look-alikes (e.g. each
     budget paying its own bank the same fee on the same day).
5. **`categories.ts`** — build one category tree, keeping each household's
   sections separate, and link each credit-card payment category to its card.
6. **`identity.ts`** — give every row a deterministic content fingerprint plus an
   "occurrence index" so genuine duplicates are distinguishable. This is what
   makes re-import **idempotent**.
7. **`plan.ts`** — import only the `Assigned` amounts; derive activity/available
   from transactions (importing them would drift after the merge). The export's
   own activity/available become a correctness *oracle* used in testing.
8. **`reconcile.ts`** — diff a fresh import against what's stored: added /
   changed / unchanged / deleted, preserving in-app edits.
9. **`pipeline.ts`** — runs all stages and produces a staging budget + a report
   (counts, the transfer-match histogram, unresolved items).

The specific matching rules (which payee names link the two budgets) are supplied
as **config at runtime**, never hardcoded — so no personal data lives in the
source.

## Editing: the ops layer (`packages/core/src/ops.ts`)

Every user action that changes the budget is a pure function
`(budget, args) => newBudget`: `addTransaction`, `moveMoney`, `reorderCategory`,
`renameGroup`, `setSplits`, `setHouseholdOrder`, and so on. The UI never mutates
data directly — it dispatches one of these and re-renders from the result. That's
why "does feature X do the right thing?" is answered by a fast unit test of the
op, not by clicking around.

## Persistence (`packages/core/src/persistence/`)

The core never calls the filesystem. It depends on a **`FileSystemPort`**
interface (read/write/list/remove text files). Tests inject an in-memory
implementation; the desktop app injects a disk-backed one (via Tauri, still to be
wired). On-disk layout under one data folder:

```
app.json                         index of budgets
budgets/<id>/
  budget.json  accounts.json  categories.json  assignments.json   (pretty, stable-sorted)
  transactions/YYYY-MM.ndjson    one transaction per line, sharded by month
  import/                        re-import bookkeeping
```

Files are written **atomically** (temp file + rename) and serialized
deterministically (sorted keys, stable ordering) so diffs are meaningful — which
also sets up cloud-folder sync later. No absolute paths are stored inside files,
so the whole folder can be relocated.

## UI state flow (`apps/desktop/src/state.tsx`)

One store holds the current `LoadedBudget`. On any change it recomputes the
projection with `computeProjection` (memoized) and re-renders. Components read
from the store and call ops. For the preview, the store is seeded with a
synthetic demo budget (`demo.ts`) so the UI renders without any real data.

## Testing

- **Unit + property tests** in `packages/core` (money round-trips, the envelope
  recurrence, money conservation, import idempotency, every op).
- **Synthetic fixtures first** for the merge — one for each real-world oddity
  (splits, mirrored transfers, near-duplicates, cross-budget ambiguity,
  whitespace/case collisions, future-dated rows) — then validated against real
  data using the export's plan numbers as an oracle.
- Run with `npm test`. The UI is intentionally thin, so it has no heavy test
  suite; its behavior is the ops layer it calls.

## Where things will go next

- `apps/desktop/src-tauri/` — the Rust commands (atomic IO, file dialog, unzip)
  and a `FileSystemPort` implementation over them.
- An import-wizard feature under `apps/desktop/src/features/import/`.
- An analytics feature; the data model already captures what it needs.
