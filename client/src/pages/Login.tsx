import { useState, type FormEvent } from "react";
import { Link, Redirect, useLocation } from "wouter";
import { HardHat, ShieldCheck, Truck, CalendarDays } from "lucide-react";
import { useAuth } from "@/_core/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorNote } from "@/components/ui/primitives";

export default function Login() {
  const { login, user } = useAuth();
  const [, navigate] = useLocation();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(identifier, password);
      // Navigate explicitly instead of relying only on the `if (user)`
      // re-render: after a logout in the same tab the auth query has to refetch,
      // and the redirect must not depend on that round-trip winning a race.
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  if (user) return <Redirect to="/" />;

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="relative hidden flex-col justify-between bg-sidebar p-10 text-sidebar-foreground lg:flex">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-accent-foreground">
            <HardHat className="h-6 w-6" />
          </div>
          <div>
            <p className="font-bold">Equipment Rental</p>
            <p className="text-xs text-sidebar-muted">Management System</p>
          </div>
        </div>
        <div className="space-y-6">
          <h1 className="text-3xl font-bold leading-tight">
            Rent equipment by day, hour or pillar — from order to invoice to return.
          </h1>
          <ul className="space-y-3 text-sm text-sidebar-foreground/80">
            <li className="flex items-center gap-3">
              <Truck className="h-4 w-4 text-accent" /> Drivers self-assign a vehicle each day
            </li>
            <li className="flex items-center gap-3">
              <ShieldCheck className="h-4 w-4 text-accent" /> Owner approves every order before dispatch
            </li>
            <li className="flex items-center gap-3">
              <CalendarDays className="h-4 w-4 text-accent" /> Bikram Sambat dates across the dashboard
            </li>
          </ul>
        </div>
        <p className="text-xs text-sidebar-muted">Installable app · works on phone and desktop</p>
      </div>

      <main className="flex items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-xl">Welcome back</CardTitle>
            <CardDescription>Log in to your rental workspace.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="identifier">Email, username or phone</Label>
                <Input
                  id="identifier"
                  type="text"
                  autoComplete="username"
                  placeholder="e.g. ram or 9800000001"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Drivers can sign in with the username or phone number the owner gave them.
                </p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  <Link to="/forgot-password" className="text-xs font-medium text-primary underline">
                    Forgot password?
                  </Link>
                </div>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {error && <ErrorNote>{error}</ErrorNote>}
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Logging in…" : "Log in"}
              </Button>
            </form>
            <p className="mt-4 text-center text-sm text-muted-foreground">
              Setting up the business?{" "}
              <Link to="/signup" className="font-medium text-primary underline">
                Create the owner account
              </Link>
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
