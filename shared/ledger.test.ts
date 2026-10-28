// The customer ledger is the one place money is added up, so its arithmetic is
// pinned here rather than left to a screenshot. Every case is expressed as the
// rule the business stated: invoices INCREASE the due, receipts DECREASE it.
import { describe, expect, it } from "vitest";
import { buildLedger, closingDue } from "./ledger";

const inv = (id: string, total: number, dateAd = "2026-10-01") => ({
  id,
  number: `INV-2083-000${id.slice(-1)}`,
  dateAd,
  dateBs: "2083-06-15",
  total,
});

const rec = (id: string, amount: number, dateAd = "2026-10-02") => ({
  id,
  amount,
  dateAd,
  dateBs: "2083-06-16",
  description: "Receipt (cash)",
});

describe("buildLedger — customer ledger maths", () => {
  it("starts from the opening balance and increases the due with every invoice", () => {
    const { rows, totals } = buildLedger(5000, [inv("i1", 22500, "2026-10-01")], []);

    expect(totals.openingBalance).toBe(5000);
    expect(totals.totalInvoiced).toBe(22500);
    expect(totals.totalReceived).toBe(0);
    expect(totals.closingDue).toBe(27500);
    expect(rows).toHaveLength(1);
    expect(rows[0].debit).toBe(22500);
    expect(rows[0].running).toBe(27500);
  });

  it("decreases the due when a receipt is recorded", () => {
    const { totals } = buildLedger(0, [inv("i1", 22500, "2026-10-01")], [rec("r1", 10000, "2026-10-02")]);

    expect(totals.totalInvoiced).toBe(22500);
    expect(totals.totalReceived).toBe(10000);
    expect(totals.closingDue).toBe(12500);
  });

  it("carries a running balance through several entries in date order", () => {
    const { rows, totals } = buildLedger(
      1000,
      [inv("i1", 5000, "2026-10-01"), inv("i2", 7000, "2026-10-05")],
      [rec("r1", 3000, "2026-10-03"), rec("r2", 2000, "2026-10-06")],
    );

    // 1000 → +5000 = 6000 → −3000 = 3000 → +7000 = 10000 → −2000 = 8000
    expect(rows.map((r) => r.running)).toEqual([6000, 3000, 10000, 8000]);
    expect(rows.map((r) => r.kind)).toEqual(["invoice", "receipt", "invoice", "receipt"]);
    expect(totals.closingDue).toBe(8000);
  });

  it("sorts a same-day invoice before a same-day receipt, so the payment pays that bill", () => {
    const { rows } = buildLedger(0, [inv("i1", 4000, "2026-10-01")], [rec("r1", 4000, "2026-10-01")]);

    expect(rows.map((r) => r.kind)).toEqual(["invoice", "receipt"]);
    expect(rows[0].running).toBe(4000); // the bill lands first…
    expect(rows[1].running).toBe(0); // …then the payment clears it
  });

  it("goes to zero when receipts exactly cover the invoices, and negative when overpaid", () => {
    expect(closingDue(0, [inv("i1", 22500)], [rec("r1", 22500)])).toBe(0);
    // An advance payment (receipt larger than the bill) leaves a credit balance,
    // which is the honest reading — the customer is owed, not owing.
    expect(closingDue(0, [inv("i1", 100)], [rec("r1", 500)])).toBe(-400);
  });

  it("equals the opening balance when there are no entries at all", () => {
    const { rows, totals } = buildLedger(7500, [], []);
    expect(rows).toEqual([]);
    expect(totals.closingDue).toBe(7500);
  });

  it("rounds to paisa so float error cannot drift the balance", () => {
    const { totals } = buildLedger(0.1, [inv("i1", 0.2)], [rec("r1", 0.05)]);
    expect(totals.closingDue).toBe(0.25);
  });

  it("places an undated-later entry after earlier ones regardless of input order", () => {
    const { rows } = buildLedger(
      0,
      [inv("i9", 100, "2026-10-31")],
      [rec("r1", 50, "2026-10-01")],
    );
    expect(rows.map((r) => r.dateAd)).toEqual(["2026-10-01", "2026-10-31"]);
  });
});
