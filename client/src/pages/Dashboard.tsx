import { useLocation } from "wouter";
import {
  ClipboardList,
  CheckCircle2,
  Truck,
  PackageCheck,
  Undo2,
  FileText,
  Wallet,
  Boxes,
  Users,
  Car,
  UserCog,
  ArrowRight,
} from "lucide-react";
import { trpc } from "@/_core/trpc";
import { AppLayout } from "@/components/AppLayout";
import { BsCalendar } from "@/components/BsCalendar";
import { OwnerTrackingMap, MapLegend } from "@/components/OwnerTrackingMap";
import { useAccount } from "@/lib/useAccount";
import { PageHeader, StatCard, StatusPill, Table, THead, TBody, TR, TH, TD, Spinner, EmptyState, Badge } from "@/components/ui/primitives";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { bsDisplay, todayBs } from "@/lib/format";
import { formatMoney } from "@shared/rental";
import { kathmanduToday } from "@shared/bs-calendar";
import { HOT_POLL_MS, pollWhileOnline } from "@/lib/live";

export default function Dashboard() {
  const [, navigate] = useLocation();
  // Both polled: this is the owner's overview, and every number on it changes
  // when a driver locks, dispatches or returns something. A dashboard that is
  // only right after a reload is worse than no dashboard.
  const summary = trpc.dashboard.summary.useQuery(undefined, {
    refetchInterval: pollWhileOnline(HOT_POLL_MS),
  });
  const recent = trpc.orders.list.useQuery({}, { refetchInterval: pollWhileOnline(HOT_POLL_MS) });
  const { account } = useAccount();
  const isOwner = account?.role === "owner";
  // The live fleet map is owner-only; the server refuses it for a driver, so it
  // is only fetched when the signed-in user is the owner.
  const live = trpc.tracking.live.useQuery(undefined, { refetchInterval: pollWhileOnline(HOT_POLL_MS), enabled: isOwner });
  const today = todayBs();
  const bs = kathmanduToday().bs;

  if (summary.isLoading) {
    return (
      <AppLayout>
        <Spinner />
      </AppLayout>
    );
  }

  const s = summary.data;
  const recentOrders = (recent.data ?? []).slice(0, 6);

  return (
    <AppLayout>
      <PageHeader
        title="Dashboard"
        subtitle={
          <>
            {today.long} · {today.weekday} — <span className="text-foreground/70">{today.nepali}</span>
          </>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => navigate("/orders/new")}>
              New order
            </Button>
            <Button onClick={() => navigate("/orders")}>
              All orders <ArrowRight className="h-4 w-4" />
            </Button>
          </>
        }
      />

      {/* Order pipeline — every card opens its detailed view */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Order pipeline</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <StatCard
            label="Pending approval"
            value={s?.orders.pending ?? 0}
            hint="Awaiting owner review"
            tone="warning"
            icon={<ClipboardList className="h-5 w-5" />}
            onClick={() => navigate("/orders?status=pending_approval")}
          />
          <StatCard
            label="Approved"
            value={s?.orders.approved ?? 0}
            hint="Ready to dispatch"
            tone="info"
            icon={<CheckCircle2 className="h-5 w-5" />}
            onClick={() => navigate("/orders?status=approved")}
          />
          <StatCard
            label="On transit"
            value={s?.orders.onTransit ?? 0}
            hint="Locked by a driver"
            tone="default"
            icon={<Truck className="h-5 w-5" />}
            onClick={() => navigate("/orders?status=on_transit")}
          />
          <StatCard
            label="On rent"
            value={s?.orders.onRent ?? 0}
            hint="Out with customers"
            tone="accent"
            icon={<PackageCheck className="h-5 w-5" />}
            onClick={() => navigate("/rentals")}
          />
          <StatCard
            label="Returned"
            value={s?.orders.returned ?? 0}
            hint="Back in stock"
            tone="success"
            icon={<Undo2 className="h-5 w-5" />}
            onClick={() => navigate("/orders?status=returned")}
          />
        </div>
      </section>

      {/* Money + stock */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Billing & stock</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          <StatCard
            label="Invoiced total"
            value={formatMoney(s?.invoices.total)}
            hint={`${s?.invoices.count ?? 0} sales invoices`}
            tone="info"
            icon={<FileText className="h-5 w-5" />}
            onClick={() => navigate("/invoices")}
          />
          <StatCard
            label="Amount due"
            value={formatMoney(s?.invoices.amountDue)}
            hint="Owner-only figure"
            tone="danger"
            icon={<Wallet className="h-5 w-5" />}
            onClick={() => navigate("/invoices")}
          />
          <StatCard
            label="Customer dues"
            value={formatMoney(s?.dues?.total)}
            hint="Across all customer ledgers"
            tone="danger"
            icon={<Wallet className="h-5 w-5" />}
            onClick={() => navigate("/ledger")}
          />
          <StatCard
            label="Available stock"
            value={s?.stock.availableQty ?? 0}
            hint={`${s?.stock.onRentQty ?? 0} on rent of ${s?.stock.totalQty ?? 0}`}
            tone="success"
            icon={<Boxes className="h-5 w-5" />}
            onClick={() => navigate("/stock")}
          />
          <StatCard
            label="Customers"
            value={s?.customers ?? 0}
            hint="Click to manage"
            tone="muted"
            icon={<Users className="h-5 w-5" />}
            onClick={() => navigate("/customers")}
          />
          <StatCard
            label="Vehicles"
            value={s?.vehicles ?? 0}
            hint="Fleet"
            tone="muted"
            icon={<Car className="h-5 w-5" />}
            onClick={() => navigate("/vehicles")}
          />
          <StatCard
            label="Drivers"
            value={s?.drivers ?? 0}
            hint="Team"
            tone="muted"
            icon={<UserCog className="h-5 w-5" />}
            onClick={() => navigate("/vehicles")}
          />
        </div>
      </section>

      {/* Live fleet map — owner only */}
      {isOwner && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Live fleet</h2>
            <Button variant="ghost" size="sm" onClick={() => navigate("/tracking")}>
              Open tracking <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
          <Card>
            <CardContent className="space-y-3 pt-6">
              <OwnerTrackingMap
                markers={live.data?.markers ?? []}
                sites={(live.data?.trips ?? [])
                  .filter((t) => t.latitude != null && t.longitude != null)
                  .map((t) => ({
                    orderId: t.orderId,
                    customerName: t.customerName,
                    customerAddress: t.customerAddress,
                    driverName: t.driverName,
                    vehicleName: t.vehicleName,
                    vehicleNumber: t.vehicleNumber,
                    status: t.status,
                    latitude: t.latitude as number,
                    longitude: t.longitude as number,
                  }))}
                height={360}
              />
              <MapLegend />
            </CardContent>
          </Card>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Recent orders</h2>
            <Button variant="ghost" size="sm" onClick={() => navigate("/orders")}>
              View all
            </Button>
          </div>
          {recentOrders.length === 0 ? (
            <EmptyState
              icon={<ClipboardList className="h-5 w-5" />}
              title="No orders yet"
              description="Orders created by drivers land here for approval. Create the first one to get started."
              action={<Button onClick={() => navigate("/orders/new")}>Create an order</Button>}
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Customer</TH>
                  <TH>Date (BS)</TH>
                  <TH>Driver</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {recentOrders.map((o) => (
                  <TR key={o.id} className="cursor-pointer" onClick={() => navigate(`/orders/${o.id}`)}>
                    <TD className="font-medium">{o.customerName ?? "—"}</TD>
                    <TD className="text-muted-foreground">{bsDisplay(o.orderDateAd)}</TD>
                    <TD className="text-muted-foreground">{o.driverName ?? "—"}</TD>
                    <TD>
                      <StatusPill status={o.status} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Bikram Sambat calendar</h2>
          <BsCalendar year={bs.year} month={bs.month} />
          <div className="rounded-xl border bg-card p-4 text-sm">
            <p className="font-semibold">Today</p>
            <p className="text-muted-foreground">{today.long}</p>
            <p className="text-muted-foreground">{today.nepali}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge tone="info">AD {today.ad}</Badge>
              <Badge tone="accent">BS {today.bsIso}</Badge>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
