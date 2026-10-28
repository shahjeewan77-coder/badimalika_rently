// ── Sync page ────────────────────────────────────────────────────────────────
//
// The place the offline bar sends you when something needs attention: the writes
// still waiting to be uploaded, and the changes the server refused to apply.
//
// Nothing here is destructive by accident — a queued action can be discarded only
// by an explicit click, and a conflict is quoted in full (what you tried to do,
// and what the server said) before you dismiss it.

import { useEffect, useState } from "react";
import { CloudOff, CloudUpload, RefreshCw, Trash2, AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { EmptyState, PageHeader, Badge } from "@/components/ui/primitives";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AppLayout } from "@/components/AppLayout";
import { useOfflineState } from "@/lib/offline/provider";
import { refreshPendingActions, requestSync, usePendingActions } from "@/lib/offline/runtime";
import { dismissConflict, dropAction, listConflicts, type ConflictRecord } from "@/lib/offline/engine";
import { describeAction } from "@/lib/offline/registry";
import { relativeTime } from "@/lib/format";

export default function Sync() {
  const { online, checked, syncing, pending, conflicts, lastSyncAt } = useOfflineState();
  const actions = usePendingActions();
  const [conflictRows, setConflictRows] = useState<ConflictRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function reload() {
    setConflictRows(await listConflicts());
    await refreshPendingActions();
  }

  useEffect(() => {
    void reload();
  }, [pending, conflicts]);

  async function discard(id: string) {
    setBusy(id);
    await dropAction(id);
    await reload();
    setBusy(null);
  }

  async function dismiss(id: string) {
    setBusy(id);
    await dismissConflict(id);
    await reload();
    setBusy(null);
  }

  return (
    <AppLayout>
      <PageHeader
        title="Offline & sync"
        subtitle="Writes you make without a connection are stored on this device and uploaded automatically when the connection returns."
        actions={
          <Button onClick={() => requestSync()} disabled={!online || syncing}>
            <RefreshCw className={syncing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            {syncing ? "Syncing…" : "Sync now"}
          </Button>
        }
      />

      {/* Status summary */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              <CloudUpload className="h-4 w-4" /> Connection
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-bold">{!checked ? "Checking…" : online ? "Online" : "Offline"}</p>
            <p className="text-xs text-muted-foreground">
              {online
                ? "Your changes upload as soon as you save them."
                : "You can keep working — everything is stored on this device and uploaded later."}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              <Clock className="h-4 w-4" /> Waiting to upload
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-bold tabular-nums">{pending}</p>
            <p className="text-xs text-muted-foreground">
              {lastSyncAt ? `Last synced ${relativeTime(new Date(lastSyncAt).toISOString())}` : "Not synced yet"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              <AlertTriangle className="h-4 w-4" /> Not applied
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-bold tabular-nums">{conflicts}</p>
            <p className="text-xs text-muted-foreground">Changes the server would not accept, listed below.</p>
          </CardContent>
        </Card>
      </div>

      {/* Conflicts first — they need a decision. */}
      {conflictRows.length > 0 && (
        <Card className="border-rose-300/60 dark:border-rose-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-rose-600 dark:text-rose-400" /> Changes that could not be applied
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              The order or record had already changed on the server, so your queued change was not applied. Your data is not lost —
              the details are below, and the screen showing that record now reflects the server's version.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {conflictRows.map((c) => (
              <div key={c.id} className="space-y-2 rounded-lg border border-rose-200 bg-rose-50/60 p-3 text-sm dark:border-rose-500/20 dark:bg-rose-500/5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">{c.description}</span>
                  <Badge tone={c.policy === "server" ? "warning" : "info"}>
                    {c.policy === "server" ? "Server kept its version" : "Your version was kept"}
                  </Badge>
                </div>
                <p className="text-muted-foreground">{c.message}</p>
                <p className="text-xs text-muted-foreground">
                  {relativeTime(c.at)} · action: <code className="rounded bg-muted px-1">{c.path}</code>
                  {c.code ? ` · ${c.code}` : ""}
                </p>
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">What was sent</summary>
                  <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 text-[11px]">
                    {JSON.stringify(c.input, null, 2)}
                  </pre>
                </details>
                <div className="flex justify-end">
                  <Button variant="outline" size="sm" disabled={busy === c.id} onClick={() => dismiss(c.id)}>
                    <CheckCircle2 className="h-4 w-4" /> Acknowledge
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* The queue itself. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CloudOff className="h-4 w-4 text-primary" /> Waiting to sync ({pending})
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            These are uploaded oldest first, in the order you made them, so an order always reaches the server after the customer it
            refers to.
          </p>
        </CardHeader>
        <CardContent>
          {actions.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 className="h-5 w-5" />}
              title="Everything is uploaded"
              description="Nothing is waiting. Anything you enter while offline will appear here until it has been sent."
            />
          ) : (
            <ul className="divide-y">
              {actions.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div className="min-w-0 space-y-0.5">
                    <p className="truncate text-sm font-medium">{describeAction(a.path, a.input, a.meta)}</p>
                    <p className="text-xs text-muted-foreground">
                      {relativeTime(a.createdAt)} · {a.dateBs} BS
                      {a.attempts > 0 ? ` · ${a.attempts} attempt${a.attempts === 1 ? "" : "s"} failed` : ""}
                    </p>
                    {a.lastError && <p className="text-xs text-amber-700 dark:text-amber-400">{a.lastError}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone="muted">
                      {a.path.startsWith("orders.")
                        ? "Order"
                        : a.path.startsWith("receipts.")
                          ? "Receipt"
                          : a.path.startsWith("customers.")
                            ? "Customer"
                            : "Record"}
                    </Badge>
                    <Button variant="ghost" size="sm" disabled={busy === a.id} onClick={() => discard(a.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" /> Discard
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Stored on this device only. Signing out does not delete pending changes — they upload the next time this device is online with
        your account signed in.
      </p>
    </AppLayout>
  );
}
