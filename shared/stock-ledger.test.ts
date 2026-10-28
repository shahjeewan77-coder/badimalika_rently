import { describe, expect, it } from "vitest";
import { buildMovementReport, compareMovements, type LedgerMovement } from "./stock-ledger";

/**
 * The running balance is the one thing in the stock movement report that can be
 * silently wrong while looking plausible — especially once a date range is
 * applied, because the natural (and wrong) implementation restarts the balance
 * at zero on the first row in range. These tests pin the correct behaviour.
 */

function mv(partial: Partial<LedgerMovement> & { dateAd: string; type: "in" | "out"; qty: number }): LedgerMovement {
  return {
    id: partial.id ?? `${partial.dateAd}-${partial.type}-${partial.qty}`,
    dateBs: partial.dateBs ?? "2083-01-01",
    orderNo: partial.orderNo ?? null,
    invoiceNo: partial.invoiceNo ?? null,
    customerName: partial.customerName ?? null,
    personName: partial.personName ?? null,
    personRole: partial.personRole ?? null,
    createdAt: partial.createdAt ?? `${partial.dateAd}T10:00:00.000Z`,
    ...partial,
  } as LedgerMovement;
}

describe("buildMovementReport — full history, no range", () => {
  it("reconciles opening + in − out and ends at closingOnHand", () => {
    const r = buildMovementReport({
      openingBase: 100,
      closingOnHand: 94, // 100 − 6 out
      movements: [
        mv({ dateAd: "2026-10-01", type: "out", qty: 10 }),
        mv({ dateAd: "2026-10-05", type: "in", qty: 4 }),
      ],
    });
    expect(r.opening).toBe(100);
    expect(r.totalIn).toBe(4);
    expect(r.totalOut).toBe(10);
    expect(r.closing).toBe(94);
    expect(r.drift).toBe(0);
    expect(r.rows.map((x) => x.balance)).toEqual([90, 94]);
  });

  it("orders oldest first even when input is newest first", () => {
    const r = buildMovementReport({
      openingBase: 10,
      closingOnHand: 10,
      movements: [
        mv({ id: "b", dateAd: "2026-10-09", type: "in", qty: 3 }),
        mv({ id: "a", dateAd: "2026-10-02", type: "out", qty: 3 }),
      ],
    });
    expect(r.rows.map((x) => x.id)).toEqual(["a", "b"]);
    expect(r.rows.map((x) => x.balance)).toEqual([7, 10]);
  });

  it("keeps same-day movements in the order they were recorded", () => {
    const r = buildMovementReport({
      openingBase: 5,
      closingOnHand: 5,
      movements: [
        mv({ id: "late", dateAd: "2026-10-02", type: "in", qty: 2, createdAt: "2026-10-02T15:00:00.000Z" }),
        mv({ id: "early", dateAd: "2026-10-02", type: "out", qty: 2, createdAt: "2026-10-02T09:00:00.000Z" }),
      ],
    });
    expect(r.rows.map((x) => x.id)).toEqual(["early", "late"]);
    expect(r.rows.map((x) => x.balance)).toEqual([3, 5]);
  });
});

describe("buildMovementReport — date range", () => {
  const movements = [
    mv({ id: "sep-out", dateAd: "2026-09-28", type: "out", qty: 10 }),
    mv({ id: "oct-1-out", dateAd: "2026-10-01", type: "out", qty: 5 }),
    mv({ id: "oct-3-in", dateAd: "2026-10-03", type: "in", qty: 2 }),
    mv({ id: "oct-9-out", dateAd: "2026-10-09", type: "out", qty: 1 }),
  ];

  it("rolls pre-range movements into the opening balance", () => {
    const r = buildMovementReport({
      openingBase: 100,
      closingOnHand: 86, // 100 − 10 − 5 + 2 − 1
      movements,
      fromAd: "2026-10-01",
      toAd: "2026-10-31",
    });
    // September's 10 out is BEFORE the range, so opening is 90 — not 100, and
    // not 0. This is the bug this test exists for.
    expect(r.opening).toBe(90);
    expect(r.rows.map((x) => x.id)).toEqual(["oct-1-out", "oct-3-in", "oct-9-out"]);
    expect(r.rows.map((x) => x.balance)).toEqual([85, 87, 86]);
    expect(r.totalIn).toBe(2);
    expect(r.totalOut).toBe(6);
    // closing must land on the real on-hand quantity, not a range-relative one
    expect(r.closing).toBe(86);
    expect(r.closing).toBe(Math.round((r.opening + r.totalIn - r.totalOut) * 100) / 100);
  });

  it("a single-day range opens at the position before that day", () => {
    const r = buildMovementReport({
      openingBase: 100,
      closingOnHand: 86,
      movements,
      fromAd: "2026-10-03",
      toAd: "2026-10-03",
    });
    expect(r.opening).toBe(85); // after Sep 28 (−10) and Oct 1 (−5)
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].balance).toBe(87);
    expect(r.closing).toBe(87);
  });

  it("a range with no movements keeps the opening it computed", () => {
    const r = buildMovementReport({
      openingBase: 100,
      closingOnHand: 86,
      movements,
      fromAd: "2026-11-01",
      toAd: "2026-11-30",
    });
    expect(r.rows).toHaveLength(0);
    expect(r.opening).toBe(86); // everything happened before the range
    expect(r.closing).toBe(86);
    expect(r.totalIn).toBe(0);
    expect(r.totalOut).toBe(0);
  });

  it("an open-ended range (no From) still opens at the baseline", () => {
    const r = buildMovementReport({
      openingBase: 100,
      closingOnHand: 86,
      movements,
      toAd: "2026-10-03",
    });
    expect(r.opening).toBe(100);
    expect(r.rows.map((x) => x.id)).toEqual(["sep-out", "oct-1-out", "oct-3-in"]);
    expect(r.closing).toBe(87);
  });

  it("the last in-range balance equals the stated closing balance", () => {
    const r = buildMovementReport({
      openingBase: 100,
      closingOnHand: 86,
      movements,
      fromAd: "2026-10-01",
      toAd: "2026-10-31",
    });
    expect(r.rows[r.rows.length - 1].balance).toBe(r.closing);
  });
});

describe("buildMovementReport — drift detection", () => {
  it("reports zero drift when the log agrees with stock", () => {
    const r = buildMovementReport({
      openingBase: 12,
      closingOnHand: 11,
      movements: [mv({ dateAd: "2026-10-17", type: "out", qty: 1 })],
    });
    expect(r.drift).toBe(0);
  });

  it("reports the exact difference when the log does NOT agree", () => {
    const r = buildMovementReport({
      openingBase: 12,
      closingOnHand: 5, // stock says 5, log says 11
      movements: [mv({ dateAd: "2026-10-17", type: "out", qty: 1 })],
    });
    expect(r.closingAll).toBe(11);
    expect(r.drift).toBe(6);
  });
});

describe("compareMovements", () => {
  it("sorts by day then by timestamp", () => {
    const a = mv({ id: "a", dateAd: "2026-10-01", type: "out", qty: 1, createdAt: "2026-10-01T08:00:00.000Z" });
    const b = mv({ id: "b", dateAd: "2026-10-02", type: "out", qty: 1, createdAt: "2026-10-02T08:00:00.000Z" });
    expect(compareMovements(a, b)).toBeLessThan(0);
    expect(compareMovements(b, a)).toBeGreaterThan(0);
    expect(compareMovements(a, a)).toBe(0);
  });
});
