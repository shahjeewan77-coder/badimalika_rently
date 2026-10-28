import { useLocation } from "wouter";
import { useState } from "react";
import { FileText, Wallet } from "lucide-react";
import { trpc } from "@/_core/trpc";
import { AppLayout } from "@/components/AppLayout";
import { PageHeader, StatCard, Table, THead, TBody, TR, TH, TD, Spinner, EmptyState, StatusPill } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { bsDisplay } from "@/lib/format";
import { formatMoney } from "@shared/rental";
import { DeleteRecordDialog, EditRecordDialog, OwnerRowActions } from "@/components/OwnerRecordActions";
import { LIVE_POLL_MS, pollWhileOnline } from "@/lib/live";

export default function Invoices() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const invoices = trpc.invoices.list.useQuery(undefined, {
    refetchInterval: pollWhileOnline(LIVE_POLL_MS),
  });

  // ── owner: edit / delete any issued invoice ──
  const [editFor, setEditFor] = useState<{ id: string; invoiceNo: string; total: number; amountDue: number } | null>(null);
  const [deleteFor, setDeleteFor] = useState<{ id: string; invoiceNo: string } | null>(null);
  const deletePreview = trpc.admin.invoiceDeletePreview.useQuery(
    { id: deleteFor?.id ?? "" },
    { enabled: !!deleteFor },
  );
  const del = trpc.admin.deleteInvoice.useMutation({
    onSuccess: () => {
      utils.invoices.list.invalidate();
      utils.customers.list.invalidate();
      utils.dashboard.summary.invalidate();
      utils.admin.auditLog.invalidate();
      setDeleteFor(null);
    },
  });
  const edit = trpc.admin.editInvoice.useMutation({
    onSuccess: () => {
      utils.invoices.list.invalidate();
      utils.customers.list.invalidate();
      utils.dashboard.summary.invalidate();
      utils.admin.auditLog.invalidate();
      setEditFor(null);
    },
  });

  const rows = invoices.data ?? [];
  const total = rows.reduce((s, r) => s + Number(r.total), 0);
  const due = rows.reduce((s, r) => s + Number(r.amountDue), 0);

  return (
    <AppLayout>
      <PageHeader title="Sales invoices" subtitle="Issued automatically when a driver marks an order Dispatched. Owner-only." />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatCard label="Invoices" value={rows.length} tone="info" icon={<FileText className="h-5 w-5" />} />
        <StatCard label="Invoiced total" value={formatMoney(total)} tone="default" icon={<FileText className="h-5 w-5" />} />
        <StatCard label="Amount due" value={formatMoney(due)} tone="danger" icon={<Wallet className="h-5 w-5" />} />
      </div>

      {invoices.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-5 w-5" />}
          title="No invoices yet"
          description="A sales invoice is created automatically the moment a driver marks an approved order as Dispatched."
          action={<Button onClick={() => navigate("/orders")}>Go to orders</Button>}
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Invoice</TH>
              <TH>Date (BS)</TH>
              <TH>Customer</TH>
              <TH>Driver</TH>
              <TH>Order</TH>
              <TH className="text-right">Total</TH>
              <TH className="text-right">Amount due</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.id} className="cursor-pointer" onClick={() => navigate(`/orders/${r.orderId}`)}>
                <TD className="font-medium">{r.invoiceNo}</TD>
                <TD className="text-muted-foreground">{bsDisplay(r.invoiceDateAd)}</TD>
                <TD>{r.customerName ?? "—"}</TD>
                <TD className="text-muted-foreground">{r.driverName ?? "—"}</TD>
                <TD>{r.orderStatus ? <StatusPill status={r.orderStatus} /> : "—"}</TD>
                <TD className="text-right tabular-nums">{formatMoney(r.total)}</TD>
                <TD className="text-right font-semibold tabular-nums text-destructive">{formatMoney(r.amountDue)}</TD>
                <TD className="text-right" onClick={(e) => e.stopPropagation()}>
                  <OwnerRowActions
                    editLabel={`Edit ${r.invoiceNo}`}
                    deleteLabel={`Delete ${r.invoiceNo}`}
                    onEdit={() =>
                      setEditFor({ id: r.id, invoiceNo: r.invoiceNo, total: Number(r.total), amountDue: Number(r.amountDue) })
                    }
                    onDelete={() => setDeleteFor({ id: r.id, invoiceNo: r.invoiceNo })}
                  />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <DeleteRecordDialog
        open={!!deleteFor}
        onClose={() => setDeleteFor(null)}
        title={`Delete invoice ${deleteFor?.invoiceNo ?? ""}?`}
        subtitle="The bill is removed from the ledger, so this customer's due drops by its amount."
        rows={
          deletePreview.data
            ? [
                { label: "Invoice total removed", value: formatMoney(deletePreview.data.total), tone: "danger" as const },
                { label: "Receipts kept (money received)", value: deletePreview.data.linkedReceipts, tone: "muted" as const },
              ]
            : [{ label: "Calculating what will be removed", value: "…" }]
        }
        warning="Payments already received are NOT deleted — only the bill itself. Delete the order instead if you want the whole transaction gone."
        busy={del.isPending}
        error={del.error instanceof Error ? del.error.message : null}
        onConfirm={() => deleteFor && del.mutate({ id: deleteFor.id })}
      />

      <EditRecordDialog
        open={!!editFor}
        onClose={() => setEditFor(null)}
        title={`Edit invoice ${editFor?.invoiceNo ?? ""}`}
        fields={[
          { key: "total", label: "Total", type: "number", step: "0.01" },
          { key: "amountDue", label: "Amount due", type: "number", step: "0.01", help: "The customer's due balance is derived from this, so it moves with it." },
        ]}
        initial={editFor ? { total: String(editFor.total), amountDue: String(editFor.amountDue) } : {}}
        busy={edit.isPending}
        error={edit.error instanceof Error ? edit.error.message : null}
        onSave={(v) =>
          editFor &&
          edit.mutate({
            id: editFor.id,
            total: v.total === "" ? undefined : Number(v.total),
            amountDue: v.amountDue === "" ? undefined : Number(v.amountDue),
          })
        }
      />
    </AppLayout>
  );
}
