import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  ClipboardList,
  FileText,
  PackageCheck,
  Boxes,
  Users,
  Truck,
  UserCog,
  LogOut,
  Menu,
  X,
  Moon,
  Sun,
  Download,
  HardHat,
  BookOpen,
  Navigation,
  History,
} from "lucide-react";
import { useAuth } from "@/_core/useAuth";
import { useAccount } from "@/lib/useAccount";
import { useTheme } from "@/lib/theme";
import { useInstallPrompt } from "@/lib/pwa";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { todayBs } from "@/lib/format";
import { OfflineBar } from "@/components/OfflineBar";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  ownerOnly?: boolean;
  driverOnly?: boolean;
}

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: <LayoutDashboard className="h-4 w-4" /> },
  { href: "/orders", label: "Orders", icon: <ClipboardList className="h-4 w-4" /> },
  { href: "/rentals", label: "On Rent", icon: <PackageCheck className="h-4 w-4" /> },
  { href: "/tracking", label: "Live Tracking", icon: <Navigation className="h-4 w-4" />, ownerOnly: true },
  { href: "/stock", label: "Stock", icon: <Boxes className="h-4 w-4" /> },
  { href: "/invoices", label: "Invoices", icon: <FileText className="h-4 w-4" />, ownerOnly: true },
  { href: "/ledger", label: "Customer Ledger", icon: <BookOpen className="h-4 w-4" />, ownerOnly: true },
  { href: "/customers", label: "Customers", icon: <Users className="h-4 w-4" /> },
  { href: "/vehicles", label: "Vehicles & Drivers", icon: <Truck className="h-4 w-4" />, ownerOnly: true },
  { href: "/users", label: "Users", icon: <UserCog className="h-4 w-4" />, ownerOnly: true },
  { href: "/audit", label: "Audit Trail", icon: <History className="h-4 w-4" />, ownerOnly: true },
];

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const { account } = useAccount();
  const { theme, toggle } = useTheme();
  const { canInstall, install } = useInstallPrompt();
  const [location, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const today = todayBs();

  const role = account?.role ?? "owner";
  const items = NAV.filter((n) => (n.ownerOnly ? role === "owner" : true) && (n.driverOnly ? role === "driver" : true));

  async function onLogout() {
    await logout();
    navigate("/login");
  }

  const sidebar = (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <HardHat className="h-5 w-5" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-bold">Equipment Rental</p>
          <p className="text-[11px] text-sidebar-muted">Management System</p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {items.map((item) => {
          const active = location === item.href || location.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active ? "bg-sidebar-active text-white" : "text-sidebar-foreground/80 hover:bg-white/10",
              )}
            >
              {item.icon}
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-2 border-t border-white/10 p-3">
        {canInstall && (
          <button
            onClick={install}
            className="flex w-full items-center gap-2 rounded-lg bg-accent/90 px-3 py-2 text-sm font-semibold text-accent-foreground hover:bg-accent"
          >
            <Download className="h-4 w-4" /> Install app
          </button>
        )}
        <div className="rounded-lg bg-white/5 px-3 py-2">
          <p className="truncate text-sm font-semibold">{account?.displayName ?? user?.name ?? user?.email}</p>
          <p className="text-[11px] text-sidebar-muted">{role === "owner" ? "Owner / Admin" : "Driver"}</p>
        </div>
        <button
          onClick={onLogout}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground/80 hover:bg-white/10"
        >
          <LogOut className="h-4 w-4" /> Log out
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 lg:block">
        <div className="fixed inset-y-0 w-64">{sidebar}</div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-64">{sidebar}</div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b bg-card/80 px-4 py-3 backdrop-blur lg:px-8">
          <div className="flex items-center gap-3">
            <button className="rounded-md p-1.5 hover:bg-muted lg:hidden" onClick={() => setOpen((o) => !o)} aria-label="Menu">
              {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
            <div className="leading-tight">
              <p className="text-sm font-semibold">{today.long}</p>
              <p className="text-[11px] text-muted-foreground">
                {today.weekday} · {today.nepali}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </div>
        </header>

        <OfflineBar />

        <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
