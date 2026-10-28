// ── AGENT-OWNED: tRPC API surface ─────────────────────────────────────────────
// Thin procedures: validate with zod, call server/db.ts, map expected failures to
// TRPCErrors. Auth is provided by _core — never reimplemented here.
import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Context as HonoContext } from "hono";
import { hash as bcryptHash, compare as bcryptCompare } from "bcryptjs";
import { router, publicProcedure, protectedProcedure } from "./_core/trpc";
import { authProvider, registerLocalUser, AuthError, EmailTakenError } from "./_core/auth";
import { storageCommit, storageDeleteOwned, storageListByOwner, storagePutUrl, StorageError } from "./_core/storage";
import * as q from "./db";
import { kathmanduToday } from "../shared/bs-calendar";
import { listCustomers } from "./db";
import { sendMail, otpEmail } from "./services/smtp-mail";
import { adminRouter } from "./admin-router";

/**
 * Dev-mode flag. Read straight from process.env on purpose: importing _core/env
 * here would make merely importing this router require DATABASE_URL (env.ts
 * validates it at module load), which breaks the router's own unit tests.
 * NODE_ENV is not a secret, so it needs no Settings entry.
 */
const IS_PROD = process.env.NODE_ENV === "production";

// ── forgot-password tuning ──
/** How long a mailed code stays valid. */
const RESET_TTL_MS = 10 * 60_000;
/** Wrong guesses allowed against one code before it must be re-requested. */
const RESET_MAX_ATTEMPTS = 5;
/** Shortest gap between two requests from the same IP. */
const RESET_COOLDOWN_MS = 60_000;
/** Requests allowed per user (and per IP) inside RESET_WINDOW_MS. */
const RESET_MAX_PER_WINDOW = 5;
const RESET_WINDOW_MS = 60 * 60_000;

/** Best-effort client IP for the per-IP rate limit. */
function clientIp(c: HonoContext): string {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return c.req.header("x-real-ip") ?? "unknown";
}

/** Cryptographically random 6-digit code. */
function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Stable per-instance salt for the hashed requester address. The address is only
 * ever needed to answer "same requester?" — never displayed — so hashing it
 * keeps a plaintext IP out of the database while the per-IP rate limit still
 * works.
 */
const IP_SALT = randomInt(0, 2 ** 31).toString(36) + Date.now().toString(36);

function hashIp(ip: string): string {
  return createHash("sha256").update(`${IP_SALT}:${ip}`).digest("hex").slice(0, 32);
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function requireOwner(userId: string) {
  const profile = await q.getProfile(userId);
  if (!profile || profile.role !== "owner") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only the owner can do this." });
  }
  return profile;
}

async function resolveDriver(accountId: string, userId: string) {
  return q.getDriverByUserId(accountId, userId);
}

/** Display name for stock movements: the driver's roster name, else the profile
 *  name. Snapshotted onto the movement so it still reads right after a roster
 *  change. */
async function actorNameFor(userId: string, accountId: string): Promise<string | null> {
  const d = await q.getDriverByUserId(accountId, userId);
  if (d?.name) return d.name;
  const p = await q.getProfile(userId);
  return p?.displayName ?? null;
}

const basisEnum = z.enum(["day", "hour", "pillar"]);

const orderItemSchema = z.object({
  equipmentId: z.uuid(),
  basis: basisEnum,
  rate: z.number().min(0),
  actualQty: z.number().min(0),
  billedQty: z.number().min(0),
  units: z.number().min(0),
});

// ── auth ─────────────────────────────────────────────────────────────────────

const authRouter = router({
  me: publicProcedure.query(({ ctx }) => ctx.user),

  // Bootstrap: the FIRST signup becomes the Owner/Admin. After that, accounts
  // are created by the owner (see users.createDriver).
  signup: publicProcedure
    .input(z.object({ email: z.email(), password: z.string().min(8), name: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const owners = await q.countOwners();
      if (owners > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "An owner account already exists. Ask your owner to create your login.",
        });
      }
      try {
        const user = await registerLocalUser(input.email, input.password, input.name);
        await q.ensureOwnerProfile(user.id, input.name ?? null);
        await q.seedDemoData(user.id);
        await authProvider().login(ctx.c, input.email, input.password);
        return user;
      } catch (e: unknown) {
        if (e instanceof EmailTakenError) throw new TRPCError({ code: "CONFLICT", message: e.message });
        throw e;
      }
    }),

  // Accepts an email, a username, or a phone number as the identifier, so a
  // driver created without an email can still sign in.
  login: publicProcedure
    .input(z.object({ email: z.string().min(1), password: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const email = await q.resolveLoginEmail(input.email);
        if (!email) throw new AuthError("Invalid username or password");
        return await authProvider().login(ctx.c, email, input.password);
      } catch (e) {
        if (e instanceof AuthError) throw new TRPCError({ code: "UNAUTHORIZED", message: e.message });
        throw e;
      }
    }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    await authProvider().logout(ctx.c);
    return { ok: true };
  }),

  // ── forgot password: mailed 6-digit code ───────────────────────────────────
  //
  // The requested code is stored bcrypt-HASHED, expires after RESET_TTL_MS, is
  // single-use, and is capped at RESET_MAX_ATTEMPTS wrong guesses so a 6-digit
  // code cannot be brute-forced. Requests are rate-limited per IP (with a
  // resend cooldown) AND per account.
  //
  // `request` deliberately returns the SAME shape for a known and an unknown
  // address, so the endpoint cannot be used to enumerate who has an account.
  requestPasswordReset: publicProcedure
    .input(z.object({ email: z.string().min(3) }))
    .mutation(async ({ ctx, input }) => {
      const ip = hashIp(clientIp(ctx.c));
      const windowStart = new Date(Date.now() - RESET_WINDOW_MS);

      if ((await q.countResetRequestsForIp(ip, windowStart)) >= RESET_MAX_PER_WINDOW) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many reset requests from this device. Please try again in an hour.",
        });
      }
      const last = await q.latestResetRequestForIp(ip);
      if (last) {
        const elapsed = Date.now() - new Date(last.createdAt).getTime();
        if (elapsed < RESET_COOLDOWN_MS) {
          const wait = Math.ceil((RESET_COOLDOWN_MS - elapsed) / 1000);
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: `Please wait ${wait}s before requesting another code.`,
          });
        }
      }

      const user = await q.findUserByEmail(input.email);
      if (!user) return { ok: true, sent: false, status: "unknown" as const };

      if ((await q.countResetRequestsForUser(user.id, windowStart)) >= RESET_MAX_PER_WINDOW) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many reset requests for this account. Please try again in an hour.",
        });
      }

      const otp = generateOtp();
      await q.createResetCode({
        userId: user.id,
        codeHash: await bcryptHash(otp, 10),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
        requestIp: ip,
      });

      const { text, html } = otpEmail(otp, Math.round(RESET_TTL_MS / 60_000));
      const mail = await sendMail({
        to: user.email,
        subject: "Your password reset code",
        text,
        html,
      });

      // Without SMTP there is no way to deliver the code, which would make the
      // flow untestable. Log it, and (outside production only) hand it back so
      // the screen can show it in a clearly-labelled testing notice. In
      // production neither happens.
      const unwired = !mail.sent;
      if (unwired) console.warn(`[otp] ${user.email} code=${otp} (SMTP ${mail.status})`);

      return {
        ok: true,
        sent: mail.sent,
        status: mail.status,
        devCode: unwired && !IS_PROD ? otp : null,
        expiresInMinutes: Math.round(RESET_TTL_MS / 60_000),
      };
    }),

  // Step 2: check the code before asking for a new password, so a wrong code
  // does not make the user type a password twice.
  verifyResetCode: publicProcedure
    .input(z.object({ email: z.string().min(3), code: z.string().min(4) }))
    .mutation(async ({ input }) => {
      await assertResetCode(input.email, input.code);
      return { ok: true };
    }),

  // Step 3: consume the code and set the new password.
  resetPassword: publicProcedure
    .input(z.object({ email: z.string().min(3), code: z.string().min(4), password: z.string().min(8) }))
    .mutation(async ({ input }) => {
      const row = await assertResetCode(input.email, input.code);
      // Single-use: the guarded UPDATE is the lock, so two racing calls cannot
      // both reset the password.
      if (!(await q.consumeResetCode(row.id))) {
        throw new TRPCError({ code: "CONFLICT", message: "That code has already been used." });
      }
      await q.setUserPassword(row.userId, await bcryptHash(input.password, 10));
      return { ok: true };
    }),
});

/**
 * Shared code check for steps 2 and 3. Returns the live code row, or throws the
 * same generic UNAUTHORIZED message for every failure mode — a wrong code, an
 * expired one, and an address with no account must be indistinguishable.
 */
async function assertResetCode(email: string, code: string) {
  const invalid = new TRPCError({ code: "UNAUTHORIZED", message: "That code is not valid or has expired." });

  const user = await q.findUserByEmail(email);
  if (!user) throw invalid;

  const row = await q.activeResetCode(user.id);
  if (!row) throw invalid;
  if (new Date(row.expiresAt).getTime() < Date.now()) throw invalid;
  if (row.attempts >= RESET_MAX_ATTEMPTS) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Too many wrong attempts. Please request a new code.",
    });
  }
  if (!(await bcryptCompare(code.trim(), row.codeHash))) {
    await q.bumpResetAttempts(row.id);
    throw invalid;
  }
  return row;
}

// ── account ──────────────────────────────────────────────────────────────────

const accountRouter = router({
  me: protectedProcedure.query(async ({ ctx }) => {
    const profile = await q.getProfile(ctx.user.id);
    const accountId = profile?.ownerId ?? ctx.user.id;
    const driver = profile?.role === "driver" ? await resolveDriver(accountId, ctx.user.id) : null;
    return {
      userId: ctx.user.id,
      email: ctx.user.email,
      name: ctx.user.name,
      role: profile?.role ?? "owner",
      displayName: profile?.displayName ?? ctx.user.name,
      phone: profile?.phone ?? null,
      accountId,
      driverId: driver?.id ?? null,
      driverName: driver?.name ?? null,
    };
  }),

  seed: protectedProcedure.mutation(async ({ ctx }) => {
    const accountId = await q.accountIdFor(ctx.user.id);
    return q.seedDemoData(accountId);
  }),
});

// ── customers ────────────────────────────────────────────────────────────────

const customersRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const accountId = await q.accountIdFor(ctx.user.id);
    const rows = await q.listCustomers(accountId);
    const profile = await q.getProfile(ctx.user.id);
    // Money is owner-only: drivers get the plain list with no due balance.
    if (profile?.role !== "owner") return rows.map((c) => ({ ...c, openingBalance: 0, due: 0, moneyHidden: true }));
    const dues = await q.customerDueMap(accountId);
    return rows.map((c) => ({ ...c, due: dues.get(c.id) ?? 0, moneyHidden: false }));
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        phone: z.string().optional(),
        address: z.string().optional(),
        openingBalance: z.number().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const accountId = await q.accountIdFor(ctx.user.id);
      const profile = await q.getProfile(ctx.user.id);
      const created = await q.createCustomer({ ownerId: accountId, ...input });
      // Only the owner may seed a carried-in opening due.
      const opening = profile?.role === "owner" ? (input.openingBalance ?? 0) : 0;
      if (opening > 0) await q.setCustomerOpeningBalance(accountId, created.id, opening);
      return created;
    }),

  // Full customer ledger: opening balance, invoices (debits), receipts (credits),
  // running/closing due. Owner only.
  ledger: protectedProcedure.input(z.object({ customerId: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const ledger = await q.getCustomerLedger(accountId, input.customerId);
    if (!ledger) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found." });
    return ledger;
  }),

  // Set the carried-in opening due on a customer (owner only).
  setOpeningBalance: protectedProcedure
    .input(z.object({ customerId: z.uuid(), openingBalance: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const row = await q.setCustomerOpeningBalance(accountId, input.customerId, input.openingBalance);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found." });
      return row;
    }),
});

// ── receipts (money received from a customer) ────────────────────────────────

const RECEIPT_MODES = ["cash", "bank", "cheque", "mobile"] as const;

const receiptsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    await requireOwner(ctx.user.id);
    return q.listReceipts(await q.accountIdFor(ctx.user.id));
  }),

  create: protectedProcedure
    .input(
      z.object({
        customerId: z.uuid(),
        amount: z.number().positive("Enter the amount received."),
        mode: z.enum(RECEIPT_MODES),
        referenceNo: z.string().max(120).optional(),
        notes: z.string().max(2000).optional(),
        dateAd: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date")
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      // The customer must belong to this business.
      const customers = await q.listCustomers(accountId);
      if (!customers.some((c) => c.id === input.customerId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a customer from this business." });
      }
      return q.createReceipt({ ownerId: accountId, ...input });
    }),

  remove: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    if (!(await q.deleteReceipt(accountId, input.id))) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Receipt not found." });
    }
    return { ok: true };
  }),
});

// ── vehicles ─────────────────────────────────────────────────────────────────

const vehiclesRouter = router({
  // Every vehicle this business has owned, with `isActive` so the fleet page can
  // show a retired truck without losing it. PICKERS MUST USE `active`.
  list: protectedProcedure.query(async ({ ctx }) => q.listVehicles(await q.accountIdFor(ctx.user.id))),

  /** The trucks still in service — what every picker offers. */
  active: protectedProcedure.query(async ({ ctx }) => q.listActiveVehicles(await q.accountIdFor(ctx.user.id))),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1, "Give the vehicle a name."),
        number: z.string().min(1, "Give the vehicle a number plate."),
        type: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const clash = await q.findVehicleByNumber(accountId, input.number);
      if (clash) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `That number plate is already used by ${clash.name}.`,
        });
      }
      const row = await q.createVehicle({ ownerId: accountId, ...input });
      await q.writeAuditLog({
        ownerId: accountId,
        actorUserId: ctx.user.id,
        actorName: await actorNameFor(ctx.user.id, accountId),
        action: "create",
        entity: "vehicle",
        targetId: row.id,
        targetLabel: `${row.name} (${row.number})`,
        summary: `Added vehicle ${row.name} (${row.number}).`,
        detail: { name: row.name, number: row.number, type: row.type },
      });
      return row;
    }),

  /** What removing this vehicle would touch, so the dialog can state it. */
  deletePreview: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.vehicleCascadeSummary(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Vehicle not found." });
    return summary;
  }),

  /**
   * Edit every field of a vehicle (owner only).
   *
   * A plate typo, a wrong model, a capacity typed on the wrong row — all of it is
   * correctable. The number stays unique within the business, and the audit entry
   * records the before/after values rather than just "edited".
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().min(1, "Give the vehicle a name.").max(200).optional(),
        number: z.string().min(1, "Give the vehicle a number plate.").max(50).optional(),
        type: z.string().max(100).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const { id, ...patch } = input;
      const res = await q.editVehicleRow(accountId, id, patch);
      if (!res.ok) {
        if (res.reason === "not_found") throw new TRPCError({ code: "NOT_FOUND", message: "Vehicle not found." });
        throw new TRPCError({
          code: "CONFLICT",
          message: `That number plate is already used by ${res.clash.name}.`,
        });
      }
      const changed = Object.keys(patch).filter((k) => k in (res.after as Record<string, unknown>));
      await q.writeAuditLog({
        ownerId: accountId,
        actorUserId: ctx.user.id,
        actorName: await actorNameFor(ctx.user.id, accountId),
        action: "update",
        entity: "vehicle",
        targetId: id,
        targetLabel: `${res.after.name} (${res.after.number})`,
        summary: `Edited vehicle ${res.before.name} (${res.before.number}).`,
        detail: {
          changed,
          before: { name: res.before.name, number: res.before.number, type: res.before.type },
          after: { name: res.after.name, number: res.after.number, type: res.after.type },
        },
      });
      return res.after;
    }),

  /**
   * Remove a vehicle from the fleet (owner only).
   *
   * Retires rather than deletes when anything still names it, and refuses outright
   * while it is on an active trip. The caller is told which happened, so the UI
   * never claims "deleted" about a truck that was actually archived.
   */
  remove: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const res = await q.deleteVehicle(accountId, input.id);
    if (!res.ok) {
      if (res.reason === "not_found") throw new TRPCError({ code: "NOT_FOUND", message: "Vehicle not found." });
      if (res.reason === "already_retired") {
        throw new TRPCError({ code: "CONFLICT", message: "That vehicle has already been retired." });
      }
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "That vehicle is on an active trip. Mark the trip returned (or undo the lock) before removing it.",
      });
    }
    await q.writeAuditLog({
      ownerId: accountId,
      actorUserId: ctx.user.id,
      actorName: await actorNameFor(ctx.user.id, accountId),
      action: "delete",
      entity: "vehicle",
      targetId: input.id,
      targetLabel: `${res.summary.vehicleName} (${res.summary.number})`,
      summary:
        res.mode === "retired"
          ? `Retired vehicle ${res.summary.vehicleName} (${res.summary.number}) — kept on record because ` +
            `${res.summary.ordersAssigned} order(s), ${res.summary.assignments} assignment(s) and ` +
            `${res.summary.auditEntries} audit entr(ies) still name it.`
          : `Deleted vehicle ${res.summary.vehicleName} (${res.summary.number}) — nothing referred to it.`,
      detail: { mode: res.mode, ...res.summary, orderIds: undefined },
    });
    return { ok: true, mode: res.mode, summary: res.summary };
  }),

  /** Put a retired vehicle back into service (owner only). */
  restore: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const row = await q.reactivateVehicle(accountId, input.id);
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Vehicle not found." });
    await q.writeAuditLog({
      ownerId: accountId,
      actorUserId: ctx.user.id,
      actorName: await actorNameFor(ctx.user.id, accountId),
      action: "update",
      entity: "vehicle",
      targetId: input.id,
      targetLabel: `${row.name} (${row.number})`,
      summary: `Put vehicle ${row.name} (${row.number}) back into service.`,
      detail: { isActive: true },
    });
    return row;
  }),
});

// ── drivers ──────────────────────────────────────────────────────────────────

const driversRouter = router({
  // Every driver who has ever been on the roster, with `isActive` so the owner
  // page can show who has been removed without losing their history.
  list: protectedProcedure.query(async ({ ctx }) => q.listDrivers(await q.accountIdFor(ctx.user.id))),

  // Just the roster — what a picker should offer. A driver's own screens and the
  // order editor must not be able to select somebody who has been removed.
  active: protectedProcedure.query(async ({ ctx }) => q.listActiveDrivers(await q.accountIdFor(ctx.user.id))),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        phone: z.string().optional(),
        licenseNo: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      return q.createDriverRow({ ownerId: accountId, ...input });
    }),

  // What removing this driver from the roster affects. Nothing is deleted, so
  // the dialog states how much history still names them.
  deletePreview: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.driverDeleteSummary(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Driver not found." });
    return summary;
  }),

  /**
   * Remove a driver from the roster (owner only).
   *
   * With no history at all the row is genuinely deleted. With history it is a
   * DEACTIVATION: their orders, routes, stock movements and the audit trail keep
   * naming them, so removing somebody from the team never rewrites the past.
   * Refused while they hold an order — locked for dispatch or carrying it on the
   * road — because nobody else can dispatch a locked order and their location is
   * what the owner's map is following.
   */
  remove: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const res = await q.deactivateDriver(accountId, input.id);
    if (!res.ok) {
      if (res.reason === "not_found") {
        throw new TRPCError({ code: "NOT_FOUND", message: "Driver not found." });
      }
      if (res.reason === "already_inactive") {
        throw new TRPCError({ code: "CONFLICT", message: "That driver has already been removed." });
      }
      throw new TRPCError({
        code: "CONFLICT",
        message:
          res.summary?.activeTripStatus === "on_transit"
            ? "That driver has locked an order for dispatch. Lock it undone or dispatched first — only the driver who locked an order can dispatch it."
            : "That driver is on an active trip. Mark the trip returned (or undo the return) first.",
      });
    }
    await q.writeAuditLog({
      ownerId: accountId,
      actorUserId: ctx.user.id,
      actorName: await actorNameFor(ctx.user.id, accountId),
      action: "delete",
      entity: "driver",
      targetId: input.id,
      targetLabel: res.summary.driverName,
      summary:
        res.mode === "deleted"
          ? `Deleted driver ${res.summary.driverName} — nothing referred to them.`
          : `Removed ${res.summary.driverName} from the roster — kept on record because ` +
            `${res.summary.ordersInvolved} order(s), ${res.summary.stockMovements} stock movement(s) and ` +
            `${res.summary.trackingPings} tracking ping(s) still name them.`,
      detail: { mode: res.mode, ...res.summary },
    });
    return { ok: true, mode: res.mode, summary: res.summary };
  }),

  /** Put a removed driver back on the roster (owner only). */
  restore: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const row = await q.reactivateDriver(accountId, input.id);
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Driver not found." });
    await q.writeAuditLog({
      ownerId: accountId,
      actorUserId: ctx.user.id,
      actorName: await actorNameFor(ctx.user.id, accountId),
      action: "update",
      entity: "driver",
      targetId: input.id,
      targetLabel: row.name,
      summary: `Put ${row.name} back on the roster.`,
      detail: { isActive: true },
    });
    return row;
  }),

  /**
   * Edit every field of a driver (owner only): name, phone, licence, and the
   * vehicle they are driving today.
   *
   * This edits the DRIVER ROW, which is the name orders and the live map show —
   * not the login. A driver without a login is a perfectly normal roster entry
   * (they take orders on paper), so editing one must not require a user account.
   * The phone stays unique: it doubles as a login handle, and two drivers sharing
   * one would be ambiguous at the sign-in screen.
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().min(1, "Give the driver a name.").max(200).optional(),
        phone: z.string().max(50).nullish(),
        licenseNo: z.string().max(50).nullish(),
        /** Today's vehicle. null clears it; omitted leaves it alone. */
        vehicleId: z.uuid().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const { id, ...patch } = input;
      const res = await q.editDriverRow(accountId, id, patch);
      if (!res.ok) {
        if (res.reason === "not_found") throw new TRPCError({ code: "NOT_FOUND", message: "Driver not found." });
        if (res.reason === "duplicate_phone") {
          throw new TRPCError({
            code: "CONFLICT",
            message: `That phone number is already used by ${res.clash.name}.`,
          });
        }
        if (res.reason === "retired_vehicle") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "That vehicle has been retired. Put it back into service first.",
          });
        }
        throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a vehicle from this business." });
      }
      await q.writeAuditLog({
        ownerId: accountId,
        actorUserId: ctx.user.id,
        actorName: await actorNameFor(ctx.user.id, accountId),
        action: "update",
        entity: "driver",
        targetId: id,
        targetLabel: res.after.name,
        summary: `Edited driver ${res.before.name}.`,
        detail: {
          before: {
            name: res.before.name,
            phone: res.before.phone,
            licenseNo: res.before.licenseNo,
          },
          after: { name: res.after.name, phone: res.after.phone, licenseNo: res.after.licenseNo },
          vehicleId: patch.vehicleId,
        },
      });
      return res.after;
    }),
});

// ── vehicle assignments ──────────────────────────────────────────────────────

const assignmentsRouter = router({
  // The signed-in driver's assignment for today (or a given AD date).
  mine: protectedProcedure
    .input(z.object({ dateAd: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const accountId = await q.accountIdFor(ctx.user.id);
      const driver = await resolveDriver(accountId, ctx.user.id);
      if (!driver) return null;
      const dateAd = input?.dateAd ?? kathmanduToday().ad;
      const a = await q.getAssignment(accountId, driver.id, dateAd);
      if (!a) return null;
      // The assignment keeps its own vehicle id even after the truck is retired,
      // so this reads the full list — a driver's own screen must still name the
      // vehicle they were given, retired or not.
      const vehicles = await q.listVehicles(accountId);
      const v = vehicles.find((x) => x.id === a.vehicleId) ?? null;
      return { ...a, vehicleName: v?.name ?? null, vehicleNumber: v?.number ?? null };
    }),

  // Driver self-assigns the vehicle they are driving today.
  setMine: protectedProcedure
    .input(z.object({ vehicleId: z.uuid(), dateAd: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const accountId = await q.accountIdFor(ctx.user.id);
      const driver = await resolveDriver(accountId, ctx.user.id);
      if (!driver) throw new TRPCError({ code: "FORBIDDEN", message: "No driver profile linked to this login." });
      // A retired vehicle is not selectable, even by a client holding a stale list.
      const vehicles = await q.listActiveVehicles(accountId);
      if (!vehicles.some((v) => v.id === input.vehicleId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Pick a vehicle that is still in service.",
        });
      }
      const today = kathmanduToday();
      const dateAd = input.dateAd ?? today.ad;
      const dateBs = dateAd === today.ad ? today.bsIso : q.bsIso(q.adIsoToBs(dateAd));
      return q.upsertAssignment({
        ownerId: accountId,
        driverId: driver.id,
        vehicleId: input.vehicleId,
        dateAd,
        dateBs,
      });
    }),

  forDate: protectedProcedure
    .input(z.object({ dateAd: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const accountId = await q.accountIdFor(ctx.user.id);
      return q.listAssignmentsForDate(accountId, input?.dateAd ?? kathmanduToday().ad);
    }),

  recent: protectedProcedure.query(async ({ ctx }) =>
    q.listRecentAssignments(await q.accountIdFor(ctx.user.id)),
  ),
});

// ── equipment / stock ────────────────────────────────────────────────────────

const equipmentRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => q.listEquipment(await q.accountIdFor(ctx.user.id))),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        code: z.string().optional(),
        unit: z.string().optional(),
        totalQty: z.number().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      return q.createEquipment({ ownerId: accountId, ...input });
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().min(1).optional(),
        code: z.string().optional(),
        unit: z.string().optional(),
        totalQty: z.number().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const { id, ...patch } = input;
      const row = await q.updateEquipment(accountId, id, patch);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Equipment not found." });
      return row;
    }),

  movements: protectedProcedure
    .input(z.object({ equipmentId: z.uuid().optional() }).optional())
    .query(async ({ ctx, input }) =>
      q.listStockMovements(await q.accountIdFor(ctx.user.id), input?.equipmentId),
    ),

  /**
   * The per-item movement report behind the Stock report's clickable Closing
   * Stock. Owner only, at BOTH layers: this procedure rejects a driver with a
   * 403, and the page itself is behind the owner route guard — so a driver can
   * neither see the link nor call the query directly.
   *
   * The full history is returned (it is one item, so bounded) and the date
   * range is applied on the client by the shared `buildMovementReport`, which
   * means changing the range is instant and the opening balance stays correct.
   */
  movementReport: protectedProcedure
    .input(z.object({ equipmentId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const report = await q.stockMovementReport(accountId, input.equipmentId);
      if (!report) throw new TRPCError({ code: "NOT_FOUND", message: "Equipment not found." });
      return report;
    }),
});

// ── orders ───────────────────────────────────────────────────────────────────

const ordersRouter = router({
  list: protectedProcedure
    .input(z.object({ status: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const accountId = await q.accountIdFor(ctx.user.id);
      const profile = await q.getProfile(ctx.user.id);
      const driver = profile?.role === "driver" ? await resolveDriver(accountId, ctx.user.id) : null;
      return q.listOrders(accountId, { driverId: driver?.id ?? null, status: input?.status });
    }),

  get: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const accountId = await q.accountIdFor(ctx.user.id);
    const detail = await q.getOrder(accountId, input.id);
    if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
    const profile = await q.getProfile(ctx.user.id);
    // Amount due is ONLY ever visible in the Owner app.
    if (profile?.role !== "owner" && detail.invoice) {
      return { ...detail, invoice: { ...detail.invoice, subtotal: 0, total: 0, amountDue: 0, hidden: true } };
    }
    return detail;
  }),

  create: protectedProcedure
    .input(
      z.object({
        customerId: z.uuid().optional(),
        newCustomer: z
          .object({ name: z.string().min(1), phone: z.string().optional(), address: z.string().optional() })
          .optional(),
        items: z.array(orderItemSchema).min(1),
        notes: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const accountId = await q.accountIdFor(ctx.user.id);
      const profile = await q.getProfile(ctx.user.id);
      const driver = profile?.role === "driver" ? await resolveDriver(accountId, ctx.user.id) : null;

      let customerId = input.customerId ?? null;
      if (!customerId) {
        if (!input.newCustomer) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a customer or add a new one." });
        }
        const c = await q.createCustomer({ ownerId: accountId, ...input.newCustomer });
        customerId = c.id;
      }

      // Attach the driver's vehicle for today, when they have one.
      let vehicleId: string | null = null;
      if (driver) {
        const a = await q.getAssignment(accountId, driver.id, kathmanduToday().ad);
        vehicleId = a?.vehicleId ?? null;
      }

      return q.createOrder({
        ownerId: accountId,
        customerId,
        driverId: driver?.id ?? null,
        vehicleId,
        notes: input.notes ?? null,
        items: input.items,
      });
    }),

  approve: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const row = await q.setOrderStatus(accountId, input.id, ["pending_approval"], "approved", {
      approvedAt: new Date(),
    });
    // A replay of an approval/rejection that already happened comes back with
    // `alreadyApplied`; that is success, not a conflict, or the offline outbox
    // would report work as lost when it had in fact landed.
    if (!row) throw new TRPCError({ code: "CONFLICT", message: "Order is not awaiting approval." });
    return row;
  }),

  reject: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const row = await q.setOrderStatus(accountId, input.id, ["pending_approval"], "rejected");
    if (!row) throw new TRPCError({ code: "CONFLICT", message: "Order is not awaiting approval." });
    return row;
  }),

  // ── owner review & edit before approving ──────────────────────────────────
  //
  // The owner corrects ANY part of a pending order — customer, driver, vehicle,
  // order date, notes, and every line (equipment, basis, rate, actual qty,
  // billed qty, units) — and then approves. Editable ONLY while the order is
  // `pending_approval`, which is what keeps the rule "Actual Qty hits stock,
  // Billed Qty hits the invoice" intact: the edited numbers are still the ones
  // that dispatch/return read, and nothing downstream has been computed yet.
  update: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        customerId: z.uuid(),
        driverId: z.uuid().nullish(),
        vehicleId: z.uuid().nullish(),
        notes: z.string().max(2000).nullish(),
        orderDateAd: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date")
          .nullish(),
        items: z.array(orderItemSchema).min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);

      // Reject cross-account references rather than letting the FK accept a row
      // that belongs to a different business.
      const [customers, drivers, vehicles] = await Promise.all([
        listCustomers(accountId),
        q.listActiveDrivers(accountId),
        q.listActiveVehicles(accountId),
      ]);
      if (!customers.some((c) => c.id === input.customerId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a customer from this business." });
      }
      if (input.driverId && !drivers.some((d) => d.id === input.driverId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a driver from this business." });
      }
      if (input.vehicleId && !vehicles.some((v) => v.id === input.vehicleId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a vehicle from this business." });
      }

      const applied = await q.updatePendingOrder(
        accountId,
        input.id,
        {
          customerId: input.customerId,
          driverId: input.driverId ?? null,
          vehicleId: input.vehicleId ?? null,
          notes: input.notes?.trim() ? input.notes.trim() : null,
          orderDateAd: input.orderDateAd ?? null,
        },
        input.items,
      );
      if (!applied) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This order is no longer awaiting approval, so it can no longer be edited.",
        });
      }
      return { ok: true };
    }),

  // Driver locks an approved order for dispatch → On Transit, hidden from others.
  //
  // The lock also snapshots the LOCKER's vehicle onto the order: the trip belongs
  // to whoever takes it for dispatch, so the in-transit and tracking views must
  // show that driver's truck — not the one the order was created with.
  lock: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const accountId = await q.accountIdFor(ctx.user.id);
    const driver = await resolveDriver(accountId, ctx.user.id);
    if (!driver) throw new TRPCError({ code: "FORBIDDEN", message: "Only a driver can lock an order for dispatch." });
    // The vehicle the locker is driving today. Null when they have not picked
    // one — the UI then says so honestly instead of borrowing the creator's.
    const assignment = await q.getAssignment(accountId, driver.id, kathmanduToday().ad);
    const row = await q.lockOrderForDispatch(accountId, input.id, driver.id, assignment?.vehicleId ?? null);
    if (!row) throw new TRPCError({ code: "CONFLICT", message: "Order is not available to dispatch." });
    return row;
  }),

  // Dispatched → auto Sales Invoice + products marked On Rent.
  //
  // Only the driver who LOCKED the order may dispatch it. A driver who merely
  // created it (or any other driver) gets a clear 403; the owner may always
  // dispatch. The guard lives in db.dispatchOrder, enforced in SQL, so a race
  // between two drivers cannot double-dispatch either.
  //
  // Replaying a dispatch that already happened returns `alreadyApplied: true`
  // instead of an error — see the note in db.dispatchOrder. The outbox relies on
  // that to tell "you were too late" apart from "this was never going to work".
  dispatch: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const accountId = await q.accountIdFor(ctx.user.id);
    const me = await resolveDriver(accountId, ctx.user.id);
    const res = await q.dispatchOrder(accountId, input.id, me?.id ?? null, await actorNameFor(ctx.user.id, accountId));
    if (!res.ok) {
      if (res.reason === "not_found") {
        throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
      }
      if (res.reason === "not_locker") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the driver who locked this order for dispatch can dispatch it.",
        });
      }
      throw new TRPCError({ code: "CONFLICT", message: "Order is not On Transit." });
    }
    return res;
  }),

  // Pickup: rented products return to Stock.
  return: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const accountId = await q.accountIdFor(ctx.user.id);
    const me = await resolveDriver(accountId, ctx.user.id);
    const res = await q.returnOrder(accountId, input.id, {
      driverId: me?.id ?? null,
      actorName: await actorNameFor(ctx.user.id, accountId),
    });
    if (!res.ok) {
      throw new TRPCError({
        code: res.reason === "not_found" ? "NOT_FOUND" : "CONFLICT",
        message: res.reason === "not_found" ? "Order not found." : "Order is not On Rent.",
      });
    }
    return res;
  }),

  // ── owner-only undo ────────────────────────────────────────────────────────
  //
  // Both of these reverse a mistake the owner made. They are owner-only at BOTH
  // layers: `requireOwner` here refuses a driver with a 403 even if they call
  // the API directly, and the UI never renders the buttons for a driver.
  //
  // A reason is REQUIRED (min 1 character after trimming) and is stored on the
  // audit entry, so a correction is never anonymous. The before/after state goes
  // into the audit detail, which is what makes the undo reviewable later.

  /** Release a lock for dispatch, so another driver can take the order. */
  undoLock: protectedProcedure
    .input(z.object({ id: z.uuid(), reason: z.string().trim().min(1, "Give a short reason for the undo.") }))
    .mutation(async ({ ctx, input }) => {
      const profile = await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const res = await q.undoLockForDispatch(accountId, input.id);

      if (!res.ok) {
        if (res.reason === "not_found") {
          throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
        }
        if (res.reason === "already_dispatched") {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "This order has already been dispatched, so its lock cannot be undone on its own. Undo the dispatch first.",
          });
        }
        throw new TRPCError({
          code: "CONFLICT",
          message: "This order is not locked for dispatch, so there is no lock to undo.",
        });
      }

      // A replay that found nothing to do writes no second audit entry.
      if (!res.alreadyApplied) {
        await q.writeAuditLog({
          ownerId: accountId,
          actorUserId: ctx.user.id,
          actorName: profile.displayName ?? null,
          actorRole: "owner",
          action: "update",
          entity: "order",
          targetId: input.id,
          targetLabel: `Order · ${res.before.customerName ?? ""}`,
          summary:
            `Undid the lock for dispatch on the order for ${res.before.customerName ?? "a customer"} ` +
            `(was locked by ${res.before.transitedByName ?? "a driver"} on ` +
            `${res.before.transitVehicleName ?? "no vehicle"}). Reason: ${input.reason}`,
          detail: {
            undo: "lock",
            reason: input.reason,
            before: {
              status: res.before.status,
              lockedByDriverId: res.before.lockedByDriverId,
              transitedByName: res.before.transitedByName,
              transitVehicleId: res.before.transitVehicleId,
              transitVehicleName: res.before.transitVehicleName,
            },
            after: { status: res.after.status, lockedByDriverId: null, transitVehicleId: null },
          },
        });
      }

      return { ok: true, alreadyApplied: Boolean(res.alreadyApplied), status: res.after.status };
    }),

  /** Put a returned order back on rent, reversing the restock and the ledger. */
  undoReturn: protectedProcedure
    .input(z.object({ id: z.uuid(), reason: z.string().trim().min(1, "Give a short reason for the undo.") }))
    .mutation(async ({ ctx, input }) => {
      const profile = await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const res = await q.undoReturnFromCustomer(accountId, input.id, input.reason);

      if (!res.ok) {
        if (res.reason === "not_found") {
          throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
        }
        if (res.reason === "nothing_to_reverse") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "There is no recorded return on this order to undo.",
          });
        }
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "This order is not marked returned, so there is no return to undo. It may have been changed since.",
        });
      }

      if (!res.alreadyApplied) {
        await q.writeAuditLog({
          ownerId: accountId,
          actorUserId: ctx.user.id,
          actorName: profile.displayName ?? null,
          actorRole: "owner",
          action: "update",
          entity: "order",
          targetId: input.id,
          targetLabel: `Order · ${res.before.customerName ?? ""}`,
          summary:
            `Undid the return on the order for ${res.before.customerName ?? "a customer"} — the order is ` +
            `back on rent and ${res.reversedMovements} stock movement(s) were reversed. Reason: ${input.reason}`,
          detail: {
            undo: "return",
            reason: input.reason,
            reversedMovements: res.reversedMovements,
            before: { status: res.before.status },
            after: { status: res.after.status },
          },
        });
      }

      return {
        ok: true,
        alreadyApplied: Boolean(res.alreadyApplied),
        status: res.after.status,
        reversedMovements: res.reversedMovements,
      };
    }),
});

// ── invoices (owner only) ────────────────────────────────────────────────────

const invoicesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    await requireOwner(ctx.user.id);
    return q.listInvoices(await q.accountIdFor(ctx.user.id));
  }),

  get: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const all = await q.listInvoices(accountId);
    const inv = all.find((i) => i.id === input.id);
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found." });
    const detail = await q.getOrder(accountId, inv.orderId);
    return { invoice: inv, detail };
  }),
});

// ── rentals (On Rent) ────────────────────────────────────────────────────────

const rentalsRouter = router({
  onRent: protectedProcedure.query(async ({ ctx }) => q.listOnRent(await q.accountIdFor(ctx.user.id))),
});

// ── dashboard ────────────────────────────────────────────────────────────────

const dashboardRouter = router({
  summary: protectedProcedure.query(async ({ ctx }) => {
    const accountId = await q.accountIdFor(ctx.user.id);
    const profile = await q.getProfile(ctx.user.id);
    const summary = await q.dashboardSummary(accountId);
    // Drivers never see money.
    if (profile?.role !== "owner") {
      return {
        ...summary,
        invoices: { count: summary.invoices.count, total: 0, amountDue: 0, hidden: true },
        dues: { total: 0, hidden: true },
      };
    }
    // "Due across all customers" is the same opening + invoices − receipts relation
    // the ledger uses, so the dashboard figure and the ledger always agree.
    const dues = await q.customerDueMap(accountId);
    let total = 0;
    for (const v of dues.values()) total += v;
    return { ...summary, dues: { total: Math.round((total + Number.EPSILON) * 100) / 100, hidden: false } };
  }),
});

// ── users (owner creates driver logins) ──────────────────────────────────────

const usersRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const profiles = await q.listProfiles(accountId);
    const drivers = await q.listDrivers(accountId);
    return profiles.map((p) => ({
      userId: p.userId,
      role: p.role,
      displayName: p.displayName,
      phone: p.phone,
      username: p.username,
      driverId: drivers.find((d) => d.userId === p.userId)?.id ?? null,
    }));
  }),

  // Create a driver login (credentials handed over by the owner). Email is
  // OPTIONAL: a driver may log in with a username or their phone instead.
  createDriver: protectedProcedure
    .input(
      z.object({
        email: z.string().optional(),
        username: z.string().optional(),
        password: z.string().min(8),
        name: z.string().min(1),
        phone: z.string().optional(),
        licenseNo: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);

      const email = input.email?.trim() || null;
      const username = input.username?.trim().toLowerCase() || null;
      const phone = input.phone?.trim() || null;

      if (email && !z.email().safeParse(email).success) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "That email address is not valid." });
      }
      if (username && !/^[a-z0-9._-]{3,32}$/.test(username)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Username must be 3\u201332 characters: letters, numbers, dot, dash or underscore.",
        });
      }
      if (!email && !username && !phone) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Give the driver an email, a username, or a phone number to log in with.",
        });
      }
      if (username && (await q.isUsernameTaken(username))) {
        throw new TRPCError({ code: "CONFLICT", message: "That username is already taken." });
      }

      // The auth layer keys on email, so a driver without one gets a stable
      // internal address derived from their username/phone. It is never shown.
      const loginEmail = email ?? `${username ?? phone}@driver.local`;

      let user;
      try {
        user = await registerLocalUser(loginEmail, input.password, input.name);
      } catch (e) {
        if (e instanceof EmailTakenError) throw new TRPCError({ code: "CONFLICT", message: e.message });
        throw e;
      }
      await q.createDriverProfile({
        userId: user.id,
        ownerId: accountId,
        displayName: input.name,
        phone,
        username,
      });
      const driver = await q.createDriverRow({
        ownerId: accountId,
        name: input.name,
        phone,
        licenseNo: input.licenseNo ?? null,
        userId: user.id,
      });
      return {
        userId: user.id,
        driverId: driver.id,
        email: user.email,
        username,
        loginId: username ?? phone ?? user.email,
      };
    }),
});

// ── files (canonical scaffold shape) ─────────────────────────────────────────

export function sanitizeBasename(name: string): string {
  const last = name.split(/[/\\]/).pop() ?? "";
  const dot = last.lastIndexOf(".");
  const rawStem = dot > 0 ? last.slice(0, dot) : last;
  const rawExt = dot > 0 ? last.slice(dot + 1) : "";
  const stem = rawStem.replace(/[^A-Za-z0-9._-]/g, "").replace(/^\.+/, "") || "upload";
  const ext = rawExt.replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
  return ext ? `${stem}.${ext}` : stem;
}

const filesRouter = router({
  uploadUrl: protectedProcedure
    .input(z.object({ name: z.string().min(1), contentType: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const key = `${crypto.randomUUID()}-${sanitizeBasename(input.name)}`;
      try {
        const { uploadUrl, publicPath } = await storagePutUrl(key, input.contentType, {
          ownerId: ctx.user.id,
        });
        return { key, uploadUrl, publicPath };
      } catch (e) {
        if (e instanceof StorageError && e.code === "failed") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "upload rejected by storage — check contentType is on the platform's whitelist",
          });
        }
        throw e;
      }
    }),

  commit: protectedProcedure
    .input(z.object({ key: z.string().min(1), name: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await storageCommit(input.key, { ownerId: ctx.user.id, name: input.name });
      } catch (e) {
        if (e instanceof StorageError && e.code === "not_found") {
          throw new TRPCError({ code: "NOT_FOUND", message: "upload not found — did the PUT succeed?" });
        }
        if (e instanceof StorageError && e.code === "forbidden") {
          throw new TRPCError({ code: "FORBIDDEN", message: "that key belongs to another user" });
        }
        throw e;
      }
    }),

  list: protectedProcedure.query(({ ctx }) => storageListByOwner(ctx.user.id)),

  remove: protectedProcedure
    .input(z.object({ key: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await storageDeleteOwned(ctx.user.id, input.key);
      } catch (e) {
        if (e instanceof StorageError && e.code === "forbidden") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "malformed key" });
        }
        throw e;
      }
    }),
});

// ── live GPS vehicle tracking ─────────────────────────────────────────────────
//
// A driver's device posts a ping every ~30s while a trip is active; the owner's
// map reads the newest ping per driver for the live marker and the whole series
// for the route taken. Role rules are enforced HERE, not in the UI:
//
//   * `ping` is driver-only, and only while that driver has an active trip.
//   * every owner-facing read is `requireOwner` — a driver can never see another
//     driver's position, the fleet map, or any route history.
//   * `myTrip` is the driver's own view: their active trip and nothing else.

const trackingRouter = router({
  // Driver → server. One location fix.
  ping: protectedProcedure
    .input(
      z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        accuracy: z.number().min(0).nullable().optional(),
        speed: z.number().nullable().optional(),
        heading: z.number().nullable().optional(),
        // The device's own timestamp, so a ping queued offline keeps the time it
        // was actually taken rather than the time it finally uploaded.
        recordedAt: z.string().datetime().nullable().optional(),
        orderId: z.uuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const accountId = await q.accountIdFor(ctx.user.id);
      const profile = await q.getProfile(ctx.user.id);
      if (profile?.role !== "driver") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only a driver's device sends location updates." });
      }
      const driver = await resolveDriver(accountId, ctx.user.id);
      if (!driver) {
        throw new TRPCError({ code: "FORBIDDEN", message: "No driver record is linked to this login." });
      }

      // Only track while the driver is actually on a trip. This is the guard that
      // stops a stale tab from reporting a position after the trip ended.
      const trip = await q.driverActiveTrip(accountId, driver.id);
      if (!trip) {
        throw new TRPCError({ code: "CONFLICT", message: "No active trip — tracking is stopped." });
      }
      // If the client named an order, it must be the one they are actually on.
      const orderId = input.orderId && input.orderId === trip.orderId ? input.orderId : trip.orderId;

      const row = await q.recordTripLocation({
        ownerId: accountId,
        driverId: driver.id,
        orderId,
        latitude: input.latitude,
        longitude: input.longitude,
        accuracy: input.accuracy ?? null,
        speed: input.speed ?? null,
        heading: input.heading ?? null,
        recordedAt: input.recordedAt ? new Date(input.recordedAt) : null,
      });
      return { ok: true, id: row?.id ?? null, orderId };
    }),

  // Owner → live map: newest ping per driver + the active deliveries.
  live: protectedProcedure.query(async ({ ctx }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const [markers, trips] = await Promise.all([q.latestDriverLocations(accountId), q.activeTrips(accountId)]);
    return { markers, trips, at: new Date().toISOString() };
  }),

  // Owner → the route taken on one order.
  history: protectedProcedure.input(z.object({ orderId: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const detail = await q.getOrder(accountId, input.orderId);
    if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
    const points = await q.tripHistory(accountId, input.orderId);
    return { points, order: detail.order };
  }),

  // Owner → orders that have a recorded route.
  trips: protectedProcedure.query(async ({ ctx }) => {
    await requireOwner(ctx.user.id);
    return q.tripsWithHistory(await q.accountIdFor(ctx.user.id));
  }),

  // Driver → their own active trip (drives the tracking card). Owners get null.
  myTrip: protectedProcedure.query(async ({ ctx }) => {
    const accountId = await q.accountIdFor(ctx.user.id);
    const profile = await q.getProfile(ctx.user.id);
    if (profile?.role !== "driver") return { trip: null, lastPingAt: null };
    const driver = await resolveDriver(accountId, ctx.user.id);
    if (!driver) return { trip: null, lastPingAt: null };
    const trip = await q.driverActiveTrip(accountId, driver.id);
    const lastPingAt = await q.lastPingAt(accountId, driver.id);
    return { trip, lastPingAt };
  }),

  // Owner → set a customer's delivery-site coordinates for the map.
  setCustomerLocation: protectedProcedure
    .input(
      z.object({
        customerId: z.uuid(),
        latitude: z.number().min(-90).max(90).nullable(),
        longitude: z.number().min(-180).max(180).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const row = await q.setCustomerLocation(accountId, input.customerId, input.latitude, input.longitude);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found." });
      return row;
    }),
});

export const appRouter = router({
  auth: authRouter,
  account: accountRouter,
  customers: customersRouter,
  receipts: receiptsRouter,
  vehicles: vehiclesRouter,
  drivers: driversRouter,
  assignments: assignmentsRouter,
  equipment: equipmentRouter,
  orders: ordersRouter,
  invoices: invoicesRouter,
  rentals: rentalsRouter,
  dashboard: dashboardRouter,
  users: usersRouter,
  tracking: trackingRouter,
  files: filesRouter,
  // Owner-only: edit/delete any record + the audit trail behind it.
  admin: adminRouter,
});

export type AppRouter = typeof appRouter;