# Import anomaly classes (fixture checklist)

Derived from a read-only survey of the real export (report kept out of the repo).
This file lists the *generic* strangeness classes the import pipeline must handle;
each becomes a synthetic fixture + assertion. No real names, amounts, or data here.

1. **BOM + quoted commas** — CSV has a UTF-8 BOM and memos contain commas inside
   quotes. Must use a real CSV parser (covered by `csv.test.ts`).

2. **Signed amount folding** — exactly one of Outflow/Inflow is populated; fold into
   one signed value (inflow +, outflow −). `€0.00` on the opposite side is not data.

3. **Within-budget transfers** — payee `Transfer : <account>`, empty category, two
   mirrored legs. Dedupe to one transfer. Legs pair cleanly in practice.

4. **Same-day, different-amount transfer cluster** — several transfers between the
   same two accounts on one day with distinct amounts. Must pair by *exact amount*
   so they don't cross-match.

5. **Cross-budget stitch (plain-name payees)** — money moving between two source
   budgets is recorded independently on each side as a plain payee (NOT a
   `Transfer :`). Link payees are discovered statistically (equal absolute amount +
   date within a small window). Fixtures:
   - exact-date match, and off-by-1/2/3-day matches (all within window);
   - **repeated identical amounts** requiring *mutually-exclusive* pairing (the real
     ambiguity — "any candidate" over-counts);
   - a one-sided row with no counterpart → kept as a plain transaction, never a
     half-transfer;
   - an own-bank / coincidental payee with matching amount+date that must NOT be
     stitched (false positive).

6. **Cross-budget category collisions** — the two budgets share group names (and a
   trailing-whitespace category variant) with different children. Fold on
   `trim + lowercase`; keep sources distinct via a generic household label; never
   blind-merge.

7. **Exact-duplicate transactions** — identical (account, date, payee, amount, memo)
   rows. Disambiguate with a stable occurrence index so re-import stays idempotent.

8. **Empty-category non-transfer rows** — starting balances and uncategorized rows.
   Import as uncategorized (no category), don't drop.

9. **Future-dated rows** — scheduled entries dated after the export timestamp. Import
   normally.

10. **Income rows** — category "Ready to Assign" (group "Inflow"). Model as income,
    not a spending envelope.

11. **Plan is a dense grid** — every category × every month, mostly zeros. Import
    `Assigned` only; derive activity/available. Use the plan's own activity/available
    columns as a reconciliation oracle in tests.
