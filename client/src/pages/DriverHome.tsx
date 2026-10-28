import { useState } from "react";
import { useLocation } from "wouter";
import { Truck, ClipboardList, PackageCheck, Plus, CheckCircle2 } from "lucide-react";
import { trpc } from "@/_core/trpc";
import { AppLayout } from "@/components/AppLayout";
import { PageHeader, StatCard, StatusPill, Table, THead, TBody, TR, TH, TD, Spinner, EmptyState, Select, Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DriverTrackingCard } from "@/components/DriverTrackingCard";
import { bsDisplay, todayBs } from "@/lib/format";
import { HOT_POLL_MS, pollWhileOnline } from "@/lib/live";
import { ActionFeedback } from "@/components/ui/action";

export default function DriverHome() {
  const [, navigate] = useLocation();
  const today = todayBs();
  const utils = trpc.useUtils();

  const mine = trpc.assignments.mine.useQuery({}, { refetchInterval: pollWhileOnline(HOT_POLL_MS) });
  const vehicles = trpc.vehicles.active.useQuery();
  // Polled: the owner approves the driver's order while the driver is looking at
  // this screen, so "Approved" has to appear on its own — not after a reload.
  const orders = trpc.orders.list.useQuery({}, { refetchInterval: pollWhileOnline(HOT_POLL_MS) });
  const setMine = trpc.assignments.setMine.useMutation({
    onSuccess: () => {
      void utils.assignments.mine.invalidate();
      void utils.assignments.forDate.invalidate();
      void utils.dashboard.summary.invalidate();
    },
  });
  const [vehicleId, setVehicleId] = useState("");

  const myOrders = orders.data ?? [];
  const pending = myOrders.filter((o) => o.status === "pending_approval").length;
  const toDispatch = myOrders.filter((o) => o.status === "approved" || o.status === "on_transit").length;
  const onRent = myOrders.filter((o) => o.status === "on_rent").length;

  return (
    <AppLayout>
      <PageHeader
        title="Today"
        subtitle={
          <>
            {today.long} · {today.weekday} — <span className="text-foreground/70">{today.nepali}</span>
          </>
        }
        actions={
          <Button onClick={() => navigate("/orders/new")}>
            <Plus className="h-4 w-4" /> New order
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-1">
          <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Truck className="h-4 w-4 text-primary" /> My vehicle today
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {mine.isLoading ? (
              <Spinner />
            ) : mine.data ? (
              <div className="rounded-lg border bg-muted/40 p-3">
                <p className="font-semibold">{mine.data.vehicleName}</p>
                <p className="text-sm text-muted-foreground">{mine.data.vehicleNumber}</p>
                <Badge tone="success" className="mt-2">
                  <CheckCircle2 className="h-3 w-3" /> Assigned for {bsDisplay(mine.data.dateAd)}
                </Badge>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                You have not picked a vehicle for today yet. Choose the one you are driving.
              </p>
            )}

            <div className="space-y-2">
              <label className="text-sm font-medium">{mine.data ? "Change vehicle" : "Select vehicle"}</label>
              <Select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                <option value="">Choose a vehicle…</option>
                {(vehicles.data ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} — {v.number}
                  </option>
                ))}
              </Select>
              <Button
                className="w-full"
                disabled={!vehicleId || setMine.isPending}
                aria-busy={setMine.isPending}
                onClick={() => setMine.mutate({ vehicleId })}
              >
                {setMine.isPending && (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current/30 border-t-current" />
                )}
                {setMine.isPending ? "Saving…" : "Save assignment"}
              </Button>
              <ActionFeedback items={[{ mutation: setMine, done: "Vehicle saved for today." }]} />
              <p className="text-xs text-muted-foreground">
                You can change this any day — each day keeps its own assignment.
              </p>
            </div>
          </CardContent>
        </Card>

          <DriverTrackingCard />
        </div>

        <div className="space-y-3 lg:col-span-2">
          <div className="grid grid-cols-3 gap-3">
            <StatCard
              label="My pending"
              value={pending}
              tone="warning"
              icon={<ClipboardList className="h-5 w-5" />}
              onClick={() => navigate("/orders?status=pending_approval")}
            />
            <StatCard
              label="To dispatch"
              value={toDispatch}
              tone="info"
              icon={<Truck className="h-5 w-5" />}
              onClick={() => navigate("/orders?status=approved")}
            />
            <StatCard
              label="On rent"
              value={onRent}
              tone="accent"
              icon={<PackageCheck className="h-5 w-5" />}
              onClick={() => navigate("/rentals")}
            />
          </div>

          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">My orders</h2>
            <Button variant="ghost" size="sm" onClick={() => navigate("/orders")}>
              View all
            </Button>
          </div>
          {orders.isLoading ? (
            <Spinner />
          ) : myOrders.length === 0 ? (
            <EmptyState
              icon={<ClipboardList className="h-5 w-5" />}
              title="No orders yet"
              description="Take an order from a customer — it goes to the owner for approval."
              action={<Button onClick={() => navigate("/orders/new")}>Create an order</Button>}
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Customer</TH>
                  <TH>Date (BS)</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {myOrders.slice(0, 8).map((o) => (
                  <TR key={o.id} className="cursor-pointer" onClick={() => navigate(`/orders/${o.id}`)}>
                    <TD className="font-medium">{o.customerName ?? "—"}</TD>
                    <TD className="text-muted-foreground">{bsDisplay(o.orderDateAd)}</TD>
                    <TD>
                      <StatusPill status={o.status} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
