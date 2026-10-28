import { useLocation, useSearch } from "wouter";
import { useState } from "react";
import { ClipboardList, Plus } from "lucide-react";
import { trpc } from "@/_core/trpc";
import { AppLayout } from "@/components/AppLayout";
import { PageHeader, StatusPill, Table, THead, TBody, TR, TH, TD, Spinner, EmptyState, Select } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { bsDisplay } from "@/lib/format";
import { STATUS_LABELS, type OrderStatus } from "@shared/rental";
import { CloudUpload } from "lucide-react";
import { usePendingActions } from "@/lib/offline/runtime";
import { useAccount } from "@/lib/useAccount";
import { HOT_POLL_MS, pollWhileOnline } from "@/lib/live";
import { DeleteRecordDialog, OwnerRowActions } from "@/components/OwnerRecordActions";
import { UndoDialog } from "@/components/UndoDialog";
import { Undo2 } from "lucide-react";

export default function Orders() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const status = params.get("status") ?? "";
  const utils = trpc.useUtils();
  const { account } = useAccount();
  const isOwner = account?.role === "owner";

  // Polled, so an order another person creates, locks, dispatches or returns
  // shows up here within a few seconds without a reload. The interval stops while
  // the tab is hidden and while the app is offline (see lib/live.ts).
  const orders = trpc.orders.list.useQuery(status ? { status } : {}, {
    refetchInterval: pollWhileOnline(HOT_POLL_MS),
  });

  const [deleteFor, setDeleteFor] = useState<{ id: string; label: string } | null>(null);
  // The row whose undo the owner is confirming. `kind` decides which reversal.
  const [undoFor, setUndoFor] = useState<{
    id: string;
    kind: "lock" | "return";
    label: string;
    lockedBy?: string | null;
    vehicle?: string | null;
  } | null>(null);

  // Undo invalidates the stock report and the movement ledger too: undoing a
  // return changes on-hand quantity, so those screens must not keep the old
  // numbers.
  const undoInvalidate = () => {
    void utils.orders.list.invalidate();
    void utils.orders.get.invalidate();
    void utils.dashboard.summary.invalidate();
    void utils.rentals.onRent.invalidate();
    void utils.equipment.list.invalidate();
    void utils.equipment.movements.invalidate();
    void utils.equipment.movementReport.invalidate();
    void utils.invoices.list.invalidate();
    void utils.admin.auditLog.invalidate();
    void utils.tracking.live.invalidate();
  };
  const undoLock = trpc.orders.undoLock.useMutation({
    onSuccess: () => {
      undoInvalidate();
      setUndoFor(null);
    },
  });
  const undoReturn = trpc.orders.undoReturn.useMutation({
    onSuccess: () => {
      undoInvalidate();
      setUndoFor(null);
    },
  });
  const deletePreview = trpc.admin.orderDeletePreview.useQuery(
    { id: deleteFor?.id ?? "" },
    { enabled: isOwner && !!deleteFor },
  );
  const del = trpc.admin.deleteOrder.useMutation({
    onSuccess: () => {
      void utils.orders.list.invalidate();
      void utils.dashboard.summary.invalidate();
      void utils.equipment.list.invalidate();
      void utils.invoices.list.invalidate();
      void utils.customers.list.invalidate();
      void utils.rentals.onRent.invalidate();
      void utils.admin.auditLog.invalidate();
      setDeleteFor(null);
    },
  });

  // Rows whose changes are still only on this device. An order created offline is
  // keyed by its local id, so both that id and an existing order's id are matched.
  const pending = usePendingActions();
  const pendingOrderIds = new Set(
    pending
      .filter((a) => a.path.startsWith("orders."))
      .map((a) => (a.path === "orders.create" ? a.localId : String((a.input as { id?: string }).id ?? ""))),
  );

  return (
    <AppLayout>
      <PageHeader
        title="Orders"
        subtitle="Every order from creation to return. Locked orders are hidden from other drivers."
        actions={
          <>
            <Select
              className="w-48"
              value={status}
              onChange={(e) => navigate(e.target.value ? `/orders?status=${e.target.value}` : "/orders")}
            >
              <option value="">All statuses</option>
              {(Object.keys(STATUS_LABELS) as OrderStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
            <Button onClick={() => navigate("/orders/new")}>
              <Plus className="h-4 w-4" /> New order
            </Button>
          </>
        }
      />

      {orders.isLoading ? (
        <Spinner />
      ) : (orders.data ?? []).length === 0 ? (
        <EmptyState
          icon={<ClipboardList className="h-5 w-5" />}
          title={status ? "No orders with this status" : "No orders yet"}
          description={
            status
              ? "Try a different status filter, or create a new order."
              : "Create an order for a customer — it goes to the owner for approval, then a driver dispatches it."
          }
          action={<Button onClick={() => navigate("/orders/new")}>Create an order</Button>}
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Customer</TH>
              <TH>Date (BS)</TH>
              <TH>Driver</TH>
              <TH>Vehicle</TH>
              <TH>Status</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {(orders.data ?? []).map((o) => {
              // An order that has been locked belongs to the driver who took it for
              // dispatch — that is who is on the road, so that is whose name and
              // vehicle this row shows. Before a lock, it is the assigned driver's.
              const locked = Boolean(o.lockedByDriverId);
              const rowDriver = locked ? (o.transiterName ?? "—") : (o.driverName ?? "—");
              const rowVehicleName = locked ? o.transitVehicleName : o.vehicleName;
              const rowVehicleNumber = locked ? o.transitVehicleNumber : o.vehicleNumber;
              return (
                <TR key={o.id} className="cursor-pointer" onClick={() => navigate(`/orders/${o.id}`)}>
                  <TD className="font-medium">{o.customerName ?? "—"}</TD>
                  <TD className="text-muted-foreground">{bsDisplay(o.orderDateAd)}</TD>
                  <TD className="text-muted-foreground">{rowDriver}</TD>
                  <TD className="text-muted-foreground">
                    {rowVehicleName ? `${rowVehicleName} (${rowVehicleNumber})` : "—"}
                  </TD>
                  <TD>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={o.status} />
                      {pendingOrderIds.has(o.id) && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                          <CloudUpload className="h-3 w-3" /> Pending sync
                        </span>
                      )}
                    </div>
                  </TD>
                <TD className="text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1">
                    {/* Owner-only undo, offered only where it applies. */}
                    {isOwner && o.status === "on_transit" && o.lockedByDriverId && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Undo the lock for dispatch"
                        aria-label="Undo the lock for dispatch"
                        onClick={() =>
                          setUndoFor({
                            id: o.id,
                            kind: "lock",
                            label: o.customerName ?? "customer",
                            lockedBy: o.transiterName,
                            vehicle: o.transitVehicleName,
                          })
                        }
                      >
                        <Undo2 className="h-4 w-4" />
                      </Button>
                    )}
                    {isOwner && o.status === "returned" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Undo the return"
                        aria-label="Undo the return"
                        onClick={() =>
                          setUndoFor({ id: o.id, kind: "return", label: o.customerName ?? "customer" })
                        }
                      >
                        <Undo2 className="h-4 w-4" />
                      </Button>
                    )}
                    <OwnerRowActions
                      editLabel={`Open ${o.customerName ?? "order"} to edit`}
                      deleteLabel={`Delete order for ${o.customerName ?? "customer"}`}
                      onEdit={() => navigate(`/orders/${o.id}`)}
                      onDelete={() =>
                        setDeleteFor({
                          id: o.id,
                          label: `${o.customerName ?? "customer"} · ${o.orderDateBs ?? ""}`,
                        })
                      }
                    />
                  </div>
                </TD>
              </TR>
              );
            })}
          </TBody>
        </Table>
      )}

      <DeleteRecordDialog
        open={!!deleteFor}
        onClose={() => setDeleteFor(null)}
        title={`Delete order for ${deleteFor?.label ?? ""}?`}
        subtitle="Everything this order created goes with it: its lines, its sales invoice, its route history and its stock movements."
        rows={
          deletePreview.data
            ? [
                { label: "Line items", value: deletePreview.data.lineItems, tone: "danger" as const },
                { label: "Sales invoices", value: deletePreview.data.invoices, tone: "danger" as const },
                { label: "Tracking pings (route history)", value: deletePreview.data.trackingPings, tone: "danger" as const },
                { label: "Stock movements", value: deletePreview.data.stockMovements, tone: "danger" as const },
                { label: "Receipts kept (money received)", value: deletePreview.data.customerReceiptsKept, tone: "muted" as const },
              ]
            : [{ label: "Calculating what will be removed", value: "…" }]
        }
        warning={
          deletePreview.data?.releasesStock?.length
            ? `This order is holding stock. Deleting it returns ${deletePreview.data.releasesStock
                .map((s) => `${s.qty} × ${s.name}`)
                .join(", ")} to available, so nothing stays marked on rent.`
            : null
        }
        busy={del.isPending}
        error={del.error instanceof Error ? del.error.message : null}
        onConfirm={() => deleteFor && del.mutate({ id: deleteFor.id })}
      />

      <UndoDialog
        open={undoFor?.kind === "lock"}
        onClose={() => setUndoFor(null)}
        title={`Undo the lock on ${undoFor?.label ?? "this order"}?`}
        subtitle="The order goes back to Approved and becomes available for any driver to lock again."
        rows={[
          { label: "Locked by", value: undoFor?.lockedBy ?? "a driver" },
          { label: "Vehicle on the trip", value: undoFor?.vehicle ?? "none assigned" },
          { label: "Status", value: "on_transit → approved", tone: "danger" },
        ]}
        warning="Nothing has been dispatched yet, so no invoice or stock movement is affected."
        confirmLabel="Undo lock"
        busy={undoLock.isPending}
        error={undoLock.error instanceof Error ? undoLock.error.message : null}
        onConfirm={(reason) => undoFor && undoLock.mutate({ id: undoFor.id, reason })}
      />

      <UndoDialog
        open={undoFor?.kind === "return"}
        onClose={() => setUndoFor(null)}
        title={`Undo the return on ${undoFor?.label ?? "this order"}?`}
        subtitle="The order goes back to On rent, and the stock that was restocked is taken off the shelf again."
        rows={[
          { label: "Status", value: "returned → on_rent", tone: "danger" },
          { label: "Stock", value: "restocked quantity goes back on rent", tone: "danger" },
          { label: "Movement ledger", value: "a reversing row is added" },
        ]}
        warning="The order becomes returnable again. The original return stays in the ledger, with the reversal recorded beside it."
        confirmLabel="Undo return"
        busy={undoReturn.isPending}
        error={undoReturn.error instanceof Error ? undoReturn.error.message : null}
        onConfirm={(reason) => undoFor && undoReturn.mutate({ id: undoFor.id, reason })}
      />
    </AppLayout>
  );
}
