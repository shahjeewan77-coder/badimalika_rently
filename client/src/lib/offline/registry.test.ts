import { describe, expect, it } from "vitest";
import {
  bumpSummary,
  classifyFlushError,
  collectRefs,
  conflictPolicy,
  decideQueue,
  describeAction,
  dueAfterReceipt,
  hasUnresolvedRefs,
  isLocalId,
  ledgerEditsForRemoval,
  makeLocalId,
  newReceiptRow,
  optimisticCustomerName,
  optimisticItems,
  patchLedgerEntries,
  statusFilterOf,
  substituteRefs,
  summaryKeyFor,
  type PatchContext,
} from "./registry";
import { queryCacheKey, unwrapCached } from "./idb";
import { deriveVerifier, verifyPassword, type OfflineSession } from "./session";

function context(overrides: Partial<PatchContext> = {}): PatchContext {
  return {
    localId: "pending-abc",
    nowIso: "2026-10-10T09:00:00.000Z",
    dateAd: "2026-10-10",
    dateBs: "2083-06-24",
    userId: "u1",
    role: "owner",
    driverId: null,
    driverName: null,
    input: {},
    result: null,
    meta: {},
    lookups: { equipment: new Map(), customers: new Map() },
    ...overrides,
  };
}

describe("which writes may be queued offline", () => {
  it("queues the business writes the user owns", () => {
    for (const path of [
      "orders.create",
      "orders.approve",
      "orders.dispatch",
      "receipts.create",
      "customers.create",
      "assignments.setMine",
    ]) {
      expect(decideQueue(path, false)).toBe("queue");
    }
  });

  it("refuses — rather than queues — anything that only means something live", () => {
    // A reset code is mailed for one session; replaying it later is meaningless.
    for (const path of ["auth.login", "auth.signup", "auth.requestPasswordReset", "auth.resetPassword"]) {
      expect(decideQueue(path, false)).toBe("reject-offline");
    }
  });

  it("sends everything normally while online", () => {
    expect(decideQueue("auth.login", true)).toBe("send");
    expect(decideQueue("orders.create", true)).toBe("send");
  });

  it("refuses an unknown procedure offline instead of pretending it saved", () => {
    expect(decideQueue("something.new", false)).toBe("reject-offline");
  });

  it("sends a tracking ping while online instead of queueing it", () => {
    // The regression this pins: `decideQueue` takes ONLINE, but the mutation link
    // once passed `isOffline()`, inverting every decision. A queueable write was
    // therefore parked in the outbox while the app was online — and because the
    // retry only ran on an offline→online transition, it stayed there. That is
    // how a driver's location ping could sit unsent for an entire trip while the
    // owner's map showed nothing.
    expect(decideQueue("tracking.ping", true)).toBe("send");
    expect(decideQueue("tracking.ping", false)).toBe("queue");
  });
});

describe("conflict policy", () => {
  it("lets the server win on state transitions it guards", () => {
    for (const path of ["orders.approve", "orders.lock", "orders.dispatch", "orders.return", "orders.update"]) {
      expect(conflictPolicy(path)).toBe("server");
    }
  });

  it("lets the client win on records it creates", () => {
    for (const path of ["orders.create", "customers.create", "receipts.create", "assignments.setMine"]) {
      expect(conflictPolicy(path)).toBe("client");
    }
  });
});

describe("classifying a failed replay", () => {
  it("retries on anything that is only a connection or transient server problem", () => {
    expect(classifyFlushError(null, null)).toBe("retry"); // no response at all
    expect(classifyFlushError("INTERNAL_SERVER_ERROR", 500)).toBe("retry");
    expect(classifyFlushError("TOO_MANY_REQUESTS", 429)).toBe("retry");
    expect(classifyFlushError("WHATEVER", 0)).toBe("retry");
    expect(classifyFlushError("WHATEVER", 503)).toBe("retry");
  });

  it("treats a refusal by the server as a conflict", () => {
    expect(classifyFlushError("BAD_REQUEST", 400)).toBe("conflict");
    expect(classifyFlushError("NOT_FOUND", 404)).toBe("conflict");
    expect(classifyFlushError("CONFLICT", 409)).toBe("conflict");
    expect(classifyFlushError("FORBIDDEN", 403)).toBe("conflict");
  });
});

describe("local ids and references", () => {
  it("recognises a local id and finds it anywhere in a nested input", () => {
    const localId = makeLocalId("11111111-2222-3333-4444-555555555555");
    expect(isLocalId(localId)).toBe(true);
    expect(isLocalId("real-id")).toBe(false);

    const input = {
      id: "real-order",
      customerId: localId,
      items: [{ equipmentId: "eq-1" }, { equipmentId: "eq-2", parent: { ref: localId } }],
    };
    expect(collectRefs(input).sort()).toEqual([localId]);
    expect(hasUnresolvedRefs(input, {})).toBe(true);
  });

  it("substitutes a resolved id everywhere, leaving the rest alone", () => {
    const localId = makeLocalId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    const out = substituteRefs(
      { customerId: localId, items: [{ equipmentId: "eq-1", customerId: localId }] },
      { [localId]: "cust-real" },
    ) as { customerId: string; items: Array<{ customerId: string }> };
    expect(out.customerId).toBe("cust-real");
    expect(out.items[0].customerId).toBe("cust-real");
    expect(hasUnresolvedRefs(out, { [localId]: "cust-real" })).toBe(false);
  });
});

describe("the cache key a query is stored under", () => {
  it("is stable regardless of key order, so a cached reply can always be found", () => {
    expect(queryCacheKey("orders.list", { status: "pending", page: 2 })).toBe(
      queryCacheKey("orders.list", { page: 2, status: "pending" }),
    );
  });

  it("lets a cached reply be unwrapped safely, including one with its own data field", () => {
    expect(unwrapCached({ __cached: true, data: { data: [1, 2] } })).toEqual({ data: [1, 2] });
    expect(unwrapCached(42)).toBe(42);
  });

  it("reads the status filter back out of a list key", () => {
    expect(statusFilterOf(queryCacheKey("orders.list", { status: "pending_approval" }))).toBe("pending_approval");
    expect(statusFilterOf(queryCacheKey("orders.list", {}))).toBeNull();
  });
});

describe("the dashboard pipeline counters", () => {
  it("moves an order without changing the total", () => {
    const start = { orders: { total: 3, pending: 2, approved: 1 } };
    const afterOut = bumpSummary(start, "pending", -1);
    const moved = bumpSummary(afterOut, "approved", 1);
    expect(moved?.orders).toEqual({ total: 3, pending: 1, approved: 2 });
  });

  it("counts a brand-new order in both its status and the total", () => {
    const start = { orders: { total: 0, pending: 0 } };
    expect(bumpSummary(start, "pending", 1)?.orders).toEqual({ total: 1, pending: 1 });
  });

  it("never goes negative if a refresh and a local move disagree", () => {
    expect(bumpSummary({ orders: { total: 0, pending: 0 } }, "pending", -1)?.orders).toEqual({ total: 0, pending: 0 });
  });

  it("maps every status onto a counter", () => {
    expect(summaryKeyFor("pending_approval")).toBe("pending");
    expect(summaryKeyFor("on_transit")).toBe("onTransit");
    expect(summaryKeyFor("on_rent")).toBe("onRent");
    expect(summaryKeyFor("dispatched")).toBe("onRent");
  });
});

describe("customer ledger maths", () => {
  const ledger = {
    customer: { id: "c1" },
    rows: [
      { id: "inv1", kind: "invoice" as const, description: "Sales invoice INV-0001", dateAd: "2026-10-01", dateBs: "2083-06-15", debit: 1000, credit: 0, balance: 1000 },
      { id: "rc1", kind: "receipt" as const, description: "Receipt (cash)", dateAd: "2026-10-02", dateBs: "2083-06-16", debit: 0, credit: 200, balance: 800 },
    ],
    totals: { openingBalance: 0, totalInvoiced: 1000, totalReceived: 200, closingDue: 800 },
  };

  it("a receipt reduces the due by exactly its amount", () => {
    const next = patchLedgerEntries(
      ledger,
      [{ kind: "receipt", id: "rc2", amount: 300, dateAd: "2026-10-05", dateBs: "2083-06-19", description: "Receipt (bank)" }],
      false,
    );
    expect(next?.totals.totalReceived).toBe(500);
    expect(next?.totals.closingDue).toBe(500);
  });

  it("a new invoice increases the due, which is what an offline dispatch produces", () => {
    const next = patchLedgerEntries(
      ledger,
      [{ kind: "invoice", id: "inv2", amount: 2500, dateAd: "2026-10-06", dateBs: "2083-06-20", description: "INV-0002" }],
      false,
    );
    expect(next?.totals.totalInvoiced).toBe(3500);
    expect(next?.totals.closingDue).toBe(3300);
  });

  it("removing an entry takes its amount back out", () => {
    const next = patchLedgerEntries(ledger, [{ kind: "receipt", id: "rc1", amount: 200, dateAd: "2026-10-02", dateBs: "2083-06-16", description: "x" }], true);
    expect(next?.totals.closingDue).toBe(1000);
  });

  it("recovers what to remove from the ledger row itself", () => {
    expect(ledgerEditsForRemoval(ledger, "rc1")).toEqual([
      { kind: "receipt", id: "rc1", amount: 200, dateAd: "2026-10-02", dateBs: "2083-06-16", description: "Receipt (cash)" },
    ]);
  });

  it("applies a single receipt delta to a due figure", () => {
    expect(dueAfterReceipt(22500, 10000, false)).toBe(12500);
    expect(dueAfterReceipt(12500, 10000, true)).toBe(22500);
  });
});

describe("optimistic rows the user sees before the server replies", () => {
  it("computes a line from BILLED qty, not actual qty", () => {
    const ctx = context({
      input: {
        items: [{ equipmentId: "eq1", basis: "pillar", rate: 1200, units: 1, actualQty: 6, billedQty: 5 }],
      },
    });
    ctx.lookups.equipment.set("eq1", { name: "Steel Pillar", code: "SP-1", unit: "pcs" });
    const items = optimisticItems(ctx);
    expect(items[0].lineAmount).toBe(6000); // 1200 × 1 × 5
    expect(items[0].actualQty).toBe(6); // the stock figure is kept separate
    expect(items[0].equipmentName).toBe("Steel Pillar");
  });

  it("names the customer from the inline new-customer the driver typed", () => {
    // The driver created the customer inline, so the order points at a LOCAL id
    // and carries the typed name — that is what has to be shown before sync.
    expect(
      optimisticCustomerName(context({ input: { customerId: "pending-new-cust", __newCustomerName: "Himalaya Builders" } })),
    ).toBe("Himalaya Builders");
  });

  it("falls back to the cached customer list for an existing customer", () => {
    const ctx = context({ input: { customerId: "c1" } });
    ctx.lookups.customers.set("c1", "Everest Construction");
    expect(optimisticCustomerName(ctx)).toBe("Everest Construction");
  });

  it("builds a receipt row that carries its Bikram Sambat date", () => {
    const row = newReceiptRow(context({ input: { customerId: "c1", amount: 500, mode: "mobile" } }));
    expect(row.amount).toBe(500);
    expect(row.dateBs).toBe("2083-06-24");
    expect(row.pendingSync).toBe(true);
  });
});

describe("labels shown on the sync page", () => {
  it("describe the action in words the owner recognises", () => {
    expect(describeAction("orders.approve")).toBe("Approve order");
    expect(describeAction("receipts.create")).toBe("Record receipt");
    expect(describeAction("orders.create", {}, { customerName: "Himalaya Builders" })).toBe(
      "New order — Himalaya Builders",
    );
  });
});

describe("the offline password verifier", () => {
  it("accepts the right password and rejects the wrong one", async () => {
    const verifier = await deriveVerifier("user-1", "Rent@2026");
    expect(verifier).toBeTruthy();
    const session = { userId: "user-1", verifier } as OfflineSession;
    expect(await verifyPassword(session, "Rent@2026")).toBe(true);
    expect(await verifyPassword(session, "rent@2026")).toBe(false);
  });

  it("is salted per user, so the same password yields a different verifier", async () => {
    const a = await deriveVerifier("user-1", "same-password");
    const b = await deriveVerifier("user-2", "same-password");
    expect(a).not.toBe(b);
  });

  it("cannot be used when no verifier was stored (no WebCrypto)", async () => {
    expect(await verifyPassword({ userId: "u", verifier: null } as OfflineSession, "anything")).toBe(false);
  });
});
