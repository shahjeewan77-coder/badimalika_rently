// ── AGENT-OWNED: owner administration — edit / delete anywhere, with audit ─────
//
// The owner can edit and delete EVERY transaction and record, at any stage —
// including an order that is already dispatched, in transit or on rent. That is
// deliberately a wider power than the driver-facing flows, so this module keeps
// it in one place, behind one guard, and writes one audit entry per action.
//
// Rules that hold for every procedure in here:
//   1. `requireOwner` runs FIRST and throws FORBIDDEN, so a driver calling these
//      endpoints directly gets a clean 403 rather than a silently-scoped no-op.
//      The client also never renders the controls for a driver, but the server
//      is what makes that a rule instead of a suggestion.
//   2. Cross-account ids are rejected before any write, so one business can
//      never edit or delete another's rows through a guessed uuid.
//   3. Every `*Preview` query reports exactly what a delete would take with it,
//      which is what lets the UI say "3 order lines, 1 invoice, 12 tracking
//      pings" instead of "are you sure?".
//   4. The audit entry is written AFTER the change succeeds — never before — so
//      the trail cannot claim something happened that did not.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "./_core/trpc";
import * as q from "./db";
import { listCustomers } from "./db";

/** Owner-only guard. Throws FORBIDDEN for a driver, before any work happens. */
async function requireOwner(userId: string) {
  const profile = await q.getProfile(userId);
  if (!profile || profile.role !== "owner") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only the owner can do this." });
  }
  return profile;
}

/** A display name for the audit trail, snapshotted at the time of the action. */
async function actorNameFor(userId: string, fallback?: string | null) {
  try {
    const p = await q.getProfile(userId);
    return p?.displayName ?? fallback ?? "Owner";
  } catch {
    return fallback ?? "Owner";
  }
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

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");

export const adminRouter = router({
  // ── audit trail ───────────────────────────────────────────────────────────

  /** Who changed or deleted what, newest first. */
  auditLog: protectedProcedure
    .input(
      z.object({
        entity: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      return q.listAuditLog(accountId, { entity: input.entity, limit: input.limit });
    }),

  // ── ORDERS ────────────────────────────────────────────────────────────────

  orderDeletePreview: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.orderCascadeSummary(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
    return summary;
  }),

  /**
   * Delete an order and everything that hangs off it: line items, the invoice,
   * receipts against it, every tracking ping, stock movements — and the stock it
   * is still holding is released first, so no equipment is left "on rent" with
   * no order behind it.
   */
  deleteOrder: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.orderCascadeSummary(accountId, input.id);
    const deleted = await q.deleteOrder(accountId, input.id);
    if (!deleted) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
    await q.writeAuditLog({
      ownerId: accountId,
      actorUserId: ctx.user.id,
      actorName: await actorNameFor(ctx.user.id, accountId),
      action: "delete",
      entity: "order",
      targetId: input.id,
      targetLabel: `Order ${summary?.orderNumber ?? ""} · ${summary?.customerName ?? ""}`,
      summary:
        `Deleted order ${summary?.orderNumber ?? ""} for ${summary?.customerName ?? "a customer"} ` +
        `(was ${summary?.status ?? "unknown"}), removing ${summary?.lineItems ?? 0} line item(s), ` +
        `${summary?.invoices ?? 0} invoice(s) and ${summary?.trackingPings ?? 0} tracking ping(s). ` +
        `${summary?.customerReceiptsKept ?? 0} receipt(s) stay, because that money was received.`,
      detail: summary,
    });
    return summary;
  }),

  /**
   * Edit an order at ANY stage — header and line items, whatever the status is.
   * Quantities and rates are re-derived against stock and the issued invoice, so
   * the customer's due balance stays truthful after the edit.
   */
  editOrder: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        customerId: z.uuid().optional(),
        driverId: z.uuid().nullish(),
        vehicleId: z.uuid().nullish(),
        notes: z.string().max(2000).nullish(),
        status: z
          .enum(["pending_approval", "approved", "on_transit", "on_rent", "returned", "rejected"])
          .optional(),
        orderDateAd: dateString.nullish(),
        items: z.array(orderItemSchema).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);

      // Cross-account references are refused before anything is written.
      if (input.customerId) {
        const cs = await listCustomers(accountId);
        if (!cs.some((c) => c.id === input.customerId)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a customer from this business." });
        }
      }
      if (input.driverId) {
        // Active roster only: a driver who has been removed must not be handed a
        // fresh order, even by a client holding a stale list.
        const ds = await q.listActiveDrivers(accountId);
        if (!ds.some((d) => d.id === input.driverId)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Pick a driver who is still on the roster.",
          });
        }
      }
      if (input.vehicleId) {
        const vs = await q.listActiveVehicles(accountId);
        if (!vs.some((v) => v.id === input.vehicleId)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Pick a vehicle that is still in service.",
          });
        }
      }
      if (input.items) {
        const eqs = await q.listEquipment(accountId);
        for (const it of input.items) {
          if (!eqs.some((e) => e.id === it.equipmentId)) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Pick equipment from this business." });
          }
        }
      }

      const res = await q.editOrderAnyStage(
        accountId,
        input.id,
        {
          customerId: input.customerId,
          driverId: input.driverId === undefined ? undefined : input.driverId,
          vehicleId: input.vehicleId === undefined ? undefined : input.vehicleId,
          notes: input.notes === undefined ? undefined : input.notes,
          status: input.status,
          orderDateAd: input.orderDateAd === undefined ? undefined : input.orderDateAd,
        },
        input.items,
      );
      if (!res) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });

      const statusChanged = Boolean(input.status && input.status !== res.before.order.status);
      await q.writeAuditLog({
        ownerId: accountId,
        actorUserId: ctx.user.id,
        actorName: await actorNameFor(ctx.user.id, accountId),
        action: "update",
        entity: "order",
        targetId: input.id,
        targetLabel: `Order · ${res.after.order.customerName ?? ""}`,
        summary:
          `Edited order for ${res.after.order.customerName ?? "a customer"}` +
          (statusChanged ? ` — status ${res.before.order.status} → ${input.status}` : "") +
          (input.items ? `, ${input.items.length} line item(s) rewritten` : "") +
          ".",
        detail: {
          changed: Object.keys(input).filter((k) => k !== "id"),
          before: { status: res.before.order.status, lines: res.before.items.length },
          after: { status: res.after.order.status, lines: res.after.items.length },
        },
      });
      return res.after;
    }),

  // ── CUSTOMERS ─────────────────────────────────────────────────────────────

  customerDeletePreview: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.customerCascadeSummary(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found." });
    return summary;
  }),

  /** Delete a customer, their orders, invoices and receipts, and release any stock they hold. */
  deleteCustomer: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.deleteCustomer(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found." });
    await q.writeAuditLog({
      ownerId: accountId,
      actorUserId: ctx.user.id,
      actorName: await actorNameFor(ctx.user.id, accountId),
      action: "delete",
      entity: "customer",
      targetId: input.id,
      targetLabel: summary.customerName,
      summary:
        `Deleted customer ${summary.customerName}, removing ${summary.orders} order(s), ` +
        `${summary.invoices} invoice(s) and ${summary.receipts} receipt(s).`,
      detail: { ...summary, orderIds: undefined },
    });
    return summary;
  }),

  editCustomer: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().min(1).max(200).optional(),
        phone: z.string().max(50).nullish(),
        address: z.string().max(500).nullish(),
        openingBalance: z.number().optional(),
        latitude: z.number().min(-90).max(90).nullish(),
        longitude: z.number().min(-180).max(180).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const { id, ...patch } = input;
      const row = await q.editCustomer(accountId, id, patch);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found." });
      await q.writeAuditLog({
        ownerId: accountId,
        actorUserId: ctx.user.id,
        actorName: await actorNameFor(ctx.user.id, accountId),
        action: "update",
        entity: "customer",
        targetId: id,
        targetLabel: row.name,
        summary: `Edited customer ${row.name} (${Object.keys(patch).join(", ") || "no fields"}).`,
        detail: patch,
      });
      return row;
    }),

  // ── EQUIPMENT ─────────────────────────────────────────────────────────────

  equipmentDeletePreview: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.equipmentCascadeSummary(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Equipment not found." });
    return summary;
  }),

  /**
   * Delete equipment, its stock ledger, and every order line that used it.
   * Orders left with no lines are removed; the rest have their invoice re-derived
   * so no order is left pointing at equipment that no longer exists.
   */
  deleteEquipment: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.deleteEquipment(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Equipment not found." });
    await q.writeAuditLog({
      ownerId: accountId,
      actorUserId: ctx.user.id,
      actorName: await actorNameFor(ctx.user.id, accountId),
      action: "delete",
      entity: "equipment",
      targetId: input.id,
      targetLabel: summary.equipmentName,
      summary:
        `Deleted equipment ${summary.equipmentName}, removing ${summary.orderLines} order line(s) ` +
        `across ${summary.affectedOrders} order(s) and ${summary.stockMovements} stock movement(s).`,
      detail: summary,
    });
    return summary;
  }),

  editEquipment: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().min(1).max(200).optional(),
        code: z.string().max(50).nullish(),
        unit: z.string().min(1).max(30).optional(),
        totalQty: z.number().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const { id, ...patch } = input;
      const res = await q.editEquipmentAnyStage(accountId, id, patch);
      if (!res) throw new TRPCError({ code: "NOT_FOUND", message: "Equipment not found." });
      if (!res.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Total quantity cannot be less than the ${res.onRentQty} currently on rent.`,
        });
      }
      await q.writeAuditLog({
        ownerId: accountId,
        actorUserId: ctx.user.id,
        actorName: await actorNameFor(ctx.user.id, accountId),
        action: "update",
        entity: "equipment",
        targetId: id,
        targetLabel: res.row.name,
        summary: `Edited equipment ${res.row.name} (${Object.keys(patch).join(", ") || "no fields"}).`,
        detail: patch,
      });
      return res.row;
    }),

  // ── VEHICLES ──────────────────────────────────────────────────────────────

  vehicleDeletePreview: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.vehicleCascadeSummary(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Vehicle not found." });
    return summary;
  }),

  /**
   * Delete a vehicle. Delegates to the one implementation in `db.deleteVehicle`,
   * so the admin page and the fleet page cannot disagree about what a delete
   * means: retire it when history names it, actually remove it when nothing does,
   * and refuse while it is on an active trip.
   */
  deleteVehicle: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
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
          ? `Retired vehicle ${res.summary.vehicleName} (${res.summary.number}) — orders, assignments and ` +
            `audit entries still name it, so the record was kept.`
          : `Deleted vehicle ${res.summary.vehicleName} (${res.summary.number}) — nothing referred to it.`,
      detail: { mode: res.mode, ...res.summary, orderIds: undefined },
    });
    return { ...res.summary, mode: res.mode };
  }),

  // ── RECEIPTS / INVOICES ───────────────────────────────────────────────────

  editReceipt: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        amount: z.number().min(0).optional(),
        mode: z.enum(["cash", "bank", "cheque", "mobile"]).optional(),
        referenceNo: z.string().max(200).nullish(),
        dateAd: dateString.nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const { id, ...patch } = input;
      const row = await q.editReceipt(accountId, id, patch);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Receipt not found or nothing to change." });
      await q.writeAuditLog({
        ownerId: accountId,
        actorUserId: ctx.user.id,
        actorName: await actorNameFor(ctx.user.id, accountId),
        action: "update",
        entity: "receipt",
        targetId: id,
        targetLabel: `Receipt ${Number(row.amount).toFixed(2)}`,
        summary: `Edited receipt of ${Number(row.amount).toFixed(2)} (${row.mode}).`,
        detail: patch,
      });
      return row;
    }),

  invoiceDeletePreview: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.invoiceCascadeSummary(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found." });
    return summary;
  }),

  editInvoice: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        subtotal: z.number().min(0).optional(),
        total: z.number().min(0).optional(),
        amountDue: z.number().min(0).optional(),
        invoiceDateAd: dateString.nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const { id, ...patch } = input;
      const row = await q.editInvoice(accountId, id, patch);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found or nothing to change." });
      await q.writeAuditLog({
        ownerId: accountId,
        actorUserId: ctx.user.id,
        actorName: await actorNameFor(ctx.user.id, accountId),
        action: "update",
        entity: "invoice",
        targetId: id,
        targetLabel: row.invoiceNo,
        summary: `Edited invoice ${row.invoiceNo} — total ${Number(row.total).toFixed(2)}, due ${Number(row.amountDue).toFixed(2)}.`,
        detail: patch,
      });
      return row;
    }),

  /**
   * Delete an invoice. Receipts are money actually received, so they stay — the
   * customer's due simply drops by the bill that is no longer there.
   */
  deleteInvoice: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.deleteInvoice(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found." });
    await q.writeAuditLog({
      ownerId: accountId,
      actorUserId: ctx.user.id,
      actorName: await actorNameFor(ctx.user.id, accountId),
      action: "delete",
      entity: "invoice",
      targetId: input.id,
      targetLabel: summary.invoiceNo,
      summary: `Deleted invoice ${summary.invoiceNo} (total ${summary.total.toFixed(2)}). ${summary.linkedReceipts} receipt(s) were kept.`,
      detail: summary,
    });
    return summary;
  }),

  // ── USERS ─────────────────────────────────────────────────────────────────

  userDeletePreview: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.userCascadeSummary(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
    return { ...summary, isSelf: input.id === accountId };
  }),

  /**
   * Delete a user (and their driver profile). Their ORDERS ARE KEPT — a
   * transaction is a fact about the business, not about whoever was logged in.
   * The actor columns clear, and the audit log still records the name.
   */
  deleteUser: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.userCascadeSummary(accountId, input.id);
    const res = await q.deleteUser(accountId, input.id);
    if (!res.ok) {
      if (res.reason === "is_owner") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot delete your own owner account." });
      }
      throw new TRPCError({ code: "NOT_FOUND", message: "User not found in this business." });
    }
    await q.writeAuditLog({
      ownerId: accountId,
      actorUserId: ctx.user.id,
      actorName: await actorNameFor(ctx.user.id, accountId),
      action: "delete",
      entity: "user",
      targetId: input.id,
      targetLabel: summary?.userName ?? "user",
      summary:
        `Deleted user ${summary?.userName ?? ""}${summary?.isDriver ? " (and their driver profile)" : ""}. ` +
        `Their ${summary?.ordersInvolved ?? 0} order(s) were kept, with the person's name cleared from the actor fields.`,
      detail: summary,
    });
    return res.summary;
  }),

  editUser: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().min(1).max(200).optional(),
        email: z.email().optional(),
        driverName: z.string().min(1).max(200).optional(),
        driverPhone: z.string().max(50).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const { id, ...patch } = input;
      const row = await q.editUser(accountId, id, patch);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "User not found in this business." });
      await q.writeAuditLog({
        ownerId: accountId,
        actorUserId: ctx.user.id,
        actorName: await actorNameFor(ctx.user.id, accountId),
        action: "update",
        entity: "user",
        targetId: id,
        targetLabel: row.name ?? row.email ?? "user",
        summary: `Edited user ${row.name ?? row.email ?? ""} (${Object.keys(patch).join(", ") || "no fields"}).`,
        detail: patch,
      });
      return row;
    }),
});