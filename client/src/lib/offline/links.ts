// ── Offline tRPC links ───────────────────────────────────────────────────────
//
// Two links wrap the HTTP link, and between them they are the whole offline
// data path:
//
//   query    — remembers every successful reply in IndexedDB, and serves that
//              reply back when the request cannot reach the server. This is what
//              lets already-loaded orders, customers, stock and ledgers stay
//              readable offline.
//   mutation — attempts the write normally while online, and QUEUES it in the
//              outbox when offline (or when the attempt could not reach the
//              server). Writes that must happen now — signing in, resetting a
//              password — are refused with a clear message instead of being
//              silently parked.
//
// A queued write is applied optimistically to the cached reads it affects, so
// the user sees their own change immediately. The user is signed in and the data
// itself is protected by the same rule as the live app: a driver never receives
// money, because the server never sends it.

import { observable, type Observer } from "@trpc/server/observable";
import type { TRPCLink } from "@trpc/client";
import type { AppRouter } from "../../../../server/routers";
import { cacheGetQuery, cacheSetQuery } from "./idb";
import { isOffline, noteLiveData, noteServedFromCache, probeReachability, setNotice, setState } from "./store";
import { applyAction, enqueue, listConflicts, outboxCount } from "./engine";
import { decideQueue, isQueueable, makeLocalId } from "./registry";
import { queryKeyFor } from "./keys";
import { resolveAliasInput } from "./aliases";

export interface OfflineMeta {
  userId?: string | null;
  role?: "owner" | "driver";
  driverId?: string | null;
  driverName?: string | null;
  /** Extra context used to describe the action on the Sync page. */
  label?: string;
  localId?: string;
  [k: string]: unknown;
}

/** A network-level failure: nothing came back from the server at all. */
function looksLikeNetworkFailure(err: unknown): boolean {
  const e = err as { shape?: { data?: unknown }; data?: unknown; message?: string };
  const data = e?.shape?.data ?? e?.data;
  if (data && typeof data === "object" && "httpStatus" in (data as object)) return false;
  return true;
}

function getOnline(): boolean {
  return !isOffline();
}

export function offlineQueryLink(): TRPCLink<AppRouter> {
  return () => ({ op, next }) => {
    if (op.type !== "query") return next(op);
    // The observer is typed loosely on purpose: the envelope's shape belongs to
    // the transport, and a cached reply is replayed through the same channel.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return observable((observer: Observer<any, any>) => {
      let cancelled = false;
      let sub: { unsubscribe: () => void } | undefined;

      void (async () => {
        // A query that names a record created offline is followed to the real id
        // as soon as the queue has resolved it.
        const input = await resolveAliasInput(op.input).catch(() => op.input);
        if (cancelled) return;
        const key = queryKeyFor(op.path, input);

        sub = next({ ...op, input }).subscribe({
          next: (envelope) => {
            const result = envelope?.result as { data?: unknown } | undefined;
            if (result && "data" in result) {
              void cacheSetQuery(key, result.data).catch(() => undefined);
              noteLiveData();
              // A reply that arrived is proof the server is reachable, so the
              // banner corrects itself the moment anything succeeds rather than
              // waiting for the next scheduled check.
              if (!getOnline()) setState({ online: true, checked: true });
            }
            observer.next(envelope);
          },
          error: async (err: unknown) => {
            if (cancelled) return;
            const cached = await cacheGetQuery<unknown>(key).catch(() => undefined);
            if (cached !== undefined && (isOffline() || looksLikeNetworkFailure(err))) {
              // Serve the last good reply. The offline bar makes it explicit that
              // this is stored data, so it never reads as a live answer.
              noteServedFromCache();
              observer.next({ context: {}, result: { data: cached } } as never);
              observer.complete?.();
              return;
            }
            observer.error(err);
          },
          complete: () => observer.complete?.(),
        });
      })();

      return () => {
        cancelled = true;
        sub?.unsubscribe();
      };
    });
  };
}

/** Raised for a write that can only be done with a connection. */
export class OfflineRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineRefusedError";
  }
}

const OFFLINE_REFUSALS: Record<string, string> = {
  "auth.login": "You are offline — sign in with your password to use the app offline.",
  "auth.signup": "Creating the owner account needs an internet connection.",
  "auth.requestPasswordReset": "A reset code has to be emailed, so this needs an internet connection.",
  "auth.verifyResetCode": "Checking the reset code needs an internet connection.",
  "auth.resetPassword": "Setting a new password needs an internet connection.",
  "account.seed": "Seeding the demo data needs an internet connection.",
  "users.createDriver": "Creating a login needs an internet connection.",
  // Owner edits and deletes change records other people may already be acting
  // on — an order that is out on a truck, an invoice a customer has been given.
  // Queuing one would mean the owner thinks a deletion happened when it has
  // not, so these are refused rather than parked. Same for previews: they must
  // report the truth, which only the server knows.
  "admin.deleteOrder": "Deleting a record needs an internet connection — nothing was deleted.",
  "admin.deleteCustomer": "Deleting a record needs an internet connection — nothing was deleted.",
  "admin.deleteEquipment": "Deleting a record needs an internet connection — nothing was deleted.",
  "admin.deleteVehicle": "Deleting a record needs an internet connection — nothing was deleted.",
  "admin.deleteInvoice": "Deleting a record needs an internet connection — nothing was deleted.",
  "admin.deleteUser": "Deleting a user needs an internet connection — nothing was deleted.",
  "admin.editOrder": "Editing an order needs an internet connection — your changes were not saved.",
  "admin.editCustomer": "Editing a customer needs an internet connection — your changes were not saved.",
  "admin.editEquipment": "Editing equipment needs an internet connection — your changes were not saved.",
  "admin.editInvoice": "Editing an invoice needs an internet connection — your changes were not saved.",
  "admin.editReceipt": "Editing a receipt needs an internet connection — your changes were not saved.",
  "admin.editUser": "Editing a user needs an internet connection — your changes were not saved.",
};

export function offlineMutationLink(): TRPCLink<AppRouter> {
  return () => ({ op, next }) => {
    if (op.type !== "mutation") return next(op);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return observable((observer: Observer<any, any>) => {
      const meta = ((op.context as { offline?: OfflineMeta } | undefined)?.offline ?? {}) as OfflineMeta;
      let sub: { unsubscribe: () => void } | undefined;
      let settled = false;

      void (async () => {
        // NOTE: `decideQueue` takes ONLINE, not offline. Passing `isOffline()`
        // here inverted every decision: a queueable write was queued while the
        // app was online (and never sent, because the retry only fires on an
        // offline→online transition) and attempted while offline. That is why a
        // driver's location ping sat in the outbox for the whole trip while the
        // owner's live map showed nothing, even though the driver's card happily
        // reported "Updates sent".
        let decision = decideQueue(op.path, getOnline());

        if (decision === "reject-offline") {
          // The flag can be stale — one failed health check, or a reply that
          // arrived from cache, should not lock the user out of signing in.
          // Confirm against the server before refusing. Only an answer that
          // actually reaches it settles the question; if the confirmation itself
          // fails, `online` is set to false first so it cannot be flipped back
          // to true by an unrelated state change between the two steps.
          const reachable = await probeReachability();
          if (reachable) {
            setState({ online: true, checked: true });
            // `true` = the server IS reachable, so the write is sent now rather
            // than being refused.
            decision = decideQueue(op.path, true);
          } else {
            setState({ online: false, checked: true });
          }
        }

        if (decision === "reject-offline") {
          settled = true;
          const message =
            OFFLINE_REFUSALS[op.path] ?? "That action needs an internet connection — it has not been saved.";
          setNotice(message);
          observer.error(new OfflineRefusedError(message));
          return;
        }

        if (decision === "queue") {
          try {
            const localId = meta.localId ?? makeLocalId();
            const action = await enqueue(op.path, op.input as Record<string, unknown>, { ...meta, localId });
            await applyAction(action, null);
            settled = true;
            setNotice("Saved offline — it will sync when you are back online.");
            observer.next(makeQueuedEnvelope(op.path, localId, meta));
            observer.complete?.();
          } catch (err) {
            settled = true;
            observer.error(err);
          }
          return;
        }

        // Online: send it. If the request cannot reach the server at all, queue
        // it rather than losing it — the connection may have just dropped.
        sub = next(op).subscribe({
          next: (envelope) => observer.next(envelope),
          error: async (err: unknown) => {
            if (settled) return;
            // The connection may have dropped mid-request. Anything the outbox
            // is allowed to hold is queued instead of lost; everything else
            // surfaces the original error.
            if (isQueueable(op.path) && looksLikeNetworkFailure(err)) {
              try {
                const localId = meta.localId ?? makeLocalId();
                const action = await enqueue(op.path, op.input as Record<string, unknown>, { ...meta, localId });
                await applyAction(action, null);
                settled = true;
                setNotice("Connection lost — saved offline, it will sync automatically.");
                observer.next(makeQueuedEnvelope(op.path, localId, meta));
                observer.complete?.();
                return;
              } catch {
                /* fall through to the original error */
              }
            }
            observer.error(err);
          },
          complete: () => observer.complete?.(),
        });
      })();

      void listConflicts().catch(() => undefined);
      void outboxCount().catch(() => undefined);

      return () => sub?.unsubscribe();
    });
  };
}

/**
 * What a queued write resolves to on the client.
 *
 * A create needs an `id` so the page can navigate to the new record; for every
 * other write `{ queued: true }` is a truthful, and harmless, answer. The
 * optimistic cache patch is what actually makes the change visible.
 */
function makeQueuedEnvelope(path: string, localId: string, meta: OfflineMeta): { result: { data: unknown } } {
  if (path === "orders.create") {
    return { result: { data: { id: localId, offline: true, queued: true, status: "pending_approval" } } };
  }
  if (path === "customers.create") {
    return { result: { data: { id: localId, offline: true, queued: true, name: meta.customerName ?? "" } } };
  }
  if (path === "receipts.create") {
    return { result: { data: { id: localId, offline: true, queued: true } } };
  }
  return { result: { data: { offline: true, queued: true, id: localId } } };
}
