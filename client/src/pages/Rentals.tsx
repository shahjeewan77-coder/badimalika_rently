import { useLocation } from "wouter";
import { PackageCheck, Undo2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/_core/trpc";
import { AppLayout } from "@/components/AppLayout";
import { PageHeader, Table, THead, TBody, TR, TH, TD, Spinner, EmptyState, Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { ActionButton, ActionFeedback } from "@/components/ui/action";
import { relativeTime } from "@/lib/format";
import { HOT_POLL_MS, pollWhileOnline } from "@/lib/live";
import { patchOrderStatus, restoreSnapshot, snapshotPaths } from "@/lib/optimistic";

export default function Rentals() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const qc = useQueryClient();
  // Polled: a dispatch by a driver puts a new row here within seconds, and a
  // pickup removes one — both used to need a manual reload.
  const onRent = trpc.rentals.onRent.useQuery(undefined, {
    refetchInterval: pollWhileOnline(HOT_POLL_MS),
  });
  const ret = trpc.orders.return.useMutation({
    // The row leaves the list on the click, and comes back only if the server
    // refuses — so "Picked up" responds instantly without ever lying.
    onMutate: async (vars: { id: string }) => {
      const snaps = snapshotPaths(qc, ["rentals.onRent", "orders.list", "orders.get"]);
      patchOrderStatus(qc, vars.id, "returned");
      return { snaps };
    },
    onError: (_e: unknown, _v: unknown, ctx: { snaps?: ReturnType<typeof snapshotPaths> } | undefined) =>
      restoreSnapshot(qc, ctx?.snaps),
    onSuccess: () => {
      void utils.rentals.onRent.invalidate();
      void utils.orders.list.invalidate();
      void utils.orders.get.invalidate();
      void utils.dashboard.summary.invalidate();
      void utils.equipment.list.invalidate();
    },
  });

  const rows = onRent.data ?? [];

  return (
    <AppLayout>
      <PageHeader
        title="On Rent"
        subtitle="Products currently out with customers. When any driver picks one up, mark it returned and it goes back to Stock."
      />

      {onRent.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<PackageCheck className="h-5 w-5" />}
          title="Nothing on rent"
          description="Once a driver marks an order Dispatched, its products appear here until they are picked up."
          action={<Button onClick={() => navigate("/orders")}>Go to orders</Button>}
        />
      ) : (
        <>
          <ActionFeedback items={[{ mutation: ret, done: "Picked up — the equipment is back in stock." }]} />
          <Table>
          <THead>
            <TR>
              <TH>Customer</TH>
              <TH>Invoice</TH>
              <TH>Driver on trip</TH>
              <TH>Vehicle</TH>
              <TH>Dispatched</TH>
              <TH className="text-right">Action</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.id}>
                <TD className="font-medium">{r.customerName ?? "—"}</TD>
                <TD>
                  <Badge tone="muted">{r.invoiceNo ?? "—"}</Badge>
                </TD>
                <TD className="text-muted-foreground">
                  {r.driverName ?? "—"}
                  {r.creatorName && r.creatorName !== r.driverName && (
                    <span className="block text-[11px] text-muted-foreground/70">created by {r.creatorName}</span>
                  )}
                </TD>
                <TD className="text-muted-foreground">
                  {r.vehicleName ? `${r.vehicleName} (${r.vehicleNumber})` : "—"}
                </TD>
                <TD className="text-muted-foreground">{relativeTime(r.dispatchedAt)}</TD>
                <TD className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => navigate(`/orders/${r.id}`)}>
                      View
                    </Button>
                    <ActionButton
                      mutation={ret}
                      size="sm"
                      idle="Picked up"
                      busy="Picking up…"
                      icon={<Undo2 className="h-4 w-4" />}
                      onClick={() => ret.mutate({ id: r.id })}
                    />
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        Tip: the order date in Bikram Sambat is shown on each order's detail page.
      </p>
    </AppLayout>
  );
}
