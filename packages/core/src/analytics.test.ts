import { describe, expect, it } from "vitest";
import type { Cents } from "./money.js";
import type { LoadedBudget, Transaction } from "./model/types.js";
import { detailTree, flows, householdTransferIds, monthlyCashflow, netWorthSeries, TRANSFERS, UNCATEGORIZED } from "./analytics.js";
import * as f from "../test/fixtures/factories.js";

const CHK = f.tid("ACHK");
const CARD = f.tid("ACRD");
const TRK = f.tid("ATRK");
const GINC = f.tid("GINC");
const GEVD = f.tid("GEVD");
const RTA = f.tid("CRTA");
const GRO = f.tid("CGRO");
const DIN = f.tid("CDIN");

function base(transactions: Transaction[]): LoadedBudget {
  return {
    budget: f.budget(),
    accounts: [
      f.account({ id: CHK, name: "Checking", type: "checking", onBudget: true }),
      f.account({ id: CARD, name: "Card", type: "creditCard", onBudget: true }),
      f.account({ id: TRK, name: "Broker", type: "tracking", onBudget: false }),
    ],
    groups: [
      f.group({ id: GINC, name: "Inflow", kind: "income" }),
      f.group({ id: GEVD, name: "Everyday", kind: "normal" }),
    ],
    categories: [
      f.category({ id: RTA, groupId: GINC, name: "Ready to Assign" }),
      f.category({ id: GRO, groupId: GEVD, name: "Groceries" }),
      f.category({ id: DIN, groupId: GEVD, name: "Dining" }),
    ],
    assignments: [],
    transactions,
  };
}

const txs: Transaction[] = [
  f.txn({ id: f.tid("T1"), accountId: CHK, date: "2026-01-02", amount: 300000 as Cents, categoryId: RTA, payee: "Employer" }),
  f.txn({ id: f.tid("T2"), accountId: CHK, date: "2026-01-10", amount: -40000 as Cents, categoryId: GRO, payee: "Market" }),
  f.txn({
    id: f.tid("T3"), accountId: CARD, date: "2026-01-15", amount: -10000 as Cents, payee: "Bistro",
    splits: [
      { id: f.tid("S1"), categoryId: DIN, amount: -7000 as Cents, memo: "" },
      { id: f.tid("S2"), categoryId: GRO, amount: -3000 as Cents, memo: "" },
    ],
  }),
  // Card payment: transfer pair, must cancel out of category math.
  f.txn({ id: f.tid("T4"), accountId: CHK, date: "2026-02-10", amount: -10000 as Cents, payee: "Transfer : Card", categoryId: undefined, transfer: { counterAccountId: CARD, pairId: f.tid("P1") } }),
  f.txn({ id: f.tid("T5"), accountId: CARD, date: "2026-02-10", amount: 10000 as Cents, payee: "Transfer : Checking", categoryId: undefined, transfer: { counterAccountId: CHK, pairId: f.tid("P1") } }),
  // March spending + an off-budget tracking deposit + a scheduled (ignored) row.
  f.txn({ id: f.tid("T6"), accountId: CHK, date: "2026-03-05", amount: -5000 as Cents, categoryId: DIN, payee: "Cafe" }),
  f.txn({ id: f.tid("T7"), accountId: TRK, date: "2026-03-06", amount: 50000 as Cents, payee: "Deposit" }),
  f.txn({ id: f.tid("T8"), accountId: CHK, date: "2026-03-20", amount: -99900 as Cents, categoryId: DIN, payee: "Future", approved: false }),
];

describe("monthlyCashflow", () => {
  it("splits income vs spending by month, split-aware, transfers and off-budget excluded", () => {
    const rows = monthlyCashflow(base(txs));
    expect(rows.map((r) => r.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(rows[0]).toMatchObject({ income: 300000, spending: 50000, net: 250000 });
    expect(rows[1]).toMatchObject({ income: 0, spending: 0 }); // transfer month: nothing real
    expect(rows[2]).toMatchObject({ income: 0, spending: 5000 }); // scheduled + tracking ignored
  });
});

describe("netWorthSeries", () => {
  it("accumulates balances by account type, transfers included", () => {
    const points = netWorthSeries(base(txs));
    const jan = points.find((p) => p.month === "2026-01")!;
    expect(jan).toMatchObject({ cash: 260000, credit: -10000, tracking: 0, total: 250000 });
    const feb = points.find((p) => p.month === "2026-02")!;
    expect(feb).toMatchObject({ cash: 250000, credit: 0, total: 250000 }); // payment moved, not created
    const mar = points.find((p) => p.month === "2026-03")!;
    expect(mar).toMatchObject({ cash: 245000, tracking: 50000, total: 295000 });
  });
});

describe("flows", () => {
  const range = { from: "2026-01", to: "2026-03" };

  it("by section: income positive, spending negative, transfers cancelled", () => {
    const nodes = flows(base(txs), "section", range);
    expect(nodes).toEqual([
      { key: GINC, label: "Inflow", amount: 300000 },
      { key: GEVD, label: "Everyday", amount: -55000 },
    ]);
  });

  it("by category with a section filter drills correctly", () => {
    const nodes = flows(base(txs), "category", { ...range, groupId: GEVD });
    expect(nodes.find((n) => n.key === GRO)!.amount).toBe(-43000); // split line included
    expect(nodes.find((n) => n.key === DIN)!.amount).toBe(-12000);
  });

  it("by account keeps transfers; drilling into one account surfaces them", () => {
    const byAccount = flows(base(txs), "account", range);
    expect(byAccount.find((n) => n.key === CHK)!.amount).toBe(245000);
    expect(byAccount.find((n) => n.key === CARD)!.amount).toBe(0); // spend −100, payment +100
    const inCard = flows(base(txs), "section", { ...range, accountId: CARD });
    expect(inCard.find((n) => n.key === TRANSFERS)!.amount).toBe(10000);
  });

  it("respects the month range filter and hides off-budget accounts until drilled into", () => {
    const marchOnly = flows(base(txs), "payee", { from: "2026-03", to: "2026-03" });
    expect(marchOnly).toEqual([{ key: "Cafe", label: "Cafe", amount: -5000 }]);
    const inTracking = flows(base(txs), "payee", { from: "2026-03", to: "2026-03", accountId: TRK });
    expect(inTracking).toEqual([{ key: "Deposit", label: "Deposit", amount: 50000 }]);
  });
});

describe("householdTransferIds (global perspective)", () => {
  const JNT = f.tid("AJNT");
  const CONTRIB = f.tid("CCON");

  function withHouseholds(extra: Transaction[]): LoadedBudget {
    const b = base(extra);
    b.accounts = [
      f.account({ id: CHK, name: "Checking", type: "checking", onBudget: true, household: "Personal" }),
      f.account({ id: JNT, name: "Joint", type: "checking", onBudget: true, household: "Joint" }),
    ];
    b.categories = [...b.categories, f.category({ id: CONTRIB, groupId: GEVD, name: "Joint contribution" })];
    return b;
  }

  // Personal sends June 28; Joint records it as July income a few days later.
  const send = f.txn({ id: f.tid("HT1"), accountId: CHK, date: "2026-06-28", amount: -200000 as Cents, categoryId: f.tid("CCON"), payee: "Joint" });
  const recv = f.txn({ id: f.tid("HT2"), accountId: f.tid("AJNT"), date: "2026-07-01", amount: 200000 as Cents, categoryId: RTA, payee: "From Personal" });
  const salary = f.txn({ id: f.tid("HT3"), accountId: f.tid("AJNT"), date: "2026-07-02", amount: 200000 as Cents, categoryId: RTA, payee: "Employer" });

  it("pairs equal-and-opposite cross-household rows within the window, each leg once", () => {
    const ids = householdTransferIds(withHouseholds([send, recv, salary]));
    expect(ids).toEqual(new Set([send.id, recv.id])); // salary left alone: send already claimed
  });

  it("does not pair same-household or far-apart rows", () => {
    const sameHouse = { ...recv, id: f.tid("HT4"), accountId: CHK };
    expect(householdTransferIds(withHouseholds([send, sameHouse]))).toEqual(new Set());
    const tooLate = { ...recv, id: f.tid("HT5"), date: "2026-07-20" };
    expect(householdTransferIds(withHouseholds([send, tooLate]))).toEqual(new Set());
  });

  it("nets the pair out of cashflow and global section flows, but keeps it inside the account drill", () => {
    const b = withHouseholds([send, recv, salary]);
    const june = monthlyCashflow(b).find((r) => r.month === "2026-06");
    const july = monthlyCashflow(b).find((r) => r.month === "2026-07")!;
    expect(june?.spending ?? 0).toBe(0); // no fabricated June loss
    expect(july.income).toBe(200000); // only the real salary

    const global = flows(b, "section", { from: "2026-06", to: "2026-07" });
    expect(global.find((n) => n.key === GEVD)).toBeUndefined(); // contribution netted out
    expect(global.find((n) => n.key === GINC)!.amount).toBe(200000);

    const insidePersonal = flows(b, "section", { from: "2026-06", to: "2026-07", accountId: CHK });
    expect(insidePersonal.find((n) => n.key === GEVD)!.amount).toBe(-200000); // real outflow from HERE
  });
});

describe("categorized transfer legs (transfers that leave a budget scope)", () => {
  const JNT2 = f.tid("AJN2");
  const pair = f.tid("PRX1");
  function withPair(): LoadedBudget {
    const b = base([]);
    b.accounts = [
      f.account({ id: CHK, name: "Checking", type: "checking", onBudget: true, household: "Personal" }),
      f.account({ id: JNT2, name: "Joint", type: "checking", onBudget: true, household: "Joint" }),
    ];
    b.transactions = [
      f.txn({ id: f.tid("XO"), accountId: CHK, date: "2026-06-28", amount: -200000 as Cents, categoryId: GRO, payee: "Transfer to: Joint", transfer: { counterAccountId: JNT2, pairId: pair } }),
      f.txn({ id: f.tid("XI"), accountId: JNT2, date: "2026-06-28", amount: 200000 as Cents, payee: "Transfer from: Checking", categoryId: undefined, transfer: { counterAccountId: CHK, pairId: pair } }),
    ];
    return b;
  }
  const range = { from: "2026-06", to: "2026-06" };

  it("stays out of global views but files under its envelope inside the account", () => {
    const b = withPair();
    expect(flows(b, "section", range)).toEqual([]); // globally the pair cancels
    expect(monthlyCashflow(b)).toEqual([]); // no fabricated spending or income
    const inside = flows(b, "section", { ...range, accountId: CHK });
    expect(inside).toEqual([{ key: GEVD, label: "Everyday", amount: -200000 }]);
    const tree = detailTree(b, "2026-06", "2026-06");
    const chk = tree.find((n) => n.key === CHK)!;
    expect(chk.children![0]).toMatchObject({ key: GEVD, total: -200000 });
    expect(tree.find((n) => n.key === JNT2)!.children![0]!.key).toBe(TRANSFERS);
  });
});

describe("detailTree", () => {
  it("nests account → section → category → payee with per-month cells", () => {
    const tree = detailTree(base(txs), "2026-01", "2026-03");
    const chk = tree.find((n) => n.key === CHK)!;
    expect(chk.total).toBe(245000);
    expect(chk.monthly["2026-01"]).toBe(260000);
    const everyday = chk.children!.find((n) => n.key === GEVD)!;
    const dining = everyday.children!.find((n) => n.key === DIN)!;
    expect(dining.total).toBe(-5000);
    expect(dining.children![0]).toMatchObject({ label: "Cafe", total: -5000 });
    // transfers appear inside the account, never as a category of spending
    const chkTransfers = chk.children!.find((n) => n.key === TRANSFERS)!;
    expect(chkTransfers.total).toBe(-10000);
    expect(tree.find((n) => n.key === CARD)!.children!.find((n) => n.key === UNCATEGORIZED)).toBeUndefined();
  });
});
