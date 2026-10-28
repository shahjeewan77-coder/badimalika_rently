// ── Sync status strip ────────────────────────────────────────────────────────
//
// A slim, always-visible strip under the header that answers the one question
// the user actually has: *is my work saved?*
//
// It renders a single resolved status (see lib/offline/status.ts) rather than
// composing its own message from raw flags. That is the whole point: the strip
// used to be able to say "Online — everything is up to date" with a write
// sitting in the outbox, and to report a replayed (already-applied) action as
// "some changes may not have been applied".
//
// Three states are shown, and nothing else:
//
//   green  · Everything is up to date          (quiet, one thin line)
//   blue   · N changes waiting to sync  + Sync now
//   amber  · Offline — showing saved data
//   rose   · N changes could not be applied  + Review
//
// The blue/amber/rose states disappear on their own the moment the outbox
// empties and the conflicts are cleared, because `refreshCounts` re-derives them
// from the queue rather than from a memory of what went wrong.

import { Link } from "wouter";
import { CloudOff, CloudUpload, RefreshCw, AlertTriangle, Cloud, Check, Loader2, Download } from "lucide-react";
import { useOfflineState } from "@/lib/offline/provider";
import { requestSync } from "@/lib/offline/runtime";
import { isQuiet, syncStatus } from "@/lib/offline/status";
import { useAppUpdate } from "@/lib/pwa";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<string, string> = {
  ok: "border-b bg-card/60 text-muted-foreground",
  neutral: "border-b bg-card/60 text-muted-foreground",
  info: "border-b bg-blue-100 text-blue-900 dark:bg-blue-500/15 dark:text-blue-200",
  warn: "border-b bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200",
  error: "border-b bg-rose-100 text-rose-900 dark:bg-rose-500/15 dark:text-rose-200",
};

const ICON = {
  checking: Loader2,
  offline: CloudOff,
  syncing: Loader2,
  pending: CloudUpload,
  conflicts: AlertTriangle,
  synced: Cloud,
} as const;

export function OfflineBar() {
  const state = useOfflineState();
  const status = syncStatus(state);
  const update = useAppUpdate();
  const Icon = ICON[status.kind];
  const quiet = isQuiet(status);

  return (
    <>
      {/* A new build is ready. Shown above everything, because a stale bundle is
          the one problem the status strip cannot fix on its own. */}
      {update.ready && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-violet-100 px-4 py-1.5 text-xs font-medium text-violet-900 dark:bg-violet-500/15 dark:text-violet-200 lg:px-8">
          <span className="flex items-center gap-1.5">
            <Download className="h-3.5 w-3.5" />
            A new version of the app is ready
          </span>
          <button
            onClick={update.apply}
            className="ml-auto rounded-md bg-black/10 px-2 py-0.5 font-semibold hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20"
          >
            Reload to update
          </button>
        </div>
      )}

      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-1 px-4 text-xs font-medium lg:px-8",
          TONE_CLASS[status.tone] ?? TONE_CLASS.ok,
          quiet ? "py-1 text-[11px]" : "py-1.5",
        )}
        // Screen readers get the same single sentence the eye gets.
        role="status"
        aria-live="polite"
      >
        <span className="flex items-center gap-1.5">
          <Icon
            className={cn(
              "h-3.5 w-3.5",
              quiet && "text-emerald-600 dark:text-emerald-400",
              (status.kind === "syncing" || status.kind === "checking") && "animate-spin",
            )}
          />
          {status.label}
          {status.kind === "synced" && <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />}
        </span>

        {status.detail && <span className="opacity-80">{status.detail}</span>}

        <span className="ml-auto flex items-center gap-2">
          {status.canRetry && (
            <button
              onClick={() => requestSync()}
              disabled={state.syncing}
              className="flex items-center gap-1 rounded-md bg-black/10 px-2 py-0.5 font-semibold hover:bg-black/20 disabled:opacity-60 dark:bg-white/10 dark:hover:bg-white/20"
            >
              <RefreshCw className={cn("h-3 w-3", state.syncing && "animate-spin")} />
              {state.syncing ? "Syncing…" : "Sync now"}
            </button>
          )}
          {status.kind === "conflicts" && (
            <Link href="/sync" className="underline underline-offset-2">
              Review
            </Link>
          )}
          {(status.kind === "pending" || status.kind === "offline") && state.pending > 0 && (
            <Link href="/sync" className="underline underline-offset-2">
              View queue
            </Link>
          )}
        </span>

        {!quiet && state.notice && <span className="w-full text-[11px] font-normal opacity-90">{state.notice}</span>}
      </div>
    </>
  );
}

/** A small chip that marks one row as not yet uploaded. */
export function PendingBadge({ className }: { className?: string }) {
  const { pending } = useOfflineState();
  if (pending === 0) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
        className,
      )}
    >
      <CloudUpload className="h-3 w-3" /> Pending sync
    </span>
  );
}
