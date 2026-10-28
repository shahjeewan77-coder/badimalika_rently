import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { makeCaller } from "./_core/test-caller";

// Full rationale for what gets mocked below (and why ./_core/trpc doesn't
// need to be) lives on server/_core/test-caller.ts, next to makeCaller —
// mock every _core module routers.ts touches.
vi.mock("./_core/auth", () => {
  class AuthError extends Error {}
  return {
    authProvider: vi.fn(() => ({ login: vi.fn(), logout: vi.fn(), getSession: vi.fn() })),
    registerLocalUser: vi.fn(),
    AuthError,
    EmailTakenError: class EmailTakenError extends AuthError {},
  };
});

vi.mock("./_core/storage", () => ({
  storageCommit: vi.fn(),
  storageDeleteOwned: vi.fn(),
  storageListByOwner: vi.fn(),
  storagePutUrl: vi.fn(),
  StorageError: class StorageError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
}));

// routers.ts now imports ./services/smtp-mail, which reads SMTP config through
// ./_core/env — and env.ts calls required("DATABASE_URL") at module load. Mocking
// the mailer keeps the env layer out of the test entirely and lets a test drive
// both the "sent" and the "SMTP not configured" paths.
vi.mock("./services/smtp-mail", () => ({
  sendMail: vi.fn(async () => ({ sent: true, status: "sent" as const })),
  otpEmail: vi.fn(() => ({ text: "code", html: "<p>code</p>" })),
  smtpConfigured: vi.fn(() => true),
}));

// Every function routers.ts imports from ./db must exist on the mock, or a
// procedure that calls one throws "not a function" and surfaces as a 500.
vi.mock("./db", () => ({
  getProfile: vi.fn(),
  accountIdFor: vi.fn(),
  countOwners: vi.fn(),
  ensureOwnerProfile: vi.fn(),
  createDriverProfile: vi.fn(),
  listProfiles: vi.fn(),
  resolveLoginEmail: vi.fn(),
  isUsernameTaken: vi.fn(),
  listCustomers: vi.fn(),
  createCustomer: vi.fn(),
  listVehicles: vi.fn(),
  listActiveVehicles: vi.fn(),
  createVehicle: vi.fn(),
  findVehicleByNumber: vi.fn(),
  editVehicleRow: vi.fn(),
  getVehicle: vi.fn(),
  reactivateVehicle: vi.fn(),
  deactivateVehicle: vi.fn(),
  listDrivers: vi.fn(),
  listActiveDrivers: vi.fn(),
  driverDeleteSummary: vi.fn(),
  deactivateDriver: vi.fn(),
  reactivateDriver: vi.fn(),
  editDriverRow: vi.fn(),
  getDriver: vi.fn(),
  findDriverByPhone: vi.fn(),
  createDriverRow: vi.fn(),
  linkDriverUser: vi.fn(),
  getDriverByUserId: vi.fn(),
  getAssignment: vi.fn(),
  upsertAssignment: vi.fn(),
  listAssignmentsForDate: vi.fn(),
  listRecentAssignments: vi.fn(),
  listEquipment: vi.fn(),
  createEquipment: vi.fn(),
  updateEquipment: vi.fn(),
  listStockMovements: vi.fn(),
  createOrder: vi.fn(),
  listOrders: vi.fn(),
  getOrder: vi.fn(),
  setOrderStatus: vi.fn(),
  lockOrderForDispatch: vi.fn(),
  dispatchOrder: vi.fn(),
  returnOrder: vi.fn(),
  undoLockForDispatch: vi.fn(),
  undoReturnFromCustomer: vi.fn(),
  listOnRent: vi.fn(),
  listInvoices: vi.fn(),
  dashboardSummary: vi.fn(),
  seedDemoData: vi.fn(),
  updatePendingOrder: vi.fn(),
  customerDueMap: vi.fn(),
  getCustomerLedger: vi.fn(),
  setCustomerOpeningBalance: vi.fn(),
  createReceipt: vi.fn(),
  listReceipts: vi.fn(),
  deleteReceipt: vi.fn(),
  findUserByEmail: vi.fn(),
  countResetRequestsForUser: vi.fn(),
  countResetRequestsForIp: vi.fn(),
  latestResetRequestForIp: vi.fn(),
  createResetCode: vi.fn(),
  activeResetCode: vi.fn(),
  bumpResetAttempts: vi.fn(),
  consumeResetCode: vi.fn(),
  setUserPassword: vi.fn(),
  adIsoToBs: vi.fn(),
  bsIso: vi.fn(),
  // ── owner admin surface (edit/delete anywhere + audit trail) ──
  // (`getProfile` is already mocked above — it is what `requireOwner` reads.)
  writeAuditLog: vi.fn(),
  listAuditLog: vi.fn(),
  orderCascadeSummary: vi.fn(),
  deleteOrder: vi.fn(),
  editOrderAnyStage: vi.fn(),
  customerCascadeSummary: vi.fn(),
  deleteCustomer: vi.fn(),
  editCustomer: vi.fn(),
  equipmentCascadeSummary: vi.fn(),
  deleteEquipment: vi.fn(),
  editEquipmentAnyStage: vi.fn(),
  vehicleCascadeSummary: vi.fn(),
  deleteVehicle: vi.fn(),
  invoiceCascadeSummary: vi.fn(),
  deleteInvoice: vi.fn(),
  editInvoice: vi.fn(),
  editReceipt: vi.fn(),
  userCascadeSummary: vi.fn(),
  deleteUser: vi.fn(),
  editUser: vi.fn(),
}));

const { sanitizeBasename } = await import("./routers");
const db = await import("./db");
const { storageDeleteOwned, StorageError } = await import("./_core/storage");
const { registerLocalUser, EmailTakenError } = await import("./_core/auth");

// C1c: uploadUrl's key is `${uuid}-${sanitizeBasename(name)}`. The uuid prefix
// only makes the key unguessable if the REST of the key isn't
// attacker-controlled — sanitizeBasename is what stops a caller-supplied
// `name` like "/../report.pdf" from steering path segments into someone
// else's key (which canonicalKey in storage.ts would then reject outright,
// but the point of sanitizing here is to never construct that key at all).
describe("sanitizeBasename", () => {
  it("passes a normal filename through unchanged", () => {
    expect(sanitizeBasename("report.pdf")).toBe("report.pdf");
  });

  it("takes only the last path segment, dropping any directory traversal", () => {
    expect(sanitizeBasename("/../report.pdf")).toBe("report.pdf");
    expect(sanitizeBasename("a/b/../evil.png")).toBe("evil.png");
    expect(sanitizeBasename("../../etc/passwd")).toBe("passwd");
  });

  it("strips characters outside [A-Za-z0-9._-]", () => {
    expect(sanitizeBasename("my file (final)!.png")).toBe("myfilefinal.png");
    expect(sanitizeBasename("héllo.png")).toBe("hllo.png");
  });

  it("collapses leading dots so a bare '.' or '..' basename can't survive", () => {
    expect(sanitizeBasename("..")).toBe("upload");
    expect(sanitizeBasename(".")).toBe("upload");
    // "upload.hidden", not "hidden": the leading dots are still gone (that is
    // the security property), but the last dot is now read as the extension
    // separator rather than deleted along with them.
    expect(sanitizeBasename("...hidden")).toBe("upload.hidden");
  });

  // Regression (observed 2026-08, published app gallery-app-gpkd51ak): a file
  // named 风景.png landed in storage as "<uuid>-png" — no dot, no extension.
  // Two rules compounded. The allowlist is ASCII-only, so a stem written
  // entirely in CJK is deleted, leaving ".png"; the leading-dot strip that
  // follows then ate the dot, because by that point the only dot left in the
  // string is the extension separator, not a dotfile prefix.
  //
  // The trigger is a stem with NO surviving ASCII, which is the common case for
  // Chinese/Japanese/Korean filenames — "微信图片_2026.png" was always fine,
  // because "_2026" survives and keeps a stem in front of the dot. That is why
  // this went unnoticed.
  it("keeps the extension when the stem is entirely non-ASCII", () => {
    expect(sanitizeBasename("风景.png")).toBe("upload.png");
    expect(sanitizeBasename("日本語.jpeg")).toBe("upload.jpeg");
    expect(sanitizeBasename("한글.png")).toBe("upload.png");
    expect(sanitizeBasename("相册/风景.png")).toBe("upload.png");
  });

  it("keeps the extension on names that already sanitized cleanly", () => {
    expect(sanitizeBasename("微信图片_2026.png")).toBe("_2026.png");
    expect(sanitizeBasename("IMG_1234.PNG")).toBe("IMG_1234.PNG");
    expect(sanitizeBasename("archive.tar.gz")).toBe("archive.tar.gz");
  });

  // A dotfile has no extension to preserve — the whole name is the stem.
  it("treats a leading-dot name as a stem, not as a bare extension", () => {
    expect(sanitizeBasename(".png")).toBe("png");
    expect(sanitizeBasename(".gitignore")).toBe("gitignore");
  });

  // The key is `${uuid}-${basename}`, so a "/" or "\\" surviving here would
  // steer path segments; an over-long extension would pad the key for no gain.
  it("never emits a path separator, and caps the extension", () => {
    expect(sanitizeBasename("C:\\photos\\风景.png")).toBe("upload.png");
    expect(sanitizeBasename("x." + "a".repeat(40))).toBe("x." + "a".repeat(10));
  });

  it("falls back to a constant when nothing survives sanitization", () => {
    expect(sanitizeBasename("???")).toBe("upload");
    expect(sanitizeBasename("")).toBe("upload");
    expect(sanitizeBasename("///")).toBe("upload");
  });
});

// C1d (regression): storageDeleteOwned runs the key through canonicalKey,
// which throws StorageError("forbidden") for a malformed key (e.g. a
// "../"-traversal segment) BEFORE any db/network access. files.remove had no
// try/catch, so that throw used to escape as a raw StorageError, which tRPC
// wraps as an opaque INTERNAL_SERVER_ERROR (500) for what is plainly bad
// client input. Exercise the real router (only auth/storage/db are mocked —
// ./_core/trpc is real) via makeCaller so this asserts the actual error the
// client would receive, not a re-implementation of the mapping.
describe("files.remove", () => {
  it("maps a malformed key (StorageError forbidden) to TRPCError BAD_REQUEST, not a raw throw", async () => {
    vi.mocked(storageDeleteOwned).mockRejectedValueOnce(
      new StorageError("unsafe storage key (diverges from platform normalization): ../evil.pdf", "forbidden"),
    );
    const caller = makeCaller({
      c: {} as never,
      db: {} as never,
      user: { id: "user-1" } as never,
    });

    const err = await caller.files.remove({ key: "../evil.pdf" }).catch((e) => e);

    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("BAD_REQUEST");
  });
});

// Regression (observed 2026-08-26, published app): signing up twice with the
// same email answered 500 INTERNAL_SERVER_ERROR whose message was the raw
// Drizzle failure — the INSERT statement plus every bound param, bcrypt hash
// included — which the signup form then printed at the user. The mapping now
// hangs off a type (EmailTakenError from _core/auth), not a regex over a
// driver-specific message.
describe("auth.signup", () => {
  const anonymous = { c: {} as never, db: {} as never, user: null };

  it("maps an already-registered email to TRPCError CONFLICT, not a 500", async () => {
    vi.mocked(registerLocalUser).mockRejectedValueOnce(
      new EmailTakenError("That email is already registered — try logging in instead."),
    );
    const caller = makeCaller(anonymous);

    const err = await caller.auth
      .signup({ email: "asce1885@gmail.com", password: "hunter2hunter2", name: "asce" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("CONFLICT");
    expect((err as TRPCError).message).toMatch(/already registered/i);
    expect((err as TRPCError).message).not.toMatch(/insert into|Failed query|params:|\$2b\$/);
  });

  it("refuses a second signup once an owner exists", async () => {
    vi.mocked(db.countOwners).mockResolvedValueOnce(1);
    const caller = makeCaller(anonymous);
    const err = await caller.auth
      .signup({ email: "second@example.com", password: "hunter2hunter2" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("CONFLICT");
  });
});

// The core money rule: amount due is visible ONLY in the Owner app. A driver
// asking for the same order must get the invoice with its totals zeroed.
describe("orders.get — amount due is owner-only", () => {
  const invoice = { id: "inv-1", subtotal: 500, total: 500, amountDue: 500 };
  const detail = { order: { id: "o-1", status: "on_rent" }, items: [], invoice };

  it("strips invoice totals for a driver", async () => {
    vi.mocked(db.getProfile).mockResolvedValueOnce({ role: "driver", ownerId: "owner-1" } as never);
    vi.mocked(db.accountIdFor).mockResolvedValueOnce("owner-1");
    vi.mocked(db.getOrder).mockResolvedValueOnce(detail as never);
    const caller = makeCaller({ c: {} as never, db: {} as never, user: { id: "driver-user" } as never });

    const res = await caller.orders.get({ id: "11111111-1111-4111-8111-111111111111" });
    expect(res.invoice?.amountDue).toBe(0);
    expect(res.invoice?.total).toBe(0);
    expect((res.invoice as { hidden?: boolean }).hidden).toBe(true);
  });

  it("keeps invoice totals for the owner", async () => {
    vi.mocked(db.getProfile).mockResolvedValueOnce({ role: "owner", ownerId: "owner-1" } as never);
    vi.mocked(db.accountIdFor).mockResolvedValueOnce("owner-1");
    vi.mocked(db.getOrder).mockResolvedValueOnce(detail as never);
    const caller = makeCaller({ c: {} as never, db: {} as never, user: { id: "owner-1" } as never });

    const res = await caller.orders.get({ id: "11111111-1111-4111-8111-111111111111" });
    expect(res.invoice?.amountDue).toBe(500);
  });
});

// Only a driver may lock an order for dispatch; the owner cannot.
describe("orders.lock — driver only", () => {
  it("rejects an owner", async () => {
    vi.mocked(db.accountIdFor).mockResolvedValueOnce("owner-1");
    vi.mocked(db.getDriverByUserId).mockResolvedValueOnce(null as never);
    const caller = makeCaller({ c: {} as never, db: {} as never, user: { id: "owner-1" } as never });

    const err = await caller.orders.lock({ id: "11111111-1111-4111-8111-111111111111" }).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("FORBIDDEN");
  });
});

// Drivers may be created WITHOUT an email and log in with a username or phone.
describe("users.createDriver \u2014 email is optional", () => {
  const owner = { c: {} as never, db: {} as never, user: { id: "owner-1" } as never };

  it("creates a driver with a username and no email", async () => {
    vi.mocked(db.getProfile).mockResolvedValueOnce({ role: "owner", ownerId: "owner-1" } as never);
    vi.mocked(db.accountIdFor).mockResolvedValueOnce("owner-1");
    vi.mocked(db.isUsernameTaken).mockResolvedValueOnce(false);
    vi.mocked(registerLocalUser).mockResolvedValueOnce({
      id: "u-9",
      email: "ram@driver.local",
      name: "Ram",
      role: "user",
    } as never);
    vi.mocked(db.createDriverRow).mockResolvedValueOnce({ id: "d-9" } as never);
    const caller = makeCaller(owner);

    const res = await caller.users.createDriver({ name: "Ram", username: "ram", password: "hunter2hunter2" });
    expect(res.loginId).toBe("ram");
    // The internal placeholder address is never the login handle.
    expect(res.loginId).not.toContain("@");
    expect(registerLocalUser).toHaveBeenCalledWith("ram@driver.local", "hunter2hunter2", "Ram");
  });

  it("rejects a duplicate username with CONFLICT", async () => {
    vi.mocked(db.getProfile).mockResolvedValueOnce({ role: "owner", ownerId: "owner-1" } as never);
    vi.mocked(db.accountIdFor).mockResolvedValueOnce("owner-1");
    vi.mocked(db.isUsernameTaken).mockResolvedValueOnce(true);
    const caller = makeCaller(owner);

    const err = await caller.users
      .createDriver({ name: "Ram", username: "ram", password: "hunter2hunter2" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("CONFLICT");
  });

  it("refuses a driver with no email, username or phone", async () => {
    vi.mocked(db.getProfile).mockResolvedValueOnce({ role: "owner", ownerId: "owner-1" } as never);
    vi.mocked(db.accountIdFor).mockResolvedValueOnce("owner-1");
    const caller = makeCaller(owner);

    const err = await caller.users
      .createDriver({ name: "Ram", password: "hunter2hunter2" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("BAD_REQUEST");
  });
});

// Login accepts a username or phone, not only an email.
describe("auth.login \u2014 identifier resolution", () => {
  const anonymous = { c: {} as never, db: {} as never, user: null };

  it("resolves a username to the account email before authenticating", async () => {
    vi.mocked(db.resolveLoginEmail).mockResolvedValueOnce("ram@driver.local");
    const login = vi.fn().mockResolvedValue({ id: "u-9", email: "ram@driver.local" });
    const { authProvider } = await import("./_core/auth");
    vi.mocked(authProvider).mockReturnValueOnce({ login, logout: vi.fn(), getSession: vi.fn() } as never);
    const caller = makeCaller(anonymous);

    await caller.auth.login({ email: "ram", password: "hunter2hunter2" });
    expect(db.resolveLoginEmail).toHaveBeenCalledWith("ram");
    expect(login).toHaveBeenCalledWith(expect.anything(), "ram@driver.local", "hunter2hunter2");
  });

  it("answers UNAUTHORIZED for an unknown identifier", async () => {
    vi.mocked(db.resolveLoginEmail).mockResolvedValueOnce(null);
    const caller = makeCaller(anonymous);

    const err = await caller.auth.login({ email: "nobody", password: "hunter2hunter2" }).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("UNAUTHORIZED");
  });
});

// A driver's order list is scoped to their own driver id, which is what hides
// orders locked by other drivers.
describe("orders.list — driver scoping", () => {
  it("passes the caller's driverId to the query", async () => {
    vi.mocked(db.accountIdFor).mockResolvedValueOnce("owner-1");
    vi.mocked(db.getProfile).mockResolvedValueOnce({ role: "driver", ownerId: "owner-1" } as never);
    vi.mocked(db.getDriverByUserId).mockResolvedValueOnce({ id: "driver-9" } as never);
    vi.mocked(db.listOrders).mockResolvedValueOnce([] as never);
    const caller = makeCaller({ c: {} as never, db: {} as never, user: { id: "driver-user" } as never });

    await caller.orders.list({});
    expect(db.listOrders).toHaveBeenCalledWith("owner-1", { driverId: "driver-9", status: undefined });
  });
});

// ── owner review & edit before approving ──────────────────────────────────────
// The owner corrects a pending order and then approves it. Editing must be
// owner-only and must stop the moment the order leaves `pending_approval`, which
// is what keeps "Actual Qty hits stock, Billed Qty hits the invoice" intact.
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";
const EQUIP_ID = "33333333-3333-4333-8333-333333333333";

function editPayload() {
  return {
    id: ORDER_ID,
    customerId: CUSTOMER_ID,
    driverId: null,
    vehicleId: null,
    notes: "Delivery 8am",
    orderDateAd: "2026-10-09",
    items: [
      { equipmentId: EQUIP_ID, basis: "pillar" as const, rate: 1250, units: 1, actualQty: 20, billedQty: 18 },
    ],
  };
}

describe("orders.update — owner review & edit", () => {
  it("saves the owner's edits to a pending order", async () => {
    vi.mocked(db.getProfile).mockResolvedValueOnce({ role: "owner", ownerId: "owner-1" } as never);
    vi.mocked(db.accountIdFor).mockResolvedValueOnce("owner-1");
    vi.mocked(db.listCustomers).mockResolvedValueOnce([{ id: CUSTOMER_ID }] as never);
    vi.mocked(db.listActiveDrivers).mockResolvedValueOnce([] as never);
    vi.mocked(db.listActiveVehicles).mockResolvedValueOnce([] as never);
    vi.mocked(db.updatePendingOrder).mockResolvedValueOnce(true);
    const caller = makeCaller({ c: {} as never, db: {} as never, user: { id: "owner-1" } as never });

    const res = await caller.orders.update(editPayload());
    expect(res.ok).toBe(true);

    // Actual Qty and Billed Qty are handed over untouched — stock and the
    // invoice are driven by different numbers on purpose.
    const [, , edit, items] = vi.mocked(db.updatePendingOrder).mock.calls[0];
    expect(edit.customerId).toBe(CUSTOMER_ID);
    expect(items[0]).toMatchObject({ actualQty: 20, billedQty: 18, basis: "pillar" });
  });

  it("refuses a driver editing the order", async () => {
    vi.mocked(db.getProfile).mockResolvedValueOnce({ role: "driver", ownerId: "owner-1" } as never);
    const caller = makeCaller({ c: {} as never, db: {} as never, user: { id: "driver-user" } as never });

    const err = await caller.orders.update(editPayload()).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("FORBIDDEN");
  });

  it("reports a conflict when the order is no longer awaiting approval", async () => {
    vi.mocked(db.getProfile).mockResolvedValueOnce({ role: "owner", ownerId: "owner-1" } as never);
    vi.mocked(db.accountIdFor).mockResolvedValueOnce("owner-1");
    vi.mocked(db.listCustomers).mockResolvedValueOnce([{ id: CUSTOMER_ID }] as never);
    vi.mocked(db.listActiveDrivers).mockResolvedValueOnce([] as never);
    vi.mocked(db.listActiveVehicles).mockResolvedValueOnce([] as never);
    // The guarded UPDATE matched nothing (already approved / rejected).
    vi.mocked(db.updatePendingOrder).mockResolvedValueOnce(false);
    const caller = makeCaller({ c: {} as never, db: {} as never, user: { id: "owner-1" } as never });

    const err = await caller.orders.update(editPayload()).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("CONFLICT");
  });

  it("rejects a customer that belongs to another business", async () => {
    vi.mocked(db.getProfile).mockResolvedValueOnce({ role: "owner", ownerId: "owner-1" } as never);
    vi.mocked(db.accountIdFor).mockResolvedValueOnce("owner-1");
    vi.mocked(db.listCustomers).mockResolvedValueOnce([] as never);
    vi.mocked(db.listActiveDrivers).mockResolvedValueOnce([] as never);
    vi.mocked(db.listActiveVehicles).mockResolvedValueOnce([] as never);
    const caller = makeCaller({ c: {} as never, db: {} as never, user: { id: "owner-1" } as never });

    const err = await caller.orders.update(editPayload()).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("BAD_REQUEST");
  });
});

// ── forgot password: emailed 6-digit code ────────────────────────────────────
describe("auth.requestPasswordReset", () => {
  const anonymous = { c: { req: { header: () => undefined } } as never, db: {} as never, user: null };

  beforeEach(() => {
    // Mocks are module-level and shared by every test in this file, so call
    // history carries across suites unless it is cleared. Any assertion of the
    // form "this was NOT called" would otherwise see the calls a LATER test made.
    vi.clearAllMocks();
    vi.mocked(db.countResetRequestsForIp).mockResolvedValue(0);
    vi.mocked(db.latestResetRequestForIp).mockResolvedValue(null);
    vi.mocked(db.countResetRequestsForUser).mockResolvedValue(0);
  });

  it("stores the code hashed, never in plain text", async () => {
    vi.mocked(db.findUserByEmail).mockResolvedValueOnce({ id: "u-1", email: "owner@sharma.com" } as never);
    const { sendMail } = await import("./services/smtp-mail");
    vi.mocked(sendMail).mockResolvedValueOnce({ sent: true, status: "sent" });
    const caller = makeCaller(anonymous);

    const res = await caller.auth.requestPasswordReset({ email: "owner@sharma.com" });
    expect(res.sent).toBe(true);

    const [created] = vi.mocked(db.createResetCode).mock.calls[0];
    // The mailed code is never what is persisted.
    const mailed = vi.mocked(sendMail).mock.calls[0][0];
    expect(mailed.to).toBe("owner@sharma.com");
    expect(created.codeHash).not.toMatch(/^\d{6}$/);
    expect(created.codeHash).toMatch(/^\$2[aby]\$/); // bcrypt
    // Valid for 10 minutes, not more.
    const ttl = new Date(created.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(8 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000 + 1_000);
  });

  it("returns the same shape for an unknown address (no account enumeration)", async () => {
    vi.mocked(db.findUserByEmail).mockResolvedValueOnce(null as never);
    const caller = makeCaller(anonymous);

    const res = await caller.auth.requestPasswordReset({ email: "nobody@example.com" });
    expect(res.ok).toBe(true);
    expect(res.sent).toBe(false);
    expect(db.createResetCode).not.toHaveBeenCalled();
  });

  it("rate-limits repeated requests from one IP", async () => {
    vi.mocked(db.countResetRequestsForIp).mockResolvedValueOnce(5);
    const caller = makeCaller(anonymous);

    const err = await caller.auth
      .requestPasswordReset({ email: "owner@sharma.com" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("TOO_MANY_REQUESTS");
  });

  it("enforces a resend cooldown", async () => {
    vi.mocked(db.latestResetRequestForIp).mockResolvedValueOnce({ createdAt: new Date() } as never);
    const caller = makeCaller(anonymous);

    const err = await caller.auth
      .requestPasswordReset({ email: "owner@sharma.com" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("TOO_MANY_REQUESTS");
  });
});

describe("auth.verifyResetCode / resetPassword", () => {
  const anonymous = { c: {} as never, db: {} as never, user: null };
  const CODE = "123456";

  // Same cross-suite call-history reason as the requestPasswordReset block.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function liveCode(overrides: Record<string, unknown> = {}) {
    const { hash } = await import("bcryptjs");
    return {
      id: "rc-1",
      userId: "u-1",
      codeHash: await hash(CODE, 4),
      expiresAt: new Date(Date.now() + 5 * 60_000),
      attempts: 0,
      consumedAt: null,
      ...overrides,
    } as never;
  }

  it("accepts the mailed code", async () => {
    vi.mocked(db.findUserByEmail).mockResolvedValueOnce({ id: "u-1", email: "owner@sharma.com" } as never);
    vi.mocked(db.activeResetCode).mockResolvedValueOnce(await liveCode());
    const caller = makeCaller(anonymous);

    await expect(caller.auth.verifyResetCode({ email: "owner@sharma.com", code: CODE })).resolves.toEqual({ ok: true });
  });

  it("rejects a wrong code and counts the attempt", async () => {
    vi.mocked(db.findUserByEmail).mockResolvedValueOnce({ id: "u-1", email: "owner@sharma.com" } as never);
    vi.mocked(db.activeResetCode).mockResolvedValueOnce(await liveCode());
    const caller = makeCaller(anonymous);

    const err = await caller.auth
      .verifyResetCode({ email: "owner@sharma.com", code: "999999" })
      .catch((e) => e);
    expect((err as TRPCError).code).toBe("UNAUTHORIZED");
    expect(db.bumpResetAttempts).toHaveBeenCalledWith("rc-1");
  });

  it("rejects an expired code", async () => {
    vi.mocked(db.findUserByEmail).mockResolvedValueOnce({ id: "u-1", email: "owner@sharma.com" } as never);
    vi.mocked(db.activeResetCode).mockResolvedValueOnce(await liveCode({ expiresAt: new Date(Date.now() - 1000) }));
    const caller = makeCaller(anonymous);

    const err = await caller.auth
      .verifyResetCode({ email: "owner@sharma.com", code: CODE })
      .catch((e) => e);
    expect((err as TRPCError).code).toBe("UNAUTHORIZED");
  });

  it("stops accepting guesses once the attempt cap is reached", async () => {
    vi.mocked(db.findUserByEmail).mockResolvedValueOnce({ id: "u-1", email: "owner@sharma.com" } as never);
    vi.mocked(db.activeResetCode).mockResolvedValueOnce(await liveCode({ attempts: 5 }));
    const caller = makeCaller(anonymous);

    const err = await caller.auth
      .verifyResetCode({ email: "owner@sharma.com", code: CODE })
      .catch((e) => e);
    expect((err as TRPCError).code).toBe("TOO_MANY_REQUESTS");
  });

  it("sets the new password and is single-use", async () => {
    vi.mocked(db.findUserByEmail).mockResolvedValueOnce({ id: "u-1", email: "owner@sharma.com" } as never);
    vi.mocked(db.activeResetCode).mockResolvedValueOnce(await liveCode());
    vi.mocked(db.consumeResetCode).mockResolvedValueOnce(true);
    const caller = makeCaller(anonymous);

    const res = await caller.auth.resetPassword({ email: "owner@sharma.com", code: CODE, password: "brandnewpass1" });
    expect(res.ok).toBe(true);
    const [userId, passwordHash] = vi.mocked(db.setUserPassword).mock.calls[0];
    expect(userId).toBe("u-1");
    expect(passwordHash).not.toBe("brandnewpass1");
    const { compare } = await import("bcryptjs");
    expect(await compare("brandnewpass1", passwordHash)).toBe(true);
  });

  it("refuses to reuse a code that was already consumed", async () => {
    vi.mocked(db.findUserByEmail).mockResolvedValueOnce({ id: "u-1", email: "owner@sharma.com" } as never);
    vi.mocked(db.activeResetCode).mockResolvedValueOnce(await liveCode());
    vi.mocked(db.consumeResetCode).mockResolvedValueOnce(false);
    const caller = makeCaller(anonymous);

    const err = await caller.auth
      .resetPassword({ email: "owner@sharma.com", code: CODE, password: "brandnewpass1" })
      .catch((e) => e);
    expect((err as TRPCError).code).toBe("CONFLICT");
    expect(db.setUserPassword).not.toHaveBeenCalled();
  });
});

// ── customer ledger & receipts ───────────────────────────────────────────────
//
// Money is the owner's alone. These pin the two halves of that: a driver is
// refused every money endpoint, and an owner's customer list carries the due
// balance while a driver's carries none.
describe("customer ledger & receipts (owner-only money)", () => {
  const owner = { c: {} as never, db: {} as never, user: { id: "owner-1" } as never };
  const driver = { c: {} as never, db: {} as never, user: { id: "driver-user" } as never };
  const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    vi.clearAllMocks();
    // Persistent defaults: these procedures run several steps, and a queued
    // `mockResolvedValueOnce` would otherwise leave the NEXT call undefined.
    vi.mocked(db.getProfile).mockResolvedValue({ role: "owner", ownerId: "owner-1" } as never);
    vi.mocked(db.accountIdFor).mockResolvedValue("owner-1");
    vi.mocked(db.listCustomers).mockResolvedValue([{ id: CUSTOMER_ID, name: "Himalaya" }] as never);
    vi.mocked(db.customerDueMap).mockResolvedValue(new Map() as never);
  });

  it("shows the due balance to the owner", async () => {
    vi.mocked(db.customerDueMap).mockResolvedValue(new Map([[CUSTOMER_ID, 12500]]) as never);

    const rows = await makeCaller(owner).customers.list();
    expect(rows[0]).toMatchObject({ name: "Himalaya", due: 12500, moneyHidden: false });
  });

  it("hides the due balance from a driver even though the list still works", async () => {
    vi.mocked(db.getProfile).mockResolvedValue({ role: "driver", ownerId: "owner-1" } as never);

    const rows = await makeCaller(driver).customers.list();
    expect(rows[0]).toMatchObject({ name: "Himalaya", due: 0, moneyHidden: true });
    // The due map is never even queried for a driver.
    expect(db.customerDueMap).not.toHaveBeenCalled();
  });

  it("refuses a driver opening a customer ledger", async () => {
    vi.mocked(db.getProfile).mockResolvedValue({ role: "driver", ownerId: "owner-1" } as never);

    const err = await makeCaller(driver).customers.ledger({ customerId: CUSTOMER_ID }).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("FORBIDDEN");
    expect(db.getCustomerLedger).not.toHaveBeenCalled();
  });

  it("returns the owner the full ledger with closing due", async () => {
    vi.mocked(db.getCustomerLedger).mockResolvedValue({
      customer: { id: CUSTOMER_ID, name: "Himalaya", openingBalance: 0 },
      rows: [
        { kind: "invoice", id: "i1", debit: 22500, credit: 0, running: 22500 },
        { kind: "receipt", id: "r1", debit: 0, credit: 10000, running: 12500 },
      ],
      totals: { openingBalance: 0, totalInvoiced: 22500, totalReceived: 10000, closingDue: 12500 },
    } as never);

    const res = await makeCaller(owner).customers.ledger({ customerId: CUSTOMER_ID });
    expect(res.totals.closingDue).toBe(12500);
    expect(db.getCustomerLedger).toHaveBeenCalledWith("owner-1", CUSTOMER_ID);
  });

  it("refuses a driver recording a receipt", async () => {
    vi.mocked(db.getProfile).mockResolvedValue({ role: "driver", ownerId: "owner-1" } as never);

    const err = await makeCaller(driver)
      .receipts.create({ customerId: CUSTOMER_ID, amount: 500, mode: "cash" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("FORBIDDEN");
    expect(db.createReceipt).not.toHaveBeenCalled();
  });

  it("refuses a driver listing receipts", async () => {
    vi.mocked(db.getProfile).mockResolvedValue({ role: "driver", ownerId: "owner-1" } as never);

    const err = await makeCaller(driver).receipts.list().catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("FORBIDDEN");
  });

  it("records a receipt for the owner, scoped to their account", async () => {
    vi.mocked(db.createReceipt).mockResolvedValue({ id: "r-1", amount: 500 } as never);

    const res = await makeCaller(owner).receipts.create({
      customerId: CUSTOMER_ID,
      amount: 500,
      mode: "bank",
      referenceNo: "TXN-9",
    });
    expect(res.id).toBe("r-1");
    const [input] = vi.mocked(db.createReceipt).mock.calls[0];
    expect(input).toMatchObject({ ownerId: "owner-1", customerId: CUSTOMER_ID, amount: 500, mode: "bank" });
  });

  it("rejects a zero or negative receipt amount", async () => {
    for (const amount of [0, -100]) {
      const err = await makeCaller(owner)
        .receipts.create({ customerId: CUSTOMER_ID, amount, mode: "cash" })
        .catch((e) => e);
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("BAD_REQUEST");
    }
    expect(db.createReceipt).not.toHaveBeenCalled();
  });

  it("rejects a receipt against a customer from another business", async () => {
    vi.mocked(db.listCustomers).mockResolvedValue([] as never);

    const err = await makeCaller(owner)
      .receipts.create({ customerId: CUSTOMER_ID, amount: 500, mode: "cash" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("BAD_REQUEST");
    expect(db.createReceipt).not.toHaveBeenCalled();
  });
});

// ── dispatch belongs to the driver who LOCKED the order ──────────────────────
//
// An order can be taken by one driver and locked for dispatch by another, and
// only the locker may dispatch it. These tests pin that rule at the router edge,
// where the SQL guard's verdict is turned into a status code.

describe("orders.dispatch — locking driver rule", () => {
  const owner = { c: {} as never, db: {} as never, user: { id: "owner-1" } as never };
  const driver = { c: {} as never, db: {} as never, user: { id: "driver-user" } as never };
  const DRIVER_ID = "11111111-1111-4111-8111-111111111111";
  const OTHER_DRIVER_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    // Call history is per-test: without this, "not.toHaveBeenCalled" assertions
    // see the previous test's calls and fail for the wrong reason.
    vi.clearAllMocks();
    vi.mocked(db.accountIdFor).mockResolvedValue("owner-1" as never);
  });

  it("lets the OWNER dispatch without being a driver", async () => {
    vi.mocked(db.dispatchOrder).mockResolvedValue({ ok: true, invoice: { id: "inv-1" } } as never);

    const res = await makeCaller(owner).orders.dispatch({ id: ORDER_ID });
    expect(res).toEqual({ ok: true, invoice: { id: "inv-1" } });
    // The owner is not a driver, so no driver id is passed to the guard. The
    // 4th argument is the actor NAME snapshotted onto the stock movements (the
    // owner is not a driver, so it resolves from the profile instead).
    expect(db.dispatchOrder).toHaveBeenCalledWith("owner-1", ORDER_ID, null, null);
  });

  it("passes the CALLER's own driver id, so the guard cannot be spoofed", async () => {
    vi.mocked(db.dispatchOrder).mockResolvedValue({ ok: true, invoice: { id: "inv-1" } } as never);
    // `resolveDriver` reads the DRIVERS table by user id, not the profile — so
    // this is the lookup that decides which driver the guard sees.
    vi.mocked(db.getDriverByUserId).mockResolvedValue({ id: OTHER_DRIVER_ID } as never);

    await makeCaller(driver).orders.dispatch({ id: ORDER_ID });

    const [, , driverArg] = vi.mocked(db.dispatchOrder).mock.calls.at(-1)!;
    expect(driverArg).toBe(OTHER_DRIVER_ID);
    expect(driverArg).not.toBe(DRIVER_ID);
  });

  it("refuses a driver who did not lock the order, with a clear message", async () => {
    vi.mocked(db.dispatchOrder).mockResolvedValue({ ok: false, reason: "not_locker" } as never);

    const err = await makeCaller(driver).orders.dispatch({ id: ORDER_ID }).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("FORBIDDEN");
    expect((err as TRPCError).message).toMatch(/only the driver who locked this order/i);
  });

  it("still reports CONFLICT when the order is not on transit", async () => {
    vi.mocked(db.dispatchOrder).mockResolvedValue({ ok: false, reason: "bad_status" } as never);

    const err = await makeCaller(owner).orders.dispatch({ id: ORDER_ID }).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("CONFLICT");
  });

  // ── replay of a dispatch that already happened ─────────────────────────────
  //
  // The offline outbox replays queued writes, so a dispatch whose own reply was
  // lost (or that landed just before the tab closed) arrives here a second time
  // on an order that is already `on_rent`. That is the trip being on the road and
  // the invoice existing — success. Throwing here is what made the sync strip
  // report "some changes may not have been applied" on an app whose data was
  // saved, because the outbox counts a thrown mutation as a conflict.
  it("treats a replayed dispatch of an already-dispatched order as success, not a conflict", async () => {
    vi.mocked(db.dispatchOrder).mockResolvedValue({
      ok: true,
      alreadyApplied: true,
      invoice: { id: "inv-1" },
      order: { id: ORDER_ID, status: "on_rent" },
    } as never);

    const res = await makeCaller(owner).orders.dispatch({ id: ORDER_ID });

    expect(res).toMatchObject({ ok: true, alreadyApplied: true });
    // And the caller can see it was a no-op, so the client can say "already up
    // to date" instead of claiming a fresh sync.
    expect((res as { alreadyApplied?: boolean }).alreadyApplied).toBe(true);
  });

  it("treats a replayed pickup of an already-returned order as success", async () => {
    vi.mocked(db.returnOrder).mockResolvedValue({
      ok: true,
      alreadyApplied: true,
      order: { id: ORDER_ID, status: "returned" },
    } as never);

    const res = await makeCaller(owner).orders.return({ id: ORDER_ID });
    expect(res).toMatchObject({ ok: true, alreadyApplied: true });
  });

  it("still refuses a replayed dispatch from a driver who neither locked nor dispatched it", async () => {
    // The idempotency allowance must not become a way around the locker rule:
    // `db.dispatchOrder` only returns alreadyApplied for the owner, the locker or
    // the dispatcher, and reports not_locker for anyone else.
    vi.mocked(db.dispatchOrder).mockResolvedValue({ ok: false, reason: "not_locker" } as never);

    const err = await makeCaller(driver).orders.dispatch({ id: ORDER_ID }).catch((e) => e);
    expect((err as TRPCError).code).toBe("FORBIDDEN");
  });
});

// ── owner undo: lock and return ──────────────────────────────────────────────
//
// Two invariants matter more than the happy path:
//   * a driver can never reach either undo (403 before any work), and
//   * a second undo is a no-op that writes NO second audit entry — otherwise the
//     trail would claim the owner corrected the same mistake twice.

describe("orders — owner-only undo", () => {
  const owner = { c: {} as never, db: {} as never, user: { id: "owner-1" } as never };
  const driver = { c: {} as never, db: {} as never, user: { id: "driver-user" } as never };

  const before = {
    id: ORDER_ID,
    status: "on_transit",
    customerName: "Annapurna Infra",
    lockedByDriverId: "drv-bikash",
    transitedByName: "Bikash",
    transitVehicleId: "veh-2769",
    transitVehicleName: "Truck 2769",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.getProfile).mockImplementation(async (id: string) =>
      (id === "owner-1"
        ? { role: "owner", ownerId: "owner-1", driverId: null, displayName: "Sharma" }
        : { role: "driver", ownerId: "owner-1", driverId: "drv-bikash", displayName: "Bikash" }) as never,
    );
    vi.mocked(db.accountIdFor).mockResolvedValue("owner-1" as never);
  });

  it("refuses undoLock for a driver before doing any work", async () => {
    const err = await makeCaller(driver)
      .orders.undoLock({ id: ORDER_ID, reason: "wrong driver" })
      .catch((e) => e);
    expect((err as TRPCError).code).toBe("FORBIDDEN");
    expect(db.undoLockForDispatch).not.toHaveBeenCalled();
  });

  it("refuses undoReturn for a driver before doing any work", async () => {
    const err = await makeCaller(driver)
      .orders.undoReturn({ id: ORDER_ID, reason: "wrong driver" })
      .catch((e) => e);
    expect((err as TRPCError).code).toBe("FORBIDDEN");
    expect(db.undoReturnFromCustomer).not.toHaveBeenCalled();
  });

  it("requires a reason", async () => {
    const err = await makeCaller(owner)
      .orders.undoLock({ id: ORDER_ID, reason: "   " })
      .catch((e) => e);
    expect((err as TRPCError).code).toBe("BAD_REQUEST");
    expect(db.undoLockForDispatch).not.toHaveBeenCalled();
  });

  it("undoes a lock and records the reason and before/after state", async () => {
    vi.mocked(db.undoLockForDispatch).mockResolvedValue({
      ok: true,
      before,
      after: { ...before, status: "approved", lockedByDriverId: null, transitVehicleId: null },
    } as never);

    const res = await makeCaller(owner).orders.undoLock({ id: ORDER_ID, reason: "Locked by the wrong driver" });

    expect(res).toMatchObject({ ok: true, alreadyApplied: false, status: "approved" });
    const entry = vi.mocked(db.writeAuditLog).mock.calls[0]![0];
    expect(entry.summary).toContain("Locked by the wrong driver");
    expect(entry.summary).toContain("Bikash");
    expect(entry.detail).toMatchObject({
      undo: "lock",
      reason: "Locked by the wrong driver",
      before: { status: "on_transit", lockedByDriverId: "drv-bikash" },
      after: { status: "approved", lockedByDriverId: null },
    });
  });

  it("refuses to undo a lock once the order is dispatched, and says to undo the dispatch first", async () => {
    vi.mocked(db.undoLockForDispatch).mockResolvedValue({
      ok: false,
      reason: "already_dispatched",
      order: { ...before, status: "on_rent" },
    } as never);

    const err = await makeCaller(owner)
      .orders.undoLock({ id: ORDER_ID, reason: "wrong driver" })
      .catch((e) => e);

    expect((err as TRPCError).code).toBe("CONFLICT");
    expect((err as TRPCError).message).toContain("Undo the dispatch first");
    expect(db.writeAuditLog).not.toHaveBeenCalled();
  });

  it("treats a replayed undo as success and writes no second audit entry", async () => {
    vi.mocked(db.undoLockForDispatch).mockResolvedValue({
      ok: true,
      alreadyApplied: true,
      before,
      after: { ...before, status: "approved", lockedByDriverId: null },
    } as never);

    const res = await makeCaller(owner).orders.undoLock({ id: ORDER_ID, reason: "again" });

    expect(res).toMatchObject({ ok: true, alreadyApplied: true });
    expect(db.writeAuditLog).not.toHaveBeenCalled();
  });

  it("undoes a return, reporting how many movements were reversed", async () => {
    vi.mocked(db.undoReturnFromCustomer).mockResolvedValue({
      ok: true,
      before: { ...before, status: "returned" },
      after: { ...before, status: "on_rent" },
      reversedMovements: 2,
    } as never);

    const res = await makeCaller(owner).orders.undoReturn({ id: ORDER_ID, reason: "Returned by mistake" });

    expect(res).toMatchObject({ ok: true, status: "on_rent", reversedMovements: 2 });
    const entry = vi.mocked(db.writeAuditLog).mock.calls[0]![0];
    expect(entry.summary).toContain("Returned by mistake");
    expect(entry.summary).toContain("2 stock movement(s) were reversed");
    expect(entry.detail).toMatchObject({ undo: "return", reversedMovements: 2 });
  });

  it("refuses to undo a return when the order is no longer returned", async () => {
    vi.mocked(db.undoReturnFromCustomer).mockResolvedValue({
      ok: false,
      reason: "not_returned",
      order: { ...before, status: "on_rent" },
    } as never);

    const err = await makeCaller(owner)
      .orders.undoReturn({ id: ORDER_ID, reason: "mistake" })
      .catch((e) => e);

    expect((err as TRPCError).code).toBe("CONFLICT");
    expect((err as TRPCError).message).toContain("not marked returned");
    expect(db.writeAuditLog).not.toHaveBeenCalled();
  });
});

// ── owner edit/delete is owner-only, and audited ──────────────────────────────
//
// The owner can change or delete ANY record, including after dispatch. That power
// has two invariants worth locking down: a driver can never reach it (403, before
// any work), and every successful change leaves an audit entry.

describe("admin — owner-only edit/delete with an audit trail", () => {
  const owner = { c: {} as never, db: {} as never, user: { id: "owner-1" } as never };
  const driver = { c: {} as never, db: {} as never, user: { id: "driver-user" } as never };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.getProfile).mockImplementation(async (id: string) =>
      (id === "owner-1"
        ? { role: "owner", ownerId: "owner-1", driverId: null, displayName: "Sharma" }
        : { role: "driver", ownerId: "owner-1", driverId: null, displayName: "Ram" }) as never,
    );
    vi.mocked(db.accountIdFor).mockResolvedValue("owner-1" as never);
    vi.mocked(db.writeAuditLog).mockResolvedValue(undefined as never);
    // Safe defaults: "nothing to delete" unless a test says otherwise, so an
    // un-stubbed helper can never make a failed delete look successful.
    vi.mocked(db.orderCascadeSummary).mockResolvedValue(null as never);
    vi.mocked(db.deleteOrder).mockResolvedValue(null as never);
    vi.mocked(db.deleteCustomer).mockResolvedValue(null as never);
    vi.mocked(db.deleteEquipment).mockResolvedValue(null as never);
    vi.mocked(db.deleteVehicle).mockResolvedValue(null as never);
    vi.mocked(db.deleteInvoice).mockResolvedValue(null as never);
    vi.mocked(db.deleteUser).mockResolvedValue({ ok: false, reason: "not_found" } as never);
  });

  it("rejects every destructive admin action for a driver with FORBIDDEN", async () => {
    const caller = makeCaller(driver);
    const attempts = [
      caller.admin.deleteOrder({ id: ORDER_ID }),
      caller.admin.deleteCustomer({ id: ORDER_ID }),
      caller.admin.deleteEquipment({ id: ORDER_ID }),
      caller.admin.deleteVehicle({ id: ORDER_ID }),
      caller.admin.deleteInvoice({ id: ORDER_ID }),
      caller.admin.deleteUser({ id: ORDER_ID }),
    ];

    for (const attempt of attempts) {
      const err = await attempt.catch((e) => e);
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("FORBIDDEN");
    }
    // Nothing reached the data layer.
    expect(db.deleteOrder).not.toHaveBeenCalled();
    expect(db.deleteCustomer).not.toHaveBeenCalled();
    expect(db.deleteUser).not.toHaveBeenCalled();
  });

  it("rejects an owner-only edit and the audit log read for a driver", async () => {
    const err = await makeCaller(driver)
      .admin.editOrder({ id: ORDER_ID, notes: "x" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("FORBIDDEN");

    const auditErr = await makeCaller(driver).admin.auditLog({}).catch((e) => e);
    expect(auditErr).toBeInstanceOf(TRPCError);
    expect((auditErr as TRPCError).code).toBe("FORBIDDEN");
  });

  it("deletes an order, writes an audit entry, and reports what was removed", async () => {
    const summary = {
      lineItems: 2,
      invoices: 1,
      trackingPings: 3,
      stockMovements: 2,
      customerReceiptsKept: 1,
      releasesStock: [{ name: "Concrete Mixer", qty: 1 }],
    };
    vi.mocked(db.orderCascadeSummary).mockResolvedValue(summary as never);
    vi.mocked(db.deleteOrder).mockResolvedValue({ id: ORDER_ID } as never);

    const res = await makeCaller(owner).admin.deleteOrder({ id: ORDER_ID });
    expect(res).toEqual(summary);

    expect(db.writeAuditLog).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(db.writeAuditLog).mock.calls[0][0];
    expect(entry.action).toBe("delete");
    expect(entry.entity).toBe("order");
    expect(entry.targetId).toBe(ORDER_ID);
    expect(entry.summary).toMatch(/3 tracking ping/i);
    expect(entry.summary).toMatch(/receipt\(s\) stay/i);
  });

  it("does not audit a delete that failed", async () => {
    vi.mocked(db.orderCascadeSummary).mockResolvedValue(null as never);
    vi.mocked(db.deleteOrder).mockResolvedValue(null as never);

    const err = await makeCaller(owner).admin.deleteOrder({ id: ORDER_ID }).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("NOT_FOUND");
    // A trail entry for something that did not happen would be worse than none.
    expect(db.writeAuditLog).not.toHaveBeenCalled();
  });

  it("edits an order that is already on rent and audits the change", async () => {
    const before = { order: { status: "on_rent", customerName: "Himalaya Builders" }, items: [{}] };
    const after = { order: { status: "on_rent", customerName: "Himalaya Builders" }, items: [{}, {}] };
    vi.mocked(db.editOrderAnyStage).mockResolvedValue({ before, after } as never);

    const res = await makeCaller(owner).admin.editOrder({
      id: ORDER_ID,
      notes: "corrected at the yard",
    });
    expect(res).toEqual(after);
    expect(db.writeAuditLog).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(db.writeAuditLog).mock.calls[0][0];
    expect(entry.action).toBe("update");
    expect(entry.entity).toBe("order");
  });

  it("refuses to set equipment quantity below what is on rent", async () => {
    vi.mocked(db.editEquipmentAnyStage).mockResolvedValue({
      ok: false,
      reason: "below_on_rent",
      onRentQty: 4,
    } as never);

    const err = await makeCaller(owner)
      .admin.editEquipment({ id: ORDER_ID, totalQty: 2 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("BAD_REQUEST");
    expect((err as TRPCError).message).toMatch(/4 currently on rent/i);
  });

  it("refuses to let the owner delete their own account", async () => {
    vi.mocked(db.userCascadeSummary).mockResolvedValue({ userName: "Sharma", isDriver: false } as never);
    vi.mocked(db.deleteUser).mockResolvedValue({ ok: false, reason: "is_owner" } as never);

    const err = await makeCaller(owner).admin.deleteUser({ id: ORDER_ID }).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("BAD_REQUEST");
    expect((err as TRPCError).message).toMatch(/cannot delete your own/i);
    expect(db.writeAuditLog).not.toHaveBeenCalled();
  });
});

// ── transit identity: the trip belongs to the LOCKER, not the creator ────────
//
// An order taken by Kabiraj (vehicle 2754) and locked for dispatch by Bikash
// (vehicle 2769) is being carried by Bikash in 2769. The in-transit and tracking
// views must therefore name Bikash and 2769, while the order keeps Kabiraj on
// record as its creator. These pin the two halves of that: what the lock WRITES,
// and what the reads return.

describe("orders.lock — the locker's vehicle becomes the trip's vehicle", () => {
  const driver = { c: {} as never, db: {} as never, user: { id: "driver-user" } as never };
  const KABIRAJS_TRUCK = "22222222-2222-4222-8222-222222222222";
  const BIKASHS_TRUCK = "33333333-3333-4333-8333-333333333333";
  // The locker is a DIFFERENT driver from the order's assignee — that difference
  // is the whole scenario, so they get distinct ids.
  const LOCKER_DRIVER_ID = "44444444-4444-4444-8444-444444444444";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.accountIdFor).mockResolvedValue("owner-1" as never);
    vi.mocked(db.getDriverByUserId).mockResolvedValue({ id: LOCKER_DRIVER_ID } as never);
    vi.mocked(db.lockOrderForDispatch).mockResolvedValue({ id: ORDER_ID } as never);
  });

  it("snapshots the locking driver's own vehicle, not the order's", async () => {
    // The order was created with Kabiraj's truck; Bikash is driving the other one.
    vi.mocked(db.getAssignment).mockResolvedValue({ vehicleId: BIKASHS_TRUCK } as never);

    await makeCaller(driver).orders.lock({ id: ORDER_ID });

    const [, orderArg, driverArg, vehicleArg] = vi.mocked(db.lockOrderForDispatch).mock.calls.at(-1)!;
    expect(orderArg).toBe(ORDER_ID);
    expect(driverArg).toBe(LOCKER_DRIVER_ID); // the locker, not the creator
    expect(vehicleArg).toBe(BIKASHS_TRUCK);
    expect(vehicleArg).not.toBe(KABIRAJS_TRUCK);
  });

  it("records NO vehicle rather than borrowing the creating driver's", async () => {
    // The locker has no assignment today. Falling back to the order's vehicle here
    // is exactly the bug: it would put the creator's truck on the road.
    vi.mocked(db.getAssignment).mockResolvedValue(undefined as never);

    await makeCaller(driver).orders.lock({ id: ORDER_ID });

    const [, , , vehicleArg] = vi.mocked(db.lockOrderForDispatch).mock.calls.at(-1)!;
    expect(vehicleArg).toBeNull();
  });

  it("refuses to lock for a caller who is not a driver", async () => {
    vi.mocked(db.getDriverByUserId).mockResolvedValue(undefined as never);

    const err = await makeCaller(driver).orders.lock({ id: ORDER_ID }).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("FORBIDDEN");
    expect(db.lockOrderForDispatch).not.toHaveBeenCalled();
  });
});

// ── driver roster: add, rename, remove without losing history ───────────────

describe("drivers — owner-only roster management", () => {
  const owner = { c: {} as never, db: {} as never, user: { id: "owner-1" } as never };
  const driver = { c: {} as never, db: {} as never, user: { id: "driver-user" } as never };
  // The procedures validate with `z.uuid()`, so fixtures must be real UUIDs.
  const DRIVER_ROW_ID = "55555555-5555-4555-8555-555555555555";
  const NEW_DRIVER_ID = "66666666-6666-4666-8666-666666666666";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.accountIdFor).mockResolvedValue("owner-1" as never);
    vi.mocked(db.getProfile).mockImplementation(async (id: string) =>
      ({ id, role: id === "owner-1" ? "owner" : "driver" }) as never,
    );
  });

  it("lets the owner add a driver", async () => {
    vi.mocked(db.createDriverRow).mockResolvedValue({ id: NEW_DRIVER_ID, name: "Bikash" } as never);

    const res = await makeCaller(owner).drivers.create({ name: "Bikash", phone: "9800000000" });

    expect(res).toEqual({ id: NEW_DRIVER_ID, name: "Bikash" });
    expect(db.createDriverRow).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "owner-1", name: "Bikash", phone: "9800000000" }),
    );
  });

  it("refuses to let a driver add one", async () => {
    const err = await makeCaller(driver).drivers.create({ name: "Sneaky" }).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("FORBIDDEN");
    expect(db.createDriverRow).not.toHaveBeenCalled();
  });

  it("removes a driver by deactivating — history is never deleted", async () => {
    vi.mocked(db.deactivateDriver).mockResolvedValue({
      ok: true,
      mode: "deactivated",
      summary: { driverName: "Kabiraj", ordersInvolved: 3, trackingPings: 40, assignments: 2, stockMovements: 1 },
      driver: { id: DRIVER_ROW_ID },
    } as never);

    const res = await makeCaller(owner).drivers.remove({ id: DRIVER_ROW_ID });

    expect(res.ok).toBe(true);
    expect(res.mode).toBe("deactivated");
    expect(db.deactivateDriver).toHaveBeenCalledWith("owner-1", DRIVER_ROW_ID);
    // Who removed whom, and why the record was kept, is in the audit trail.
    expect(db.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "delete", entity: "driver", targetId: DRIVER_ROW_ID }),
    );
  });

  it("explains rather than failing silently when the driver is on an active trip", async () => {
    vi.mocked(db.deactivateDriver).mockResolvedValue({ ok: false, reason: "on_active_trip" } as never);

    const err = await makeCaller(owner).drivers.remove({ id: DRIVER_ROW_ID }).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("CONFLICT");
    expect((err as TRPCError).message).toMatch(/active trip/i);
  });

  it("refuses to let a driver remove anyone", async () => {
    const err = await makeCaller(driver).drivers.remove({ id: DRIVER_ROW_ID }).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("FORBIDDEN");
    expect(db.deactivateDriver).not.toHaveBeenCalled();
  });

  it("renames the driver ROW, so an order's history renames with it", async () => {
    vi.mocked(db.editDriverRow).mockResolvedValue({
      ok: true,
      before: { id: DRIVER_ROW_ID, name: "Bikash", phone: null, licenseNo: null },
      after: { id: DRIVER_ROW_ID, name: "Bikash Thapa" },
    } as never);

    await makeCaller(owner).drivers.update({ id: DRIVER_ROW_ID, name: "Bikash Thapa" });

    // `vehicleId` is omitted, so today's assignment is left exactly as it was.
    expect(db.editDriverRow).toHaveBeenCalledWith("owner-1", DRIVER_ROW_ID, {
      name: "Bikash Thapa",
      phone: undefined,
      licenseNo: undefined,
      vehicleId: undefined,
    });
    expect(db.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "update", entity: "driver", targetId: DRIVER_ROW_ID }),
    );
  });

  it("refuses a duplicate phone number, naming the driver who already has it", async () => {
    vi.mocked(db.editDriverRow).mockResolvedValue({
      ok: false,
      reason: "duplicate_phone",
      clash: { id: "other", name: "Sita" },
    } as never);

    const err = await makeCaller(owner)
      .drivers.update({ id: DRIVER_ROW_ID, phone: "9800000001" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("CONFLICT");
    expect((err as TRPCError).message).toMatch(/Sita/);
    expect(db.writeAuditLog).not.toHaveBeenCalled();
  });

  it("says so when the driver has locked an order and cannot be removed", async () => {
    vi.mocked(db.deactivateDriver).mockResolvedValue({
      ok: false,
      reason: "on_active_trip",
      summary: { activeTripStatus: "on_transit" },
    } as never);

    const err = await makeCaller(owner).drivers.remove({ id: DRIVER_ROW_ID }).catch((e) => e);

    expect((err as TRPCError).code).toBe("CONFLICT");
    expect((err as TRPCError).message).toMatch(/locked an order|only the driver who locked/i);
  });
});

// ── vehicles: owner-only full CRUD ──────────────────────────────────────────
describe("vehicles — owner-only edit and delete", () => {
  const owner = { c: {} as never, db: {} as never, user: { id: "owner-1" } as never };
  const driver = { c: {} as never, db: {} as never, user: { id: "driver-user" } as never };
  const VEHICLE_ID = "77777777-7777-4777-8777-777777777777";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.accountIdFor).mockResolvedValue("owner-1" as never);
    vi.mocked(db.getProfile).mockImplementation(async (id: string) =>
      ({ id, role: id === "owner-1" ? "owner" : "driver" }) as never,
    );
    vi.mocked(db.writeAuditLog).mockResolvedValue(undefined as never);
  });

  it("edits every field of a vehicle and records the before/after values", async () => {
    vi.mocked(db.editVehicleRow).mockResolvedValue({
      ok: true,
      before: { id: VEHICLE_ID, name: "Truck 1", number: "BA 1 KHA 1234", type: "Truck" },
      after: { id: VEHICLE_ID, name: "Truck One", number: "BA 9 KHA 9999", type: "Tipper" },
    } as never);

    await makeCaller(owner).vehicles.update({
      id: VEHICLE_ID,
      name: "Truck One",
      number: "BA 9 KHA 9999",
      type: "Tipper",
    });

    expect(db.editVehicleRow).toHaveBeenCalledWith("owner-1", VEHICLE_ID, {
      name: "Truck One",
      number: "BA 9 KHA 9999",
      type: "Tipper",
    });
    const audit = vi.mocked(db.writeAuditLog).mock.calls[0][0] as unknown as {
      detail: { before: Record<string, unknown>; after: Record<string, unknown> };
    };
    expect(audit.detail.before.number).toBe("BA 1 KHA 1234");
    expect(audit.detail.after.number).toBe("BA 9 KHA 9999");
  });

  it("refuses a duplicate number plate", async () => {
    vi.mocked(db.editVehicleRow).mockResolvedValue({
      ok: false,
      reason: "duplicate",
      clash: { id: "other", name: "Tipper 1" },
    } as never);

    const err = await makeCaller(owner)
      .vehicles.update({ id: VEHICLE_ID, number: "BA 3 KHA 3456" })
      .catch((e) => e);

    expect((err as TRPCError).code).toBe("CONFLICT");
    expect((err as TRPCError).message).toMatch(/Tipper 1/);
  });

  it("retires a vehicle that history still names instead of deleting its row", async () => {
    vi.mocked(db.deleteVehicle).mockResolvedValue({
      ok: true,
      mode: "retired",
      summary: { vehicleName: "Truck 1", number: "BA 1 KHA 1234", ordersAssigned: 4, assignments: 2, auditEntries: 1 },
    } as never);

    const res = await makeCaller(owner).vehicles.remove({ id: VEHICLE_ID });

    expect(res.mode).toBe("retired");
    expect(db.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "delete", entity: "vehicle", targetId: VEHICLE_ID }),
    );
  });

  it("really deletes a vehicle nothing refers to", async () => {
    vi.mocked(db.deleteVehicle).mockResolvedValue({
      ok: true,
      mode: "deleted",
      summary: { vehicleName: "Spare", number: "BA 0 KHA 0000", ordersAssigned: 0, assignments: 0, auditEntries: 0 },
    } as never);

    const res = await makeCaller(owner).vehicles.remove({ id: VEHICLE_ID });

    expect(res.mode).toBe("deleted");
  });

  it("refuses to retire a vehicle that is on an active trip", async () => {
    vi.mocked(db.deleteVehicle).mockResolvedValue({ ok: false, reason: "on_active_trip" } as never);

    const err = await makeCaller(owner).vehicles.remove({ id: VEHICLE_ID }).catch((e) => e);

    expect((err as TRPCError).code).toBe("CONFLICT");
    expect((err as TRPCError).message).toMatch(/active trip/i);
    expect(db.writeAuditLog).not.toHaveBeenCalled();
  });

  it("refuses a duplicate plate when adding a vehicle", async () => {
    vi.mocked(db.findVehicleByNumber).mockResolvedValue({ id: "x", name: "Tipper 2", number: "BA 4 KHA 4567" } as never);

    const err = await makeCaller(owner)
      .vehicles.create({ name: "Truck 9", number: "BA 4 KHA 4567" })
      .catch((e) => e);

    expect((err as TRPCError).code).toBe("CONFLICT");
    expect(db.createVehicle).not.toHaveBeenCalled();
  });

  it("puts a retired vehicle back into service", async () => {
    vi.mocked(db.reactivateVehicle).mockResolvedValue({ id: VEHICLE_ID, name: "Truck 1", number: "BA 1 KHA 1234" } as never);

    await makeCaller(owner).vehicles.restore({ id: VEHICLE_ID });

    expect(db.reactivateVehicle).toHaveBeenCalledWith("owner-1", VEHICLE_ID);
  });

  it("forbids a driver from every vehicle write", async () => {
    const caller = makeCaller(driver);
    const attempts = [
      caller.vehicles.create({ name: "Sneaky", number: "BA 0 KHA 0001" }),
      caller.vehicles.update({ id: VEHICLE_ID, name: "Sneaky" }),
      caller.vehicles.remove({ id: VEHICLE_ID }),
      caller.vehicles.restore({ id: VEHICLE_ID }),
      caller.vehicles.deletePreview({ id: VEHICLE_ID }),
    ];

    for (const attempt of attempts) {
      const err = await attempt.catch((e) => e);
      expect((err as TRPCError).code).toBe("FORBIDDEN");
    }
    expect(db.createVehicle).not.toHaveBeenCalled();
    expect(db.editVehicleRow).not.toHaveBeenCalled();
    expect(db.deleteVehicle).not.toHaveBeenCalled();
  });
});

