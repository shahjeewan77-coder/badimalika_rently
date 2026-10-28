import { useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Lock,
  Truck,
  Undo2,
  FileText,
  Wallet,
  Pencil,
  Plus,
  Trash2,
  Save,
  X,
  ClipboardCheck,
} from "lucide-react";
import { trpc } from "@/_core/trpc";
import { AppLayout } from "@/components/AppLayout";
import { PageHeader, StatusPill, Table, THead, TBody, TR, TH, TD, Spinner, ErrorNote, Badge, EmptyState, Select, Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { ActionButton, ActionFeedback } from "@/components/ui/action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAccount } from "@/lib/useAccount";
import { HOT_POLL_MS, pollWhileOnline } from "@/lib/live";
import { patchOrderStatus, restoreSnapshot, snapshotPaths } from "@/lib/optimistic";
import { bsDisplay, relativeTime, todayBs } from "@/lib/format";
import { BASIS_LABELS, BASIS_UNIT_LABELS, RENTAL_BASES, formatMoney, formatQty, type RentalBasis } from "@shared/rental";
import { DeleteRecordDialog } from "@/components/OwnerRecordActions";
import { UndoDialog } from "@/components/UndoDialog";

export default function OrderDetail() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { account } = useAccount();
  const utils = trpc.useUtils();
  // The raw client, for the optimistic patches: `utils` can only invalidate, but a
  // patch has to write the new value in before the request returns.
  const qc = useQueryClient();
  const isOwner = account?.role === "owner";

  const order = trpc.orders.get.useQuery(
    { id: params.id ?? "" },
    // Polled: an order's status changes underneath whoever is looking at it —
    // the owner watches a driver lock and dispatch it, a driver watches the
    // owner approve it. Without this the page keeps reporting the old status
    // until it is reloaded, which is the whole complaint this fixes.
    { enabled: !!params.id, refetchInterval: pollWhileOnline(HOT_POLL_MS) },
  );
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Which undo the owner is confirming, if any. One dialog serves both.
  const [undoKind, setUndoKind] = useState<"lock" | "return" | null>(null);

  // Owner-only: what a delete of THIS order would take with it, so the
  // confirmation can state it exactly. Only fetched when the owner asks.
  const deletePreview = trpc.admin.orderDeletePreview.useQuery(
    { id: params.id ?? "" },
    { enabled: isOwner && confirmDelete && !!params.id },
  );

  const invalidate = () => {
    void utils.orders.get.invalidate();
    void utils.orders.list.invalidate();
    void utils.dashboard.summary.invalidate();
    void utils.rentals.onRent.invalidate();
    void utils.equipment.list.invalidate();
    void utils.invoices.list.invalidate();
    void utils.admin.auditLog.invalidate();
  };

  // ── every transition: optimistic, then confirmed ─────────────────────────────
  //
  // `onMutate` writes the new status into the cache before the request leaves, so
  // the status pill moves on the click rather than a second later. `onError` puts
  // the snapshot back, so a refusal ("only the driver who locked it may dispatch")
  // never leaves the screen claiming a change that did not happen. `onSettled`
  // refetches, so the server's version — including the invoice a dispatch mints —
  // replaces the optimistic guess.
  const transition = (status: string) => ({
    onMutate: async (vars: { id: string }) => {
      const snaps = snapshotPaths(qc, ["orders.get", "orders.list", "rentals.onRent"]);
      patchOrderStatus(qc, vars.id, status);
      return { snaps };
    },
    onError: (_e: unknown, _v: unknown, ctx: { snaps?: ReturnType<typeof snapshotPaths> } | undefined) =>
      restoreSnapshot(qc, ctx?.snaps),
    onSettled: invalidate,
  });

  const approve = trpc.orders.approve.useMutation(transition("approved"));
  const reject = trpc.orders.reject.useMutation(transition("rejected"));
  const lock = trpc.orders.lock.useMutation(transition("on_transit"));
  const dispatch = trpc.orders.dispatch.useMutation(transition("on_rent"));
  const ret = trpc.orders.return.useMutation(transition("returned"));

  // ── owner undo ──
  //
  // Both undos invalidate the same set as a transition, PLUS the stock report and
  // the movement ledger: undoing a return puts quantity back on rent, so the
  // closing figure and the ledger both change. Without that the owner would undo
  // a return and still see the old stock numbers until a reload.
  const undoInvalidate = () => {
    invalidate();
    void utils.equipment.list.invalidate();
    void utils.equipment.movements.invalidate();
    void utils.equipment.movementReport.invalidate();
    void utils.tracking.live.invalidate();
  };

  const undoLock = trpc.orders.undoLock.useMutation({
    onSuccess: () => {
      undoInvalidate();
      setUndoKind(null);
    },
  });
  const undoReturn = trpc.orders.undoReturn.useMutation({
    onSuccess: () => {
      undoInvalidate();
      setUndoKind(null);
    },
  });
  const del = trpc.admin.deleteOrder.useMutation({
    onSuccess: () => {
      invalidate();
      void utils.customers.list.invalidate();
      void utils.tracking.live.invalidate();
      navigate("/orders");
    },
  });

  if (order.isLoading) {
    return (
      <AppLayout>
        <Spinner />
      </AppLayout>
    );
  }
  if (order.isError || !order.data) {
    return (
      <AppLayout>
        <EmptyState title="Order not found" description="It may have been removed, or it is locked by another driver." action={<Button onClick={() => navigate("/orders")}>Back to orders</Button>} />
      </AppLayout>
    );
  }

  const { order: o, items, invoice } = order.data;
  const amount = items.reduce((s, it) => s + it.lineAmount, 0);
  const busy = approve.isPending || reject.isPending || lock.isPending || dispatch.isPending || ret.isPending || del.isPending || undoLock.isPending || undoReturn.isPending;
  const canReview = isOwner && o.status === "pending_approval";
  // Only the driver who locked the order may dispatch it. Showing the button to
  // anyone else would just produce a 403, so it is hidden — the server refuses
  // it regardless, which is what actually enforces the rule.
  const isLocker = Boolean(o.lockedByDriverId) && Boolean(account?.driverId) && o.lockedByDriverId === account?.driverId;

  // One place describing what just happened, in the server's own words when it
  // refused. Nothing here can be silent.

  return (
    <AppLayout>
      <PageHeader
        title={`Order — ${o.customerName ?? "Customer"}`}
        subtitle={
          <>
            {bsDisplay(o.orderDateAd)} · created {relativeTime(o.createdAt)}
          </>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => navigate("/orders")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            {canReview && !editing && (
              <>
                <Button variant="outline" onClick={() => setEditing(true)}>
                  <Pencil className="h-4 w-4" /> Review &amp; Edit
                </Button>
                <ActionButton
                  mutation={reject}
                  variant="outline"
                  idle="Reject"
                  busy="Rejecting…"
                  icon={<XCircle className="h-4 w-4" />}
                  onClick={() => reject.mutate({ id: o.id })}
                />
                <ActionButton
                  mutation={approve}
                  idle="Approve"
                  busy="Approving…"
                  icon={<CheckCircle2 className="h-4 w-4" />}
                  onClick={() => approve.mutate({ id: o.id })}
                />
              </>
            )}
            {!isOwner && o.status === "approved" && (
              <ActionButton
                mutation={lock}
                idle="Lock for dispatch"
                busy="Locking…"
                icon={<Lock className="h-4 w-4" />}
                onClick={() => lock.mutate({ id: o.id })}
              />
            )}
            {!isOwner && o.status === "on_transit" && isLocker && (
              <ActionButton
                mutation={dispatch}
                idle="Dispatched"
                busy="Dispatching…"
                icon={<Truck className="h-4 w-4" />}
                onClick={() => dispatch.mutate({ id: o.id })}
              />
            )}
            {!isOwner && o.status === "on_transit" && !isLocker && (
              <span className="self-center text-xs text-muted-foreground">
                Locked by {o.transitedByName ?? "another driver"} — only they can dispatch it.
              </span>
            )}
            {o.status === "on_rent" && (
              <ActionButton
                mutation={ret}
                idle="Mark returned"
                busy="Returning…"
                icon={<Undo2 className="h-4 w-4" />}
                onClick={() => ret.mutate({ id: o.id })}
              />
            )}
            {/* Owner-only undo. Hidden entirely for a driver — and the server
                refuses both procedures with a 403 regardless. */}
            {isOwner && o.status === "on_transit" && o.lockedByDriverId && (
              <Button
                variant="outline"
                onClick={() => setUndoKind("lock")}
                disabled={busy}
                title="Release this lock so another driver can take the order"
              >
                <Undo2 className="h-4 w-4" /> Undo lock
              </Button>
            )}
            {isOwner && o.status === "returned" && (
              <Button
                variant="outline"
                onClick={() => setUndoKind("return")}
                disabled={busy}
                title="Put this order back on rent and reverse the restock"
              >
                <Undo2 className="h-4 w-4" /> Undo return
              </Button>
            )}
            {isOwner && (
              <Button variant="outline" onClick={() => setEditing(true)} disabled={busy}>
                <Pencil className="h-4 w-4" /> Edit order
              </Button>
            )}
            {isOwner && (
              <Button variant="outline" className="text-destructive hover:bg-destructive/10" onClick={() => setConfirmDelete(true)} disabled={busy}>
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            )}
          </>
        }
      />

      <ActionFeedback
        items={[
          { mutation: approve, done: "Order approved." },
          { mutation: reject, done: "Order rejected." },
          { mutation: lock, done: "Order locked — it is on transit and tracking has started." },
          { mutation: dispatch, done: "Dispatched — the sales invoice is raised and the products are on rent." },
          { mutation: ret, done: "Marked returned — the equipment is back in stock." },
        ]}
      />

      {/* Owner undo confirmations. Each states exactly what is reversed, and
          requires a reason that lands on the audit trail. */}
      <UndoDialog
        open={undoKind === "lock"}
        onClose={() => setUndoKind(null)}
        title="Undo the lock for dispatch?"
        subtitle="The order goes back to Approved and becomes available for any driver to lock again."
        rows={[
          { label: "Locked by", value: o.transitedByName ?? "a driver" },
          { label: "Vehicle on the trip", value: o.transitVehicleName ?? "none assigned" },
          { label: "Status", value: `${o.status} → approved`, tone: "danger" },
          { label: "Created by (kept)", value: o.createdByName ?? "the owner" },
        ]}
        warning="The lock is released, so another driver can take this order. Nothing has been dispatched yet, so no invoice or stock movement is affected."
        confirmLabel="Undo lock"
        busy={undoLock.isPending}
        error={undoLock.error instanceof Error ? undoLock.error.message : null}
        onConfirm={(reason) => undoLock.mutate({ id: o.id, reason })}
      />

      <UndoDialog
        open={undoKind === "return"}
        onClose={() => setUndoKind(null)}
        title="Undo the return?"
        subtitle="The order goes back to On rent, and the stock that was restocked is taken off the shelf again."
        rows={[
          { label: "Status", value: `${o.status} → on_rent`, tone: "danger" },
          { label: "Stock", value: "restocked quantity goes back on rent", tone: "danger" },
          { label: "Movement ledger", value: "a reversing row is added" },
          { label: "Invoice", value: invoice?.invoiceNo ?? "none — unchanged" },
        ]}
        warning="The order becomes returnable again. The original return stays in the ledger, with the reversal recorded beside it, so the history is complete."
        confirmLabel="Undo return"
        busy={undoReturn.isPending}
        error={undoReturn.error instanceof Error ? undoReturn.error.message : null}
        onConfirm={(reason) => undoReturn.mutate({ id: o.id, reason })}
      />

      {/* Owner review step: correct anything the driver entered, then approve. */}
      {canReview && editing && (
        <OrderEditor
          orderId={o.id}
          initial={{
            customerId: o.customerId,
            driverId: o.driverId,
            vehicleId: o.vehicleId,
            orderDateAd: o.orderDateAd,
            notes: o.notes ?? "",
          }}
          initialItems={items.map((it) => ({
            key: it.id,
            equipmentId: it.equipmentId,
            basis: it.basis as RentalBasis,
            rate: String(it.rate),
            units: String(it.units),
            actualQty: String(it.actualQty),
            billedQty: String(it.billedQty),
          }))}
          onClose={() => setEditing(false)}
          onApproved={() => {
            invalidate();
            setEditing(false);
          }}
        />
      )}

      {/*
        Owner full-edit mode: the same editor, but driven by `admin.editOrder` so
        it works after approval, dispatch and while on rent — and recomputes stock
        and the invoice server-side rather than only rewriting the lines.
      */}
      {isOwner && !canReview && editing && (
        <OrderEditor
          anyStage
          orderId={o.id}
          initial={{
            customerId: o.customerId,
            driverId: o.driverId,
            vehicleId: o.vehicleId,
            orderDateAd: o.orderDateAd,
            notes: o.notes ?? "",
          }}
          initialItems={items.map((it) => ({
            key: it.id,
            equipmentId: it.equipmentId,
            basis: it.basis as RentalBasis,
            rate: String(it.rate),
            units: String(it.units),
            actualQty: String(it.actualQty),
            billedQty: String(it.billedQty),
          }))}
          onClose={() => setEditing(false)}
          onApproved={() => {
            invalidate();
            setEditing(false);
          }}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Items</CardTitle>
              <StatusPill status={o.status} />
            </CardHeader>
            <CardContent>
              <Table>
                <THead>
                  <TR>
                    <TH>Equipment</TH>
                    <TH>Basis</TH>
                    <TH className="text-right">Rate</TH>
                    <TH className="text-right">Units</TH>
                    <TH className="text-right">Actual Qty</TH>
                    <TH className="text-right">Billed Qty</TH>
                    <TH className="text-right">Amount</TH>
                  </TR>
                </THead>
                <TBody>
                  {items.map((it) => (
                    <TR key={it.id}>
                      <TD className="font-medium">
                        {it.equipmentName}
                        {it.equipmentCode ? <span className="ml-1 text-xs text-muted-foreground">({it.equipmentCode})</span> : null}
                      </TD>
                      <TD>
                        <Badge tone="muted">{BASIS_LABELS[it.basis as keyof typeof BASIS_LABELS] ?? it.basis}</Badge>
                      </TD>
                      <TD className="text-right tabular-nums">{formatMoney(it.rate)}</TD>
                      <TD className="text-right tabular-nums">{formatQty(it.units)}</TD>
                      <TD className="text-right tabular-nums">{formatQty(it.actualQty)}</TD>
                      <TD className="text-right tabular-nums">{formatQty(it.billedQty)}</TD>
                      <TD className="text-right font-semibold tabular-nums">{formatMoney(it.lineAmount)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <div className="mt-4 flex justify-end">
                <div className="w-full max-w-xs space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Order amount</span>
                    <span className="font-bold tabular-nums">{formatMoney(amount)}</span>
                  </div>
                  {isOwner && invoice && (
                    <div className="flex justify-between border-t pt-2">
                      <span className="text-muted-foreground">Amount due</span>
                      <span className="font-bold tabular-nums text-destructive">{formatMoney(invoice.amountDue)}</span>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {o.notes && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Notes</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">{o.notes}</CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Customer" value={o.customerName ?? "—"} />
              {o.customerPhone && <Row label="Phone" value={o.customerPhone} />}
              {o.customerAddress && <Row label="Address" value={o.customerAddress} />}
              {o.approvedAt && <Row label="Approved" value={relativeTime(o.approvedAt)} />}
              {o.dispatchedAt && <Row label="Dispatched" value={relativeTime(o.dispatchedAt)} />}
            </CardContent>
          </Card>

          {/*
            The three actors. An order can be taken by one driver and locked and
            dispatched by another, so each step is recorded and shown separately —
            "the driver" is not a single fact about an order.
          */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Who did what</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Created by" value={o.createdByName ?? (isOwner ? "Owner" : "—")} />
              <Row label="Transited by" value={o.transitedByName ?? "—"} />
              <Row label="Dispatched by" value={o.dispatchedByName ?? "—"} />
              <div className="border-t pt-3">
                {/*
                  The vehicle on the TRIP is the locker's, not the creator's. An order
                  taken by Kabiraj on 2754 and locked for dispatch by Bikash on 2769 is
                  being carried by Bikash in 2769, so that is what this says — and the
                  vehicle it was created with is still shown below so nothing is lost.
                */}
                <Row
                  label={o.lockedByDriverId ? "Vehicle on trip" : "Vehicle"}
                  value={
                    o.lockedByDriverId
                      ? o.transitVehicleName
                        ? `${o.transitVehicleName} (${o.transitVehicleNumber})`
                        : "No vehicle assigned to the transit driver"
                      : o.vehicleName
                        ? `${o.vehicleName} (${o.vehicleNumber})`
                        : "—"
                  }
                />
                {o.lockedByDriverId && o.vehicleName && o.vehicleId !== o.transitVehicleId && (
                  <div className="mt-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                    Order was created with {o.vehicleName} ({o.vehicleNumber}) — that is kept in the record, but the trip
                    follows {o.transitedByName ?? "the driver who locked it"}.
                  </div>
                )}
                <div className="mt-3">
                  <Row label="Order date (BS)" value={bsDisplay(o.orderDateAd)} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Live tracking follows the driver who locked the order for dispatch — the one actually out on the trip.
              </p>
            </CardContent>
          </Card>

          {invoice && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileText className="h-4 w-4 text-primary" /> Sales invoice
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <Row label="Invoice no." value={invoice.invoiceNo} />
                <Row label="Date (BS)" value={bsDisplay(invoice.invoiceDateAd)} />
                {isOwner ? (
                  <>
                    <Row label="Total" value={formatMoney(invoice.total)} />
                    <div className="flex items-center justify-between rounded-lg bg-destructive/10 px-3 py-2">
                      <span className="flex items-center gap-1.5 font-medium text-destructive">
                        <Wallet className="h-4 w-4" /> Amount due
                      </span>
                      <span className="font-bold tabular-nums text-destructive">{formatMoney(invoice.amountDue)}</span>
                    </div>
                  </>
                ) : (
                  <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                    Invoice totals are visible in the owner app only.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Flow</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>1. Driver submits → Pending approval</p>
              <p>2. Owner reviews &amp; edits, then approves → Approved</p>
              <p>3. Driver locks → On transit (hidden from other drivers)</p>
              <p>4. Driver marks Dispatched → Sales invoice + On rent</p>
              <p>5. Any driver picks up → Returned, back in stock</p>
            </CardContent>
          </Card>
        </div>
      </div>

      <DeleteRecordDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this order?"
        subtitle={
          deletePreview.data
            ? `Order ${deletePreview.data.orderNumber} for ${deletePreview.data.customerName} (status: ${deletePreview.data.status}).`
            : undefined
        }
        rows={
          deletePreview.data
            ? [
                { label: "Line items", value: deletePreview.data.lineItems, tone: "danger" as const },
                { label: "Sales invoices", value: deletePreview.data.invoices, tone: "danger" as const },
                { label: "Tracking pings (route history)", value: deletePreview.data.trackingPings, tone: "danger" as const },
                { label: "Stock movements", value: deletePreview.data.stockMovements, tone: "danger" as const },
                {
                  label: "Receipts kept (money received)",
                  value: deletePreview.data.customerReceiptsKept,
                  tone: "muted" as const,
                },
              ]
            : [{ label: "Calculating what will be removed", value: "…" }]
        }
        warning={
          deletePreview.data?.releasesStock?.length
            ? `This order is holding stock. Deleting it returns ${deletePreview.data.releasesStock
                .map((s) => `${s.qty} × ${s.name}`)
                .join(", ")} to available — otherwise the equipment would stay marked on rent with no order behind it.`
            : null
        }
        busy={del.isPending}
        error={del.error instanceof Error ? del.error.message : null}
        onConfirm={() => del.mutate({ id: o.id })}
      />
    </AppLayout>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

// ── Owner review & edit panel ─────────────────────────────────────────────────
// Every field the driver entered is editable until the owner approves: customer,
// driver, vehicle, order date, notes, and each line (equipment, basis, rate,
// units, Actual Qty, Billed Qty). Saving recomputes each line amount from
// `rate × units × billed qty`, so the corrected numbers are exactly what the
// invoice will use, while Actual Qty remains the figure that moves stock.
interface EditLine {
  key: string;
  equipmentId: string;
  basis: RentalBasis;
  rate: string;
  units: string;
  actualQty: string;
  billedQty: string;
}

function OrderEditor({
  orderId,
  initial,
  initialItems,
  onClose,
  onApproved,
  anyStage = false,
}: {
  orderId: string;
  initial: {
    customerId: string;
    driverId: string | null;
    vehicleId: string | null;
    orderDateAd: string;
    notes: string;
  };
  initialItems: EditLine[];
  onClose: () => void;
  onApproved: () => void;
  /**
   * Owner mode: edit an order at ANY stage, including after dispatch or while on
   * rent. The difference is which mutation is used and that there is no approve
   * step — `admin.editOrder` is owner-only and recomputes stock and the invoice
   * server-side, which `orders.update` deliberately does not allow.
   */
  anyStage?: boolean;
}) {
  const utils = trpc.useUtils();
  const customers = trpc.customers.list.useQuery();
  // Only the roster and the active fleet are selectable — a removed driver or a
  // retired truck must not be assignable to a new order.
  const drivers = trpc.drivers.active.useQuery();
  const vehicles = trpc.vehicles.active.useQuery();
  const equipment = trpc.equipment.list.useQuery();
  const today = todayBs();

  const [form, setForm] = useState(initial);
  const [lines, setLines] = useState<EditLine[]>(initialItems.length ? initialItems : [blankLine()]);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const update = trpc.orders.update.useMutation();
  const approve = trpc.orders.approve.useMutation();
  const adminEdit = trpc.admin.editOrder.useMutation();

  const totals = useMemo(() => {
    let amount = 0;
    let actual = 0;
    let billed = 0;
    for (const l of lines) {
      amount += (Number(l.rate) || 0) * (Number(l.units) || 0) * (Number(l.billedQty) || 0);
      actual += Number(l.actualQty) || 0;
      billed += Number(l.billedQty) || 0;
    }
    return { amount, actual, billed };
  }, [lines]);

  function patchLine(key: string, patch: Partial<EditLine>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function validate(): string | null {
    if (!form.customerId) return "Choose a customer.";
    const usable = lines.filter((l) => l.equipmentId);
    if (usable.length === 0) return "Add at least one line with equipment selected.";
    for (const l of usable) {
      if ((Number(l.rate) || 0) < 0) return "Rates cannot be negative.";
    }
    return null;
  }

  function payload() {
    return {
      id: orderId,
      customerId: form.customerId,
      driverId: form.driverId || null,
      vehicleId: form.vehicleId || null,
      notes: form.notes.trim() ? form.notes : null,
      orderDateAd: form.orderDateAd || null,
      items: lines
        .filter((l) => l.equipmentId)
        .map((l) => ({
          equipmentId: l.equipmentId,
          basis: l.basis,
          rate: Number(l.rate) || 0,
          units: Number(l.units) || 0,
          actualQty: Number(l.actualQty) || 0,
          billedQty: Number(l.billedQty) || 0,
        })),
    };
  }

  async function onSave() {
    setError(null);
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    try {
      if (anyStage) {
        await adminEdit.mutateAsync(payload());
        setSavedAt(new Date().toLocaleTimeString());
        utils.orders.get.invalidate();
        utils.orders.list.invalidate();
        utils.equipment.list.invalidate();
        utils.invoices.list.invalidate();
        utils.dashboard.summary.invalidate();
        utils.admin.auditLog.invalidate();
        return;
      }
      await update.mutateAsync(payload());
      setSavedAt(new Date().toLocaleTimeString());
      utils.orders.get.invalidate();
      utils.orders.list.invalidate();
      utils.dashboard.summary.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the changes.");
    }
  }

  async function onSaveAndApprove() {
    setError(null);
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    try {
      await update.mutateAsync(payload());
      await approve.mutateAsync({ id: orderId });
      onApproved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not approve the order.");
    }
  }

  const busy = update.isPending || approve.isPending || adminEdit.isPending;

  return (
    <Card className="border-primary/40 ring-1 ring-primary/20">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardCheck className="h-4 w-4 text-primary" />
            {anyStage ? "Edit order (owner)" : "Review & edit before approving"}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {anyStage
              ? "Change anything, at any stage. Changing quantities re-aligns stock and the invoice automatically, so the customer's due stays correct."
              : "Correct anything the driver entered, save it, then approve. Editable only while the order is pending approval."}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          <X className="h-4 w-4" /> Close
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Order header fields */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Customer</Label>
            <Select value={form.customerId} onChange={(e) => setForm((f) => ({ ...f, customerId: e.target.value }))}>
              <option value="">Select a customer…</option>
              {(customers.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.phone ? ` — ${c.phone}` : ""}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Order date</Label>
            <Input type="date" value={form.orderDateAd} onChange={(e) => setForm((f) => ({ ...f, orderDateAd: e.target.value }))} />
            <p className="text-xs text-muted-foreground">Bikram Sambat: {bsDisplay(form.orderDateAd)}</p>
          </div>
          <div className="space-y-1.5">
            <Label>Driver</Label>
            <Select value={form.driverId ?? ""} onChange={(e) => setForm((f) => ({ ...f, driverId: e.target.value || null }))}>
              <option value="">Unassigned</option>
              {(drivers.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Vehicle</Label>
            <Select value={form.vehicleId ?? ""} onChange={(e) => setForm((f) => ({ ...f, vehicleId: e.target.value || null }))}>
              <option value="">Unassigned</option>
              {(vehicles.data ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.number})
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Notes</Label>
            <Textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Site details, delivery instructions…" />
          </div>
        </div>

        {/* Editable lines */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">Line items</p>
            <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, blankLine()])} disabled={busy}>
              <Plus className="h-4 w-4" /> Add line
            </Button>
          </div>
          {lines.map((l, idx) => {
            const lineAmount = (Number(l.rate) || 0) * (Number(l.units) || 0) * (Number(l.billedQty) || 0);
            return (
              <div key={l.key} className="space-y-3 rounded-lg border p-3">
                <div className="flex items-center justify-between">
                  <Badge tone="muted">Line {idx + 1}</Badge>
                  {lines.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove line"
                      disabled={busy}
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label>Equipment</Label>
                    <Select value={l.equipmentId} onChange={(e) => patchLine(l.key, { equipmentId: e.target.value })}>
                      <option value="">Select equipment…</option>
                      {(equipment.data ?? []).map((eq) => (
                        <option key={eq.id} value={eq.id}>
                          {eq.name}
                          {eq.code ? ` (${eq.code})` : ""} — {eq.unit}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Rental basis</Label>
                    <Select value={l.basis} onChange={(e) => patchLine(l.key, { basis: e.target.value as RentalBasis })}>
                      {RENTAL_BASES.map((b) => (
                        <option key={b} value={b}>
                          {BASIS_LABELS[b]}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Rate per {l.basis} (Rs)</Label>
                    <Input type="number" min="0" step="0.01" value={l.rate} onChange={(e) => patchLine(l.key, { rate: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{BASIS_UNIT_LABELS[l.basis]} (count)</Label>
                    <Input type="number" min="0" step="0.01" value={l.units} onChange={(e) => patchLine(l.key, { units: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Actual Qty (delivered)</Label>
                    <Input type="number" min="0" step="0.01" value={l.actualQty} onChange={(e) => patchLine(l.key, { actualQty: e.target.value })} />
                    <p className="text-[11px] text-muted-foreground">Hits stock / inventory</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Billed Qty</Label>
                    <Input type="number" min="0" step="0.01" value={l.billedQty} onChange={(e) => patchLine(l.key, { billedQty: e.target.value })} />
                    <p className="text-[11px] text-muted-foreground">Hits the invoice amount</p>
                  </div>
                </div>
                <div className="flex items-center justify-between border-t pt-2 text-sm">
                  <span className="text-muted-foreground">
                    {formatMoney(Number(l.rate) || 0)} × {l.units || 0} {BASIS_UNIT_LABELS[l.basis].toLowerCase()} × {l.billedQty || 0} billed
                  </span>
                  <span className="font-semibold tabular-nums">{formatMoney(lineAmount)}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Totals + actions */}
        <div className="flex flex-col gap-4 border-t pt-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1 text-sm">
            <div className="flex gap-6">
              <span className="text-muted-foreground">Actual qty (stock)</span>
              <span className="font-medium tabular-nums">{formatQty(totals.actual)}</span>
            </div>
            <div className="flex gap-6">
              <span className="text-muted-foreground">Billed qty (invoice)</span>
              <span className="font-medium tabular-nums">{formatQty(totals.billed)}</span>
            </div>
            <div className="flex gap-6 text-base">
              <span className="font-semibold">Order amount</span>
              <span className="font-bold tabular-nums">{formatMoney(totals.amount)}</span>
            </div>
            {savedAt && <p className="text-xs text-emerald-600 dark:text-emerald-400">Saved at {savedAt}.</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="outline" onClick={onSave} disabled={busy}>
              <Save className="h-4 w-4" />
              {anyStage
                ? adminEdit.isPending
                  ? "Saving…"
                  : "Save changes"
                : update.isPending
                  ? "Saving…"
                  : "Save changes"}
            </Button>
            {!anyStage && (
              <Button onClick={onSaveAndApprove} disabled={busy}>
                <CheckCircle2 className="h-4 w-4" /> {approve.isPending ? "Approving…" : "Save & approve"}
              </Button>
            )}
          </div>
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}
        <p className="text-xs text-muted-foreground">
          {anyStage
            ? `Owner edit: works at any stage, including after dispatch. Today is ${today.long} (${today.bsIso} BS).`
            : `Approved orders can no longer be edited here — approve only once every field is correct. Today is ${today.long} (${today.bsIso} BS).`}
        </p>
      </CardContent>
    </Card>
  );
}

function blankLine(): EditLine {
  return {
    key: crypto.randomUUID(),
    equipmentId: "",
    basis: "day",
    rate: "",
    units: "1",
    actualQty: "1",
    billedQty: "1",
  };
}
