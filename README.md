<img src="apps/desktop/public/wordmark.svg" width="300" alt="cash money" />

# cash-money

A local, cross-platform **envelope-budgeting** app. Your money lives on your own
machine (no accounts, no server), you assign every unit of currency to a
category, and the app tracks what you planned vs. what you actually spent.

It can also **import and merge** budgets exported as CSV — including combining two
separate exported budgets (e.g. a personal one and a shared/household one) into a
single budget, automatically reconstructing the transfers between them.

> **New to this stack?** This project is TypeScript + React + Tauri. If you can
> program but haven't used these, read [Language & tooling primer](#language--tooling-primer)
> first — it maps every unfamiliar word to something you already know. Then
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit.

---

## What it does today

- **Plan** — monthly envelope budgeting: assign money to categories, see
  Activity and Available, move money between categories, cover overspending,
  grouped by "household" (e.g. Personal vs Joint) with a per-household
  Ready-to-Assign breakdown.
- **Transactions** — a register per account (and an all-accounts view): add,
  edit, split across categories, mark cleared, approve scheduled entries, search
  and sort.
- **Import/merge** — parse exported CSVs, merge multiple budgets into one, dedupe
  transfers, and re-import safely (idempotent — importing the same file twice
  changes nothing).
- **Analytics** — a placeholder for now.

The budgeting logic is done and thoroughly tested. The desktop app currently runs
on **demo data**; wiring it to load/save your real data on disk (and an import
wizard) is the next milestone — see [Status](#status).

---

## Project layout

This is a **monorepo** (one git repo containing several packages that depend on
each other), using npm workspaces:

```
cash-money/
├── packages/core/        ← all the budgeting logic. Plain TypeScript, no UI.
│   └── src/
│       ├── money.ts        exact money math (integer minor units, never floats)
│       ├── time.ts         date/month helpers (timezone-safe)
│       ├── ids.ts          unique ids + content fingerprints
│       ├── model/          the data types (Account, Category, Transaction, …)
│       ├── engine/         the envelope calculator (activity, available, RTA, cards)
│       ├── import/         CSV parsing + the merge/reconcile pipeline
│       ├── ops.ts          pure "edit the budget" operations (add/move/rename/…)
│       └── persistence/    reading/writing the budget as files
└── apps/desktop/         ← the GUI. React + Mantine, packaged with Tauri.
    └── src/
        ├── state.tsx       app state; calls into packages/core
        ├── components/     sidebar, modals, shared widgets
        └── features/       plans / transactions / analytics screens
```

The golden rule: **`packages/core` contains no UI and no framework code.** It's
pure logic that can be tested in milliseconds and reused anywhere. `apps/desktop`
is a thin shell that renders that logic. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why.

---

## Quickstart

Prerequisites: **Node.js 20+** and **npm**. (The desktop app also needs the Rust
toolchain for Tauri — not required just to run the logic or the web preview.)

```bash
npm install            # install everything (workspaces share one install)
npm test               # run the core test suite (fast, no browser needed)
npm run typecheck      # type-check every package
```

Preview the UI in a browser (no Tauri/Rust needed — it renders demo data):

```bash
npm run dev --workspace @cash-money/desktop
# then open http://localhost:5173
```

Only one dev server can run at a time (the port is fixed for Tauri). If you see
"Port 5173 is already in use", stop the old one: `lsof -ti:5173 | xargs kill`.

---

## Key concepts

- **Envelope budgeting.** Every unit of income is assigned ("budgeted") into a
  category envelope. `Available = Available(last month) + Assigned + Activity`.
  "Ready to Assign" is income you haven't put into an envelope yet.
- **Households.** Accounts and categories carry a label (e.g. `Personal`,
  `Joint`) so the Plan can show each household's envelopes and its own
  Ready-to-Assign, even though it's one merged budget. Money moved *between*
  households (a transfer) funds the receiving household.
- **Credit cards.** Spending on a card moves the budgeted money into that card's
  "payment" envelope, so you always have money set aside to pay it off. Paying
  the card draws that envelope back down.
- **Import is idempotent.** Because the exported files have no stable IDs, each
  row gets a deterministic content fingerprint. Re-importing recognizes rows it
  already has, so you can drop in a fresh export any time and only real changes
  apply — your in-app edits are preserved.

---

## Language & tooling primer

If you code but don't know this specific stack, here's the whole vocabulary:

| Term | What it is, in plain terms |
|---|---|
| **TypeScript** | JavaScript with static types. Compiles to JS; types are checked at build time, then erased. Think "Python with type hints that are actually enforced." |
| **`interface` / `type`** | A shape/struct definition. No runtime cost. |
| **Branded type** (e.g. `Cents`, `Ulid`) | A plain `number`/`string` tagged at the type level so you can't accidentally mix, say, cents with euros or an id with a name. Zero runtime cost — purely a compile-time guardrail. |
| **Pure function** | Given the same inputs, returns the same output and changes nothing else. The whole `engine/` and `ops.ts` are pure — that's why they're trivial to test. |
| **`packages/core` "port"** | An interface (e.g. `FileSystemPort`) the core depends on instead of touching the filesystem directly. Tests pass an in-memory version; the real app passes a disk-backed one. (Classic "dependency injection / hexagonal architecture".) |
| **React** | A UI library. You write **components** — functions that return a description of UI. When data changes, React re-renders. |
| **Hook** (`useState`, `useMemo`, …) | A function that lets a component hold state or cache a computed value between renders. |
| **Mantine** | A ready-made React component library (buttons, tables, modals, date pickers) with theming and light/dark mode. |
| **Vite** | The dev server + bundler. `npm run dev` starts it with instant hot-reload. |
| **Tauri** | Wraps the web UI into a small native desktop app (a Rust shell + the OS's built-in webview). Lighter than Electron. |
| **vitest** | The test runner (like `pytest`/`jest`). `npm test` runs it. |
| **zod** | Runtime schema validation — checks that data read from disk actually matches the expected shape. |
| **ULID** | A sortable, collision-free unique id (like a UUID, but time-ordered). |
| **NDJSON** | "Newline-delimited JSON" — one JSON object per line. Used for transaction files so diffs stay small. |
| **@dnd-kit** | The drag-and-drop library used for reordering categories/sections/accounts. |

---

## Testing philosophy

Correctness lives in `packages/core`, tested with plain unit tests + property
tests (100+ tests, run in ~1s). The UI is a thin layer that just calls those
tested operations, so we don't need brittle browser tests to trust the behavior.
The import/merge was validated against real exported data using the export's own
plan numbers as a correctness oracle. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#testing).

---

## Status

Done and tested: money math, the envelope engine (incl. credit-card auto-move and
per-household Ready-to-Assign), the import/merge/reconcile pipeline, the pure
"ops" edit layer, file persistence (behind a port), and the full Plan +
Transactions UI (on demo data).

Not done yet:

- **Native shell + persistence** — the Rust/Tauri commands (atomic file writes,
  file picker, unzip) and wiring the UI to load/save your real budget on disk.
- **Import wizard** — pick your export → see a dry-run report → commit.
- **Analytics** — currently a placeholder.
- **Sync** — the file layout is designed to drop into a synced folder later.
