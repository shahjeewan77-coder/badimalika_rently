import { useEffect, type ReactNode } from "react";
import { Route, Switch, Redirect, useLocation } from "wouter";
import { useAuth } from "./_core/useAuth";
import { useAccount } from "./lib/useAccount";
import { TrackingProvider } from "./lib/trackingProvider";
import Home from "./pages/Home";
import Login from "./pages/Login";
import ForgotPassword from "./pages/ForgotPassword";
import Signup from "./pages/Signup";
import Dashboard from "./pages/Dashboard";
import Orders from "./pages/Orders";
import NewOrder from "./pages/NewOrder";
import OrderDetail from "./pages/OrderDetail";
import Invoices from "./pages/Invoices";
import Rentals from "./pages/Rentals";
import Stock from "./pages/Stock";
import StockMovements from "./pages/StockMovements";
import Customers from "./pages/Customers";
import CustomerLedger from "./pages/CustomerLedger";
import Ledger from "./pages/Ledger";
import Vehicles from "./pages/Vehicles";
import Users from "./pages/Users";
import Download from "./pages/Download";
import Sync from "./pages/Sync";
import Tracking from "./pages/Tracking";
import AuditLog from "./pages/AuditLog";

/**
 * Route guard.
 *
 * `level` is the access boundary a page belongs to:
 *   "auth"   — any signed-in user
 *   "owner"  — Owner/Admin only (money, invoices, fleet, users)
 *   "driver" — Driver only
 *
 * Membership comes from the business profile (`profiles.role`), which is the
 * app's single source of truth for owner-vs-driver — the scaffold `users.role`
 * column is not used for this. The fetch is issued fresh for each identity (the
 * auth layer clears the query cache on login/logout and refetches it), so a
 * driver can never satisfy the owner check from a previous account's data.
 *
 * While the profile is still loading we render the loading state rather than
 * defaulting to owner — a driver must never briefly see the owner's money
 * views. A user who fails the check is sent to their own home instead of being
 * trapped, so no redirect loop is possible.
 */
type Level = "auth" | "owner" | "driver";

function RedirectAway() {
  const [, navigate] = useLocation();
  useEffect(() => {
    navigate("/", { replace: true });
  }, [navigate]);
  return <div className="p-8 text-muted-foreground">Redirecting…</div>;
}

function Protected({ children, level = "auth" }: { children: ReactNode; level?: Level }) {
  const { user, isLoading } = useAuth();
  const { account, isLoading: accountLoading } = useAccount();

  if (isLoading || (user && accountLoading)) return <div className="p-8 text-muted-foreground">Loading…</div>;
  if (!user) return <Redirect to="/login" />;
  if (!account) return <RedirectAway />;

  if (level === "owner" && account.role !== "owner") return <RedirectAway />;
  if (level === "driver" && account.role !== "driver") return <RedirectAway />;

  return <>{children}</>;
}

export default function App() {
  // The driver's GPS tracker lives ABOVE the router so it keeps running while
  // the driver moves between screens. Mounted inside a single screen it used to
  // die the moment the driver left that screen — which is precisely when they
  // are on the road — and the owner's map went silent.
  return (
    <TrackingProvider>
      <Switch>
      <Route path="/login" component={Login} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/signup" component={Signup} />
      <Route path="/download" component={Download} />

      <Route path="/">
        <Protected>
          <Home />
        </Protected>
      </Route>
      <Route path="/dashboard">
        <Protected>
          <Dashboard />
        </Protected>
      </Route>
      <Route path="/orders/new">
        <Protected>
          <NewOrder />
        </Protected>
      </Route>
      <Route path="/orders/:id">
        <Protected>
          <OrderDetail />
        </Protected>
      </Route>
      <Route path="/orders">
        <Protected>
          <Orders />
        </Protected>
      </Route>
      <Route path="/invoices">
        <Protected level="owner">
          <Invoices />
        </Protected>
      </Route>
      <Route path="/rentals">
        <Protected>
          <Rentals />
        </Protected>
      </Route>
      <Route path="/stock">
        <Protected>
          <Stock />
        </Protected>
      </Route>
      {/* Per-item stock movement report, opened from the Stock report's
          clickable Closing Stock figure. Owner only — it carries no money, but
          it is a full operational ledger, and the procedure behind it also
          rejects drivers with a 403. */}
      <Route path="/stock/:equipmentId/movements">
        <Protected level="owner">
          <StockMovements />
        </Protected>
      </Route>
      <Route path="/customers">
        <Protected>
          <Customers />
        </Protected>
      </Route>

      <Route path="/customers/:id/ledger">
        <Protected level="owner">
          <CustomerLedger />
        </Protected>
      </Route>

      <Route path="/ledger">
        <Protected level="owner">
          <Ledger />
        </Protected>
      </Route>
      <Route path="/vehicles">
        <Protected level="owner">
          <Vehicles />
        </Protected>
      </Route>
      <Route path="/users">
        <Protected level="owner">
          <Users />
        </Protected>
      </Route>

      <Route path="/tracking">
        <Protected level="owner">
          <Tracking />
        </Protected>
      </Route>

      {/* The audit trail behind the owner's edit/delete power. Owner only. */}
      <Route path="/audit">
        <Protected level="owner">
          <AuditLog />
        </Protected>
      </Route>

      <Route path="/sync">
        <Protected>
          <Sync />
        </Protected>
      </Route>

      <Route>{() => <div className="p-8">Not found</div>}</Route>
      </Switch>
    </TrackingProvider>
  );
}
