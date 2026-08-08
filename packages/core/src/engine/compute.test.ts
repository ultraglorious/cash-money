import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { computeProjection } from "./compute.js";
import * as f from "../../test/fixtures/factories.js";
import type { Cents } from "../money.js";
import type { LoadedBudget, Transaction } from "../model/types.js";

/**
 * A budget with income, a cash spending category, a credit card and its payment
 * category. Exercises the full auto-move path.
 */
function creditCardScenario(): LoadedBudget {
  const checking = f.account({ id: f.tid("ACHK"), name: "Checking", type: "checking" });
  const card = f.account({ id: f.tid("ACRD"), name: "Card", type: "creditCard" });

  const incomeGrp = f.group({ id: f.tid("GINC"), name: "Inflow", kind: "income", sortOrder: 0 });
  const everydayGrp = f.group({ id: f.tid("GEVD"), name: "Everyday", kind: "normal", sortOrder: 1 });
  const ccGrp = f.group({ id: f.tid("GCCP"), name: "Card Payments", kind: "creditCardPayments", sortOrder: 2 });

  const readyToAssign = f.category({ id: f.tid("CRTA"), groupId: incomeGrp.id, name: "Ready to Assign" });
  const groceries = f.category({ id: f.tid("CGRO"), groupId: everydayGrp.id, name: "Groceries" });
  const cardPayment = f.category({
    id: f.tid("CPAY"),
    groupId: ccGrp.id,
    name: "Card",
    linkedAccountId: card.id,
  });

  const pairId = f.tid("PAIR1");
  const transactions: Transaction[] = [
    // Jan: income 2000 into checking
    f.txn({ id: f.tid("T1"), accountId: checking.id, date: "2026-01-05", amount: 200000 as Cents, payee: "Employer", categoryId: readyToAssign.id }),
    // Jan: 120 groceries on the CARD
    f.txn({ id: f.tid("T2"), accountId: card.id, date: "2026-01-10", amount: -12000 as Cents, payee: "Shop", categoryId: groceries.id }),
    // Feb: pay the card 120 (transfer checking -> card)
    f.txn({ id: f.tid("T3"), accountId: checking.id, date: "2026-02-10", amount: -12000 as Cents, payee: "Transfer", categoryId: undefined, transfer: { counterAccountId: card.id, pairId } }),
    f.txn({ id: f.tid("T4"), accountId: card.id, date: "2026-02-10", amount: 12000 as Cents, payee: "Transfer", categoryId: undefined, transfer: { counterAccountId: checking.id, pairId } }),
  ];

  return {
    budget: f.budget(),
    accounts: [checking, card],
    groups: [incomeGrp, everydayGrp, ccGrp],
    categories: [readyToAssign, groceries, cardPayment],
    assignments: [
      f.assignment({ id: f.tid("A1"), month: "2026-01", categoryId: groceries.id, assigned: 50000 as Cents }),
    ],
    transactions,
  };
}

describe("transfers that leave a budget scope carry a funded outflow leg", () => {
  const personal = f.account({ id: f.tid("APER"), name: "Personal", type: "checking", household: "Personal" });
  const joint = f.account({ id: f.tid("AJNT"), name: "Joint", type: "checking", household: "Joint" });
  const incomeGrp = f.group({ id: f.tid("GIN2"), name: "Inflow", kind: "income", sortOrder: 0 });
  const evGrp = f.group({ id: f.tid("GEV2"), name: "Everyday", kind: "normal", sortOrder: 1, household: "Personal" });
  const rta = f.category({ id: f.tid("CRT2"), groupId: incomeGrp.id, name: "Ready to Assign" });
  const contrib = f.category({ id: f.tid("CCO2"), groupId: evGrp.id, name: "Joint contribution" });
  const pairId = f.tid("PAIR9");

  const b: LoadedBudget = {
    budget: f.budget(),
    accounts: [personal, joint],
    groups: [incomeGrp, evGrp],
    categories: [rta, contrib],
    assignments: [f.assignment({ id: f.tid("AS9"), month: "2026-06", categoryId: contrib.id, assigned: 200000 as Cents })],
    transactions: [
      f.txn({ id: f.tid("TI9"), accountId: personal.id, date: "2026-06-01", amount: 500000 as Cents, categoryId: rta.id, payee: "Employer" }),
      // The contribution: a REAL transfer whose outflow leg spends from the envelope.
      f.txn({ id: f.tid("TO9"), accountId: personal.id, date: "2026-06-28", amount: -200000 as Cents, categoryId: contrib.id, payee: "Transfer to: Joint", transfer: { counterAccountId: joint.id, pairId } }),
      f.txn({ id: f.tid("TR9"), accountId: joint.id, date: "2026-06-28", amount: 200000 as Cents, payee: "Transfer from: Personal", categoryId: undefined, transfer: { counterAccountId: personal.id, pairId } }),
    ],
  };
  const p = computeProjection(b);

  it("spends from the sender's envelope, so the sender's RTA stays whole", () => {
    expect(p.activityOf(f.tid("CCO2"), "2026-06")).toBe(-200000);
    expect(p.availableOf(f.tid("CCO2"), "2026-06")).toBe(0); // 2000 assigned, 2000 spent
    const byHh = p.readyToAssignByHousehold("2026-06");
    // Personal: 5000 in − 2000 assigned to the envelope = 3000 assignable.
    expect(byHh.get("Personal")).toBe(300000);
  });

  it("raises the receiving household's RTA like income, with no category needed", () => {
    const byHh = p.readyToAssignByHousehold("2026-06");
    expect(byHh.get("Joint")).toBe(200000);
    expect(p.readyToAssignOf("2026-06")).toBe(500000); // households sum cleanly
  });

  it("treats leaving the budget entirely (a tracking account) the same way", () => {
    const broker = f.account({ id: f.tid("ABRK"), name: "Broker", type: "tracking", onBudget: false, household: "Personal" });
    const invest = f.category({ id: f.tid("CIV2"), groupId: evGrp.id, name: "Investing" });
    const pair2 = f.tid("PAIRA");
    const b2: LoadedBudget = {
      ...b,
      accounts: [...b.accounts, broker],
      categories: [...b.categories, invest],
      assignments: [...b.assignments, f.assignment({ id: f.tid("ASA2"), month: "2026-06", categoryId: invest.id, assigned: 100000 as Cents })],
      transactions: [
        ...b.transactions,
        f.txn({ id: f.tid("TB1"), accountId: personal.id, date: "2026-06-15", amount: -100000 as Cents, categoryId: invest.id, payee: "Transfer to: Broker", transfer: { counterAccountId: broker.id, pairId: pair2 } }),
        f.txn({ id: f.tid("TB2"), accountId: broker.id, date: "2026-06-15", amount: 100000 as Cents, payee: "Transfer from: Personal", categoryId: undefined, transfer: { counterAccountId: personal.id, pairId: pair2 } }),
      ],
    };
    const p2 = computeProjection(b2);
    // The envelope spends; Personal's RTA drops only by what was ASSIGNED.
    expect(p2.activityOf(f.tid("CIV2"), "2026-06")).toBe(-100000);
    expect(p2.availableOf(f.tid("CIV2"), "2026-06")).toBe(0);
    expect(p2.readyToAssignByHousehold("2026-06").get("Personal")).toBe(200000); // 5000 − 2000 − 1000 assigned
    // Net-worth view of the same move: money changed pockets, not size.
    const bal = p2.accountBalances();
    expect(bal.get(f.tid("ABRK"))).toBe(100000);
  });
});

describe("credit-card auto-move", () => {
  const b = creditCardScenario();
  const p = computeProjection(b);
  const GRO = f.tid("CGRO");
  const PAY = f.tid("CPAY");

  it("moves budgeted money into the payment category on a card purchase (net zero)", () => {
    // Jan: groceries -120, payment +120
    expect(p.activityOf(GRO, "2026-01")).toBe(-12000);
    expect(p.activityOf(PAY, "2026-01")).toBe(12000);
    expect(p.availableOf(GRO, "2026-01")).toBe(38000); // 500 - 120
    expect(p.availableOf(PAY, "2026-01")).toBe(12000);
  });

  it("draws the payment category down when the card is paid", () => {
    expect(p.activityOf(PAY, "2026-02")).toBe(-12000);
    expect(p.availableOf(PAY, "2026-02")).toBe(0);
    expect(p.availableOf(GRO, "2026-02")).toBe(38000); // carries over untouched
  });

  it("computes Ready to Assign as cumulative income minus assigned", () => {
    expect(p.readyToAssignOf("2026-01")).toBe(150000); // 2000 - 500
    expect(p.readyToAssignOf("2026-02")).toBe(150000);
  });

  it("computes account balances (card returns to zero after payoff)", () => {
    const bal = p.accountBalances();
    expect(bal.get(f.tid("ACHK"))).toBe(188000); // 2000 - 120
    expect(bal.get(f.tid("ACRD"))).toBe(0); // -120 + 120
  });

  it("conserves money: Σ available + RTA == Σ on-budget balances", () => {
    const last = p.months[p.months.length - 1]!;
    const view = p.monthView(last);
    const sumAvail = view.flat.reduce((a, c) => a + c.available, 0);
    const total = sumAvail + view.readyToAssign;
    const balances = p.accountBalances();
    let onBudget = 0;
    for (const acc of b.accounts) if (acc.onBudget) onBudget += balances.get(acc.id)!;
    expect(total).toBe(onBudget);
  });

  it("exposes grouped and flat projections of the same numbers", () => {
    const view = p.monthView("2026-01");
    // Income group excluded from envelope views.
    expect(view.groups.map((g) => g.group.name)).toEqual(["Everyday", "Card Payments"]);
    const flatIds = view.flat.map((c) => c.categoryId).sort();
    expect(flatIds).toEqual([GRO, PAY].sort());
  });
});

describe("moving money between categories mid-month", () => {
  it("leaves Ready to Assign and total available unchanged", () => {
    const b = creditCardScenario();
    const before = computeProjection(b);
    const rtaBefore = before.readyToAssignOf("2026-01");

    // Move 100 from groceries to a new category by editing assignments.
    const other = f.category({ id: f.tid("COTH"), groupId: f.tid("GEVD"), name: "Fun" });
    const moved: LoadedBudget = {
      ...b,
      categories: [...b.categories, other],
      assignments: [
        f.assignment({ id: f.tid("A1"), month: "2026-01", categoryId: f.tid("CGRO"), assigned: 40000 as Cents }),
        f.assignment({ id: f.tid("A2"), month: "2026-01", categoryId: other.id, assigned: 10000 as Cents }),
      ],
    };
    const after = computeProjection(moved);
    expect(after.readyToAssignOf("2026-01")).toBe(rtaBefore); // same total assigned

    const v = after.monthView("2026-01");
    const sumAvail = v.flat.reduce((a, c) => a + c.available, 0);
    const vb = before.monthView("2026-01");
    const sumAvailBefore = vb.flat.reduce((a, c) => a + c.available, 0);
    expect(sumAvail).toBe(sumAvailBefore);
  });
});

describe("splits, off-budget, and unapproved handling", () => {
  const checking = f.account({ id: f.tid("ACHK"), type: "checking" });
  const tracking = f.account({ id: f.tid("ATRK"), type: "tracking", onBudget: false });
  const grp = f.group({ id: f.tid("GEVD"), name: "Everyday", kind: "normal", sortOrder: 0 });
  const groceries = f.category({ id: f.tid("CGRO"), groupId: grp.id, name: "Groceries" });
  const fun = f.category({ id: f.tid("CFUN"), groupId: grp.id, name: "Fun" });

  function base(transactions: Transaction[]): LoadedBudget {
    return {
      budget: f.budget(),
      accounts: [checking, tracking],
      groups: [grp],
      categories: [groceries, fun],
      assignments: [],
      transactions,
    };
  }

  it("splits contribute each line to its own category", () => {
    const b = base([
      f.txn({
        id: f.tid("TSPLIT"),
        accountId: checking.id,
        date: "2026-01-10",
        amount: -5000 as Cents,
        categoryId: undefined,
        splits: [
          { id: f.tid("S1"), categoryId: groceries.id, amount: -3000 as Cents, memo: "food" },
          { id: f.tid("S2"), categoryId: fun.id, amount: -2000 as Cents, memo: "toy" },
        ],
      }),
    ]);
    const p = computeProjection(b);
    expect(p.activityOf(f.tid("CGRO"), "2026-01")).toBe(-3000);
    expect(p.activityOf(f.tid("CFUN"), "2026-01")).toBe(-2000);
    expect(p.accountBalances().get(checking.id)).toBe(-5000);
  });

  it("ignores off-budget (tracking) account activity in envelopes but tracks its balance", () => {
    const b = base([
      f.txn({ id: f.tid("TTRK"), accountId: tracking.id, date: "2026-01-10", amount: -7000 as Cents, categoryId: groceries.id }),
    ]);
    const p = computeProjection(b);
    expect(p.activityOf(f.tid("CGRO"), "2026-01")).toBe(0); // envelope untouched
    expect(p.accountBalances().get(tracking.id)).toBe(-7000); // balance still tracked
  });

  it("excludes unapproved (scheduled) transactions from everything until approved", () => {
    const scheduled = f.txn({
      id: f.tid("TSCH"),
      accountId: checking.id,
      date: "2026-09-01",
      amount: -4000 as Cents,
      categoryId: groceries.id,
      approved: false,
    });
    const pending = computeProjection(base([scheduled]));
    expect(pending.activityOf(f.tid("CGRO"), "2026-09")).toBe(0);
    expect(pending.accountBalances().get(checking.id) ?? 0).toBe(0);

    // Once approved, it counts.
    const approved = computeProjection(base([{ ...scheduled, approved: true }]));
    expect(approved.activityOf(f.tid("CGRO"), "2026-09")).toBe(-4000);
    expect(approved.accountBalances().get(checking.id)).toBe(-4000);
  });
});

describe("credit-card overspend", () => {
  // Jan: income 100, assign 60 to Groceries, then spend 100 in Groceries (a 40
  // overspend). Whether that overspend is cash or credit depends on the account.
  function scenario(onCard: boolean): LoadedBudget {
    const checking = f.account({ id: f.tid("ACHK"), name: "Checking", type: "checking" });
    const card = f.account({ id: f.tid("ACRD"), name: "Card", type: "creditCard" });
    const incomeGrp = f.group({ id: f.tid("GINC"), name: "Inflow", kind: "income", sortOrder: 0 });
    const evGrp = f.group({ id: f.tid("GEVD"), name: "Everyday", kind: "normal", sortOrder: 1 });
    const ccGrp = f.group({ id: f.tid("GCCP"), name: "Card Payments", kind: "creditCardPayments", sortOrder: 2 });
    const rta = f.category({ id: f.tid("CRTA"), groupId: incomeGrp.id, name: "Ready to Assign" });
    const gro = f.category({ id: f.tid("CGRO"), groupId: evGrp.id, name: "Groceries" });
    const pay = f.category({ id: f.tid("CPAY"), groupId: ccGrp.id, name: "Card", linkedAccountId: card.id });
    return {
      budget: f.budget(),
      accounts: [checking, card],
      groups: [incomeGrp, evGrp, ccGrp],
      categories: [rta, gro, pay],
      assignments: [
        f.assignment({ id: f.tid("A1"), month: "2026-01", categoryId: gro.id, assigned: 60000 as Cents }),
        f.assignment({ id: f.tid("A2"), month: "2026-02", categoryId: gro.id, assigned: 0 as Cents }), // extends range to Feb
      ],
      transactions: [
        f.txn({ id: f.tid("T1"), accountId: checking.id, date: "2026-01-05", amount: 100000 as Cents, categoryId: rta.id }),
        f.txn({ id: f.tid("T2"), accountId: onCard ? card.id : checking.id, date: "2026-01-10", amount: -100000 as Cents, categoryId: gro.id }),
      ],
    };
  }

  it("credit overspend becomes card debt, resets the envelope, and never reduces Ready-to-Assign", () => {
    const p = computeProjection(scenario(true));
    const GRO = f.tid("CGRO");
    const PAY = f.tid("CPAY");
    // Jan: the envelope shows the overspend; only the covered 60 is set aside to pay.
    expect(p.availableOf(GRO, "2026-01")).toBe(-40000);
    expect(p.availableOf(PAY, "2026-01")).toBe(60000);
    // Feb: envelope resets to 0; the 40 stays as debt on the card; RTA still 100−60.
    expect(p.availableOf(GRO, "2026-02")).toBe(0);
    expect(p.readyToAssignOf("2026-02")).toBe(40000);
  });

  it("cash overspend is swept from Ready-to-Assign", () => {
    const p = computeProjection(scenario(false));
    const GRO = f.tid("CGRO");
    expect(p.availableOf(GRO, "2026-01")).toBe(-40000);
    expect(p.availableOf(GRO, "2026-02")).toBe(0); // resets
    // Feb: the 40 cash overspend has reduced Ready-to-Assign (100 − 60 − 40).
    expect(p.readyToAssignOf("2026-02")).toBe(0);
  });
});

describe("per-household Ready to Assign", () => {
  function twoHouseholds(): LoadedBudget {
    const chk = f.account({ id: f.tid("ACHK"), name: "Checking", type: "checking", household: "Personal" });
    const jnt = f.account({ id: f.tid("AJNT"), name: "Joint", type: "checking", household: "Joint" });
    const gInc = f.group({ id: f.tid("GINC"), name: "Inflow", kind: "income", household: "Personal", sortOrder: 0 });
    const gPers = f.group({ id: f.tid("GPER"), name: "Everyday", kind: "normal", household: "Personal", sortOrder: 1 });
    const gJoint = f.group({ id: f.tid("GJNT"), name: "Everyday", kind: "normal", household: "Joint", sortOrder: 2 });
    const rta = f.category({ id: f.tid("CRTA"), groupId: gInc.id, name: "Ready to Assign" });
    const cPers = f.category({ id: f.tid("CPER"), groupId: gPers.id, name: "Groceries" });
    const cJoint = f.category({ id: f.tid("CJNT"), groupId: gJoint.id, name: "Groceries" });
    const pair = f.tid("PAIR");
    return {
      budget: f.budget(),
      accounts: [chk, jnt],
      groups: [gInc, gPers, gJoint],
      categories: [rta, cPers, cJoint],
      assignments: [
        f.assignment({ id: f.tid("A1"), month: "2026-01", categoryId: cPers.id, assigned: 50000 as Cents }),
        f.assignment({ id: f.tid("A2"), month: "2026-01", categoryId: cJoint.id, assigned: 40000 as Cents }),
      ],
      transactions: [
        f.txn({ id: f.tid("TINC"), accountId: chk.id, date: "2026-01-02", amount: 300000 as Cents, categoryId: rta.id }),
        f.txn({ id: f.tid("TX1"), accountId: chk.id, date: "2026-01-05", amount: -100000 as Cents, categoryId: undefined, transfer: { counterAccountId: jnt.id, pairId: pair } }),
        f.txn({ id: f.tid("TX2"), accountId: jnt.id, date: "2026-01-05", amount: 100000 as Cents, categoryId: undefined, transfer: { counterAccountId: chk.id, pairId: pair } }),
      ],
    };
  }

  it("attributes income, cross-household transfers and assigned to the right household", () => {
    const p = computeProjection(twoHouseholds());
    const byHh = p.readyToAssignByHousehold("2026-01");
    // Personal: 300000 income − 100000 sent to Joint − 50000 assigned = 150000
    expect(byHh.get("Personal")).toBe(150000);
    // Joint: 100000 received − 40000 assigned = 60000
    expect(byHh.get("Joint")).toBe(60000);
  });

  it("orders households by the budget's householdOrder preference", () => {
    const b = twoHouseholds();
    // default: alphabetical -> Joint, Personal
    expect(computeProjection(b).households).toEqual(["Joint", "Personal"]);
    const reordered = { ...b, budget: { ...b.budget, householdOrder: ["Personal", "Joint"] } };
    expect(computeProjection(reordered).households).toEqual(["Personal", "Joint"]);
  });

  it("household breakdown sums to the global Ready to Assign", () => {
    const p = computeProjection(twoHouseholds());
    const byHh = p.readyToAssignByHousehold("2026-01");
    const sum = [...byHh.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBe(p.readyToAssignOf("2026-01"));
    expect(p.readyToAssignOf("2026-01")).toBe(210000);
  });
});

describe("uncategorized inflows", () => {
  it("counts a starting balance / uncategorized deposit as Ready to Assign", () => {
    const chk = f.account({ id: f.tid("ACHK"), name: "Checking", type: "checking" });
    const card = f.account({ id: f.tid("ACRD"), name: "Card", type: "creditCard" });
    const b: LoadedBudget = {
      budget: f.budget(),
      accounts: [chk, card],
      groups: [],
      categories: [],
      assignments: [],
      transactions: [
        // Uncategorized opening balance on the cash account → assignable.
        f.txn({ id: f.tid("TSB"), accountId: chk.id, date: "2026-01-01", amount: 25000 as Cents, categoryId: undefined }),
        // Uncategorized card opening balance (debt) → NOT income.
        f.txn({ id: f.tid("TCB"), accountId: card.id, date: "2026-01-01", amount: -9000 as Cents, categoryId: undefined }),
      ],
    };
    expect(computeProjection(b).readyToAssignOf("2026-01")).toBe(25000);
  });
});

// --- Property-based invariants ----------------------------------------------

describe("engine invariants (property-based)", () => {
  it("available(c,m) == max(0, available(c,m-1)) + assigned(c,m) + activity(c,m) (cash overspend resets)", () => {
    // With no credit cards, every overspend is cash overspend, so a negative
    // envelope never carries forward — it restarts at zero (the shortfall having
    // been pulled from Ready-to-Assign).
    fc.assert(
      fc.property(cashBudgetArb(), (b) => {
        const p = computeProjection(b);
        for (const c of b.categories) {
          let prev = 0;
          for (const m of p.months) {
            const expected = prev + p.assignedOf(c.id, m) + p.activityOf(c.id, m);
            if (p.availableOf(c.id, m) !== expected) return false;
            prev = Math.max(0, expected);
          }
        }
        return true;
      }),
    );
  });

  it("conserves money: Σ available + RTA == Σ on-budget balances (cash-only)", () => {
    fc.assert(
      fc.property(cashBudgetArb(), (b) => {
        const p = computeProjection(b);
        if (p.months.length === 0) return true;
        const last = p.months[p.months.length - 1]!;
        const v = p.monthView(last);
        const total = v.flat.reduce((a, c) => a + c.available, 0) + v.readyToAssign;
        const bal = p.accountBalances();
        let onBudget = 0;
        for (const acc of b.accounts) if (acc.onBudget) onBudget += bal.get(acc.id)!;
        return total === onBudget;
      }),
    );
  });
});

/**
 * Generates a simple cash-only budget: one checking account, an income category,
 * a few spending categories, random monthly assignments and transactions.
 */
function cashBudgetArb(): fc.Arbitrary<LoadedBudget> {
  const months = ["2026-01", "2026-02", "2026-03"];
  const catArb = fc.array(fc.constantFrom("CA", "CB", "CC"), { minLength: 1, maxLength: 3 });
  return fc
    .record({
      cats: catArb,
      incomes: fc.array(fc.record({ m: fc.constantFrom(...months), a: fc.integer({ min: 0, max: 500000 }) }), { maxLength: 6 }),
      assigns: fc.array(fc.record({ c: fc.constantFrom("CA", "CB", "CC"), m: fc.constantFrom(...months), a: fc.integer({ min: 0, max: 100000 }) }), { maxLength: 12 }),
      spends: fc.array(fc.record({ c: fc.constantFrom("CA", "CB", "CC"), m: fc.constantFrom(...months), a: fc.integer({ min: 0, max: 100000 }) }), { maxLength: 12 }),
    })
    .map(({ cats, incomes, assigns, spends }) => {
      const checking = f.account({ id: f.tid("ACHK"), name: "Checking", type: "checking" });
      const incomeGrp = f.group({ id: f.tid("GINC"), name: "Inflow", kind: "income", sortOrder: 0 });
      const spendGrp = f.group({ id: f.tid("GSPD"), name: "Spending", kind: "normal", sortOrder: 1 });
      const rta = f.category({ id: f.tid("CRTA"), groupId: incomeGrp.id, name: "Ready to Assign" });
      const uniqueCats = [...new Set(cats)];
      const known = new Set(uniqueCats);
      const categories = [rta, ...uniqueCats.map((c) => f.category({ id: f.tid(c), groupId: spendGrp.id, name: c }))];
      // Only reference categories that actually exist (imports guarantee this).
      assigns = assigns.filter((a) => known.has(a.c));
      spends = spends.filter((s) => known.has(s.c));

      let n = 0;
      const nid = (): ReturnType<typeof f.tid> => f.tid("TX" + (n++).toString(36));

      const transactions: Transaction[] = [];
      for (const inc of incomes) {
        transactions.push(f.txn({ id: nid(), accountId: checking.id, date: `${inc.m}-05`, amount: inc.a as Cents, categoryId: rta.id }));
      }
      for (const s of spends) {
        transactions.push(f.txn({ id: nid(), accountId: checking.id, date: `${s.m}-15`, amount: (-s.a) as Cents, categoryId: f.tid(s.c) }));
      }
      const assignments = assigns.map((a, i) =>
        f.assignment({ id: f.tid("AS" + i.toString(36)), month: a.m, categoryId: f.tid(a.c), assigned: a.a as Cents }),
      );

      return {
        budget: f.budget(),
        accounts: [checking],
        groups: [incomeGrp, spendGrp],
        categories,
        assignments,
        transactions,
      };
    });
}
