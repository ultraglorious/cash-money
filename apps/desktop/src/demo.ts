import {
  EUR,
  newId,
  SCHEMA_VERSION,
  type Account,
  type Category,
  type CategoryGroup,
  type Cents,
  type LoadedBudget,
  type MonthlyAssignment,
  type SplitLine,
  type Transaction,
  type TransferRef,
  type Ulid,
} from "@cash-money/core";

/**
 * A small, entirely synthetic budget (no real data) with two households so the
 * UI renders meaningfully in a plain browser. The real app loads the user's
 * merged budget through the Tauri file layer instead.
 */
export function demoBudget(): LoadedBudget {
  const checking = acc("Checking", "checking", "Personal");
  const card = acc("Visa", "creditCard", "Personal");
  const savings = acc("Savings", "tracking", "Personal", false);
  const joint = acc("Joint Account", "checking", "Joint");

  const gInflow = grp("Inflow", "income", "Personal");
  const gEveryday = grp("Everyday Expenses", "normal", "Personal");
  const gBills = grp("Monthly Bills", "normal", "Personal");
  const gCards = grp("Credit Card Payments", "creditCardPayments", "Personal");
  const gJoint = grp("Everyday Expenses", "normal", "Joint");
  const gJointFun = grp("Just for Fun", "normal", "Joint");

  const rta = cat("Ready to Assign", gInflow);
  const groceries = cat("Groceries", gEveryday);
  const dining = cat("Dining Out", gEveryday);
  const fun = cat("Fun Money", gEveryday);
  const rent = cat("Rent", gBills);
  const phone = cat("Phone", gBills);
  const cardPay = cat("Visa", gCards);
  cardPay.linkedAccountId = card.id;
  const jGroceries = cat("Groceries", gJoint);
  const jDining = cat("Dining Out", gJoint);
  const jLux = cat("Luxuries", gJointFun);

  const categories = [rta, groceries, dining, fun, rent, phone, cardPay, jGroceries, jDining, jLux];

  const tx: Transaction[] = [];
  const push = (t: {
    accountId: Ulid;
    date: string;
    amount: number;
    payee?: string;
    memo?: string;
    categoryId?: Ulid;
    splits?: SplitLine[];
    transfer?: TransferRef;
    approved?: boolean;
  }): void => {
    tx.push({
      id: newId(),
      accountId: t.accountId,
      date: t.date,
      effectiveDate: t.date,
      payee: t.payee ?? "",
      memo: t.memo ?? "",
      amount: t.amount as Cents,
      cleared: "cleared",
      approved: t.approved ?? true,
      ...(t.categoryId ? { categoryId: t.categoryId } : {}),
      ...(t.splits ? { splits: t.splits } : {}),
      ...(t.transfer ? { transfer: t.transfer } : {}),
    });
  };

  // January — Personal
  push({ accountId: checking.id, date: "2026-01-02", payee: "Employer", amount: 320000, categoryId: rta.id });
  push({ accountId: checking.id, date: "2026-01-03", payee: "Landlord", amount: -120000, categoryId: rent.id });
  push({ accountId: card.id, date: "2026-01-06", payee: "Supermarket", amount: -8450, categoryId: groceries.id });
  push({ accountId: card.id, date: "2026-01-11", payee: "Trattoria", amount: -4200, categoryId: dining.id });
  push({ accountId: checking.id, date: "2026-01-15", payee: "Telco", amount: -2500, categoryId: phone.id });
  push({
    accountId: checking.id, date: "2026-01-20", payee: "Market", amount: -6000,
    splits: [
      { id: newId(), categoryId: groceries.id, amount: -3500 as Cents, memo: "food" },
      { id: newId(), categoryId: fun.id, amount: -2500 as Cents, memo: "flowers" },
    ],
  });
  // January — fund the Joint account (Personal -> Joint transfer) + Joint spend
  const jan = newId();
  push({ accountId: checking.id, date: "2026-01-04", payee: "Joint Account", amount: -150000, transfer: { counterAccountId: joint.id, pairId: jan } });
  push({ accountId: joint.id, date: "2026-01-04", payee: "Checking", amount: 150000, transfer: { counterAccountId: checking.id, pairId: jan } });
  push({ accountId: joint.id, date: "2026-01-12", payee: "Grocer", amount: -42000, categoryId: jGroceries.id });
  push({ accountId: joint.id, date: "2026-01-18", payee: "Bistro", amount: -9800, categoryId: jDining.id });

  // February — Personal (pay the card) + Joint funding
  const payoff = newId();
  push({ accountId: checking.id, date: "2026-02-01", payee: "Employer", amount: 320000, categoryId: rta.id });
  push({ accountId: checking.id, date: "2026-02-10", payee: "Transfer : Visa", amount: -12650, transfer: { counterAccountId: card.id, pairId: payoff } });
  push({ accountId: card.id, date: "2026-02-10", payee: "Transfer : Checking", amount: 12650, transfer: { counterAccountId: checking.id, pairId: payoff } });
  push({ accountId: card.id, date: "2026-02-14", payee: "Cafe", amount: -1800, categoryId: dining.id });
  push({ accountId: savings.id, date: "2026-02-15", payee: "Broker", amount: -50000, memo: "off-budget" });
  const feb = newId();
  push({ accountId: checking.id, date: "2026-02-05", payee: "Joint Account", amount: -150000, transfer: { counterAccountId: joint.id, pairId: feb } });
  push({ accountId: joint.id, date: "2026-02-05", payee: "Checking", amount: 150000, transfer: { counterAccountId: checking.id, pairId: feb } });
  push({ accountId: joint.id, date: "2026-02-16", payee: "Wine Bar", amount: -6400, categoryId: jLux.id });
  // A scheduled (future) transaction
  push({ accountId: checking.id, date: "2026-09-01", payee: "Gym", amount: -3900, categoryId: fun.id, approved: false });

  const assign: MonthlyAssignment[] = [
    asg("2026-01", groceries, 20000),
    asg("2026-01", dining, 8000),
    asg("2026-01", fun, 5000),
    asg("2026-01", rent, 120000),
    asg("2026-01", phone, 2500),
    asg("2026-01", cardPay, 12650),
    asg("2026-01", jGroceries, 60000),
    asg("2026-01", jDining, 5000),
    asg("2026-02", groceries, 20000),
    asg("2026-02", dining, 8000),
    asg("2026-02", rent, 120000),
    asg("2026-02", jLux, 10000),
  ];

  return {
    budget: { id: newId(), name: "Demo Household", currency: EUR, createdAt: "2026-01-01", schemaVersion: SCHEMA_VERSION },
    accounts: [checking, card, savings, joint],
    groups: [gInflow, gEveryday, gBills, gCards, gJoint, gJointFun],
    categories,
    assignments: assign,
    transactions: tx,
  };
}

let order = 0;
function acc(name: string, type: Account["type"], household: string, onBudget = true): Account {
  return { id: newId(), name, type, onBudget, closed: false, sortOrder: order++, household };
}
function grp(name: string, kind: CategoryGroup["kind"], household: string): CategoryGroup {
  return { id: newId(), name, kind, household, sortOrder: order++, hidden: false };
}
function cat(name: string, group: CategoryGroup): Category {
  return { id: newId(), groupId: group.id, name, sortOrder: order++, hidden: false };
}
function asg(month: string, category: Category, assigned: number): MonthlyAssignment {
  return { id: newId(), month, categoryId: category.id, assigned: assigned as Cents };
}
