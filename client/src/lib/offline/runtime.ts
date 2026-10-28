// ── Offline runtime bridges ──────────────────────────────────────────────────
//
// Two small bridges so screens can drive the sync engine and read the queue
// without importing the provider (which would create a cycle):
//
//   * a registered "sync now" trigger, so the banner and the Sync page can ask
//     for a flush;
//   * a live view of the queued actions, so a list can mark the rows that have
//     not reached the server yet.

import { useSyncExternalStore } from "react";
import { listOutbox, type OutboxAction } from "./engine";

let trigger: (() => void) | null = null;

export function registerSync(fn: (() => void) | null): void {
  trigger = fn;
}

export function requestSync(): void {
  trigger?.();
}

let actions: OutboxAction[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Reload the queue snapshot the UI reads. */
export async function refreshPendingActions(): Promise<void> {
  try {
    actions = await listOutbox();
  } catch {
    actions = [];
  }
  emit();
}

function subscribeActions(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function usePendingActions(): OutboxAction[] {
  return useSyncExternalStore(subscribeActions, () => actions, () => actions);
}

/** True when a row the user is looking at still has unsent changes. */
export function useHasPendingOrder(id: string | undefined): boolean {
  const pending = usePendingActions();
  if (!id) return false;
  return pending.some((a) => a.path.startsWith("orders.") && String((a.input as { id?: string })?.id ?? "") === id);
}
