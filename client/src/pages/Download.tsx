import { useEffect } from "react";
import { Link } from "wouter";
import { Download as DownloadIcon, Smartphone, Monitor, Package, CheckCircle2 } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { PageHeader, Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useInstallPrompt } from "@/lib/pwa";

export default function Download() {
  const { canInstall, installed, install } = useInstallPrompt();

  useEffect(() => {
    document.title = "Download — Equipment Rental";
  }, []);

  return (
    <AppLayout>
      <PageHeader
        title="Download & install"
        subtitle="Install the app on your phone or desktop, or download the source package to self-host."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Smartphone className="h-4 w-4 text-primary" /> Install as an app (PWA)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {installed ? (
              <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4" /> Already installed on this device.
              </div>
            ) : canInstall ? (
              <Button onClick={install}>
                <DownloadIcon className="h-4 w-4" /> Install this app
              </Button>
            ) : (
              <p className="text-muted-foreground">
                Your browser will offer an install button when available. You can also install manually:
              </p>
            )}
            <ul className="space-y-2 text-muted-foreground">
              <li className="flex gap-2">
                <Monitor className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>
                  <strong className="text-foreground">Desktop (Chrome/Edge):</strong> click the install icon in the address
                  bar, or menu → “Install Equipment Rental”.
                </span>
              </li>
              <li className="flex gap-2">
                <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>
                  <strong className="text-foreground">Android:</strong> menu → “Add to Home screen”.
                </span>
              </li>
              <li className="flex gap-2">
                <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>
                  <strong className="text-foreground">iPhone (Safari):</strong> Share → “Add to Home Screen”.
                </span>
              </li>
            </ul>
            <p className="text-xs text-muted-foreground">
              Once installed it opens full-screen like a native app and keeps working from your home screen.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Package className="h-4 w-4 text-primary" /> Downloadable package
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-muted-foreground">
              The full source package (React + tRPC + Postgres) with a README covering setup, seeding and deployment.
            </p>
            <div className="flex flex-wrap gap-2">
              <Badge tone="info">React 19</Badge>
              <Badge tone="info">tRPC</Badge>
              <Badge tone="info">Drizzle + Postgres</Badge>
              <Badge tone="info">PWA</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              The package link is provided with your delivery message. It contains the complete project so you can run it
              on your own server.
            </p>
            <Button variant="outline" asChild>
              <Link to="/">Back to dashboard</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
