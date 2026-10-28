// ── One honest answer to "is my work saved?" ──────────────────────────────────
//
// The strip under the header used to be built from an ad-hoc stack of ternaries
// over five boolean-ish flags. That is how it ended up able to say "Online —
// everything is up to date" while a write was sitting in the outbox, and how a
// replayed (already-applied) action could surface as "some changes may not have
// been applied".
//
// This module owns the decision instead. It is a pure function over the raw
// counters, so the rules — including "a synced app must stop complaining" — are
// unit-testable without a browser, and there is exactly one place that can make
// the banner say something untrue.
//
// Precedence is deliberate, worst-case first: a refusal outranks queued work,
// and queued work outranks "syncing", because the user's question is "is there
// anything of mine that has NOT landed?" — not "was a request in flight?".

export type SyncStatusKind = "checking" | "offline" | "syncing" | "pending" | "conflicts" | "synced";

/** Visual weight, mapped to classes by the banner. */
export type SyncTone = "neutral" | "ok" | "info" | "warn" | "error";

export interface SyncStatusInput {
  online: boolean;
  checked: boolean;
  syncing: boolean;
  /** Writes still in the outbox. */
  pending: number;
  /** Changes the server genuinely refused (NOT replayed, already-applied ones). */
  conflicts: number;
  /** Epoch ms of the last successful drain, or null. */
  lastSyncAt?: number | null;
}

export interface SyncStatus {
  kind: SyncStatusKind;
  tone: SyncTone;
  label: string;
  /** A second line of context, or null when the label says everything. */
  detail: string | null;
  /** Offer the one-click "Sync now" button. */
  canRetry: boolean;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function syncStatus(s: SyncStatusInput): SyncStatus {
  // Nothing is known yet. Saying "everything is up to date" here would be a
  // guess, and this banner exists because guesses were the problem.
  if (!s.checked) {
    return { kind: "checking", tone: "neutral", label: "Checking connection…", detail: null, canRetry: false };
  }

  if (!s.online) {
    return {
      kind: "offline",
      tone: "warn",
      label: "Offline — showing saved data",
      detail:
        s.pending > 0
          ? `${s.pending} ${plural(s.pending, "change is", "changes are")} stored on this device and will upload automatically.`
          : "Anything you enter is stored on this device and uploads when the connection returns.",
      canRetry: false,
    };
  }

  // A real refusal needs a decision from the user, so it outranks everything.
  if (s.conflicts > 0) {
    return {
      kind: "conflicts",
      tone: "error",
      label: `${s.conflicts} ${plural(s.conflicts, "change", "changes")} could not be applied`,
      detail: "The record had already changed on the server. Nothing was lost — review them below.",
      canRetry: false,
    };
  }

  if (s.pending > 0) {
    return {
      kind: s.syncing ? "syncing" : "pending",
      tone: "info",
      label: s.syncing
        ? `Syncing ${s.pending} ${plural(s.pending, "change", "changes")}…`
        : `${s.pending} ${plural(s.pending, "change", "changes")} waiting to sync`,
      detail: s.syncing ? null : "They upload on their own within seconds — or use Sync now.",
      canRetry: !s.syncing,
    };
  }

  // Nothing queued, nothing refused. This MUST be the quiet state, and it must
  // clear any earlier notice — a banner that lingers after the problem is gone
  // teaches the user to ignore it.
  return {
    kind: "synced",
    tone: "ok",
    label: "Everything is up to date",
    detail: s.lastSyncAt ? `Last sync ${new Date(s.lastSyncAt).toLocaleTimeString()}` : null,
    canRetry: false,
  };
}

/**
 * Whether the banner should take any visual space at all.
 *
 * The quiet state still renders (a thin, muted row) because the user is entitled
 * to a positive confirmation rather than the absence of one — the strip is the
 * app's answer to "did that save?". Everything else is louder.
 */
export function isQuiet(status: SyncStatus): boolean {
  return status.kind === "synced";
}
