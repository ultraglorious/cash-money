<img src="apps/desktop/public/wordmark.svg" width="300" alt="cash money" />

# cash-money

A local, cross-platform **envelope-budgeting** app. Your money lives on your own
machine (no accounts, no server), you assign every unit of currency to a
category, and the app tracks what you planned vs. what you actually spent.

It can also **import and merge** budgets exported as CSV — including combining two
separate exported budgets (e.g. a personal one and a shared/household one) into a
single budget, with each kept as its own "household" that keeps its own
accounting and its own Ready-to-Assign.

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
- **Import/merge** — format-driven CSV import: budget exports merge into one
  budget (multiple households, dedupe transfers), bank statements import into an
  existing account, and any CSV shape can be described by a column mapping —
  known shapes ship as JSON files in a contributable format library, and your
  own mappings can be saved for reuse. Re-import is safe (idempotent — importing
  the same file twice changes nothing).
- **Analytics** — an overview of income, spending and net over time; a waterfall
  you can drill through account → section → category; a breakdown table with a
  column per month; and net worth by account type. Money moved between your own
  budgets is netted out, so shuffling a contribution a few days early never
  reads as a loss.
- **Sync** — the whole budget is one `.cashmoney` file you can keep in iCloud or
  any synced folder. Two machines open at once resolve by three-way merge rather
  than by asking you to pick a winner.

The budgeting logic is done and thoroughly tested, and the desktop app loads and
saves your real data on disk. See [Status](#status) for what's not built yet.

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
│       └── persistence/    the single-file .cashmoney format (+ legacy layout)
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

### Using it, rather than developing it

`tauri dev` rebuilds and starts a dev server on every launch, which is a lot of
waiting if you only want to *use* the app. Build it once instead and launch it
like anything else:

```bash
npm run app        # macOS: ~20s incrementally, then it's in /Applications
```

That quits the app if it's running (politely, so it finishes saving), builds a
debug bundle — fast to compile, indistinguishable in use for an app this size —
copies it to `/Applications`, and reopens it. Run it again whenever you want the
newest code. A locally built app carries no download quarantine, so macOS opens
it without complaint.

Don't run the installed app and `tauri dev` against the same budget file at the
same time — both will write to it. The sync merge would sort it out, but there's
no reason to make it work.

---

## Key concepts

- **Envelope budgeting.** Every unit of income is assigned ("budgeted") into a
  category envelope. `Available = Available(last month) + Assigned + Activity`,
  and an envelope that ends a month overspent restarts at zero (the shortfall
  comes out of Ready-to-Assign if it was cash, or stays as card debt if it was
  credit).
- **Ready-to-Assign by conservation.** Each household's Ready-to-Assign is the
  cash in its accounts minus everything already sitting in its envelopes — so
  money can never be counted twice, and unassigning everything would exactly
  equal your account balances.
- **Households.** Accounts and categories carry a label (e.g. `Personal`,
  `Joint`) so the Plan shows each household's envelopes and its own
  Ready-to-Assign, even though it's one merged budget. Money moved between
  households stays as recorded: an expense on the sending side, income on the
  receiving side.
- **Credit cards.** Spending on a card moves the *covered* part of the purchase
  (what the envelope could afford that month) into the card's "payment"
  envelope, so money is set aside to pay it off; anything uncovered stays as
  debt on the card. Paying the card draws the payment envelope back down.
- **Import is idempotent.** Because the exported files have no stable IDs, each
  row gets a deterministic content fingerprint, so importing the same export
  twice changes nothing. (Note: committing an import currently *replaces* the
  budget — merging a fresh export into an edited budget is planned; the
  reconcile machinery for it already exists.)

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
"ops" edit layer, file persistence, and the full Plan + Transactions UI. The
native **Tauri shell** (atomic file writes, file picker, unzip commands) is in
place, the app **loads/saves your real budget on disk**, and the **import wizard**
(pick export → dry-run report → commit) works. In a plain browser the app still
runs on demo data with no persistence.

Also done since: **analytics** (four views, with cross-budget transfers netted
out), **single-file sync** with three-way merge between machines, **edit-preserving
re-import**, **explicit transfers** between accounts, **card invoice deduction**
(a statement match is not the same as a bill being paid), and a **safety net for
bulk edits** — dated snapshots, undo, and a runtime check that refuses an edit
claiming to change no figures if it would.

Not done yet:

- **Targets** — categories carry no "€300 a month" goal; assignment is manual
  every month, with quick-fill suggestions from your own history.
- **Recurring transfers** — scheduled rows repeat, but not transfer pairs.
- **Custom app icons** — still the default Tauri icons.
