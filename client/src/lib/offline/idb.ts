// ── Minimal IndexedDB layer ──────────────────────────────────────────────────
//
// Three stores, one database, no dependencies:
//
//   cache   — the last successful reply for each tRPC query, keyed by
//             `procedure|input`. This is what makes already-loaded data readable
//             with no network.
//   outbox  — writes the user made while offline, in the order they were made.
//   meta    — small singletons: the cached offline session, the last-synced time.
//
// Every function rejects on failure, and every caller treats that as "offline
// support is unavailable" rather than a fatal error — a browser with IndexedDB
// blocked (private mode, some embedded webviews) must still run the app online.

const DB_NAME = "erm-offline";
const DB_VERSION = 1;

export const STORE_CACHE = "cache";
export const STORE_OUTBOX = "outbox";
export const STORE_META = "meta";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CACHE)) db.createObjectStore(STORE_CACHE);
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) db.createObjectStore(STORE_OUTBOX, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB could not be opened"));
    req.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another tab"));
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

async function withStore<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest | void,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(store, mode);
    } catch (e) {
      reject(e);
      return;
    }
    const s = tx.objectStore(store);
    let result: unknown;
    let request: IDBRequest | void;
    try {
      request = fn(s);
    } catch (e) {
      reject(e);
      return;
    }
    if (request) request.onsuccess = () => (result = request.result);
    tx.oncomplete = () => resolve(result as T);
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return withStore<T | undefined>(store, "readonly", (s) => s.get(key));
}

export function idbSet(store: string, key: IDBValidKey, value: unknown): Promise<void> {
  return withStore<void>(store, "readwrite", (s) => {
    s.put(value, key);
  });
}

/**
 * Write a value to a store that owns its own key.
 *
 * The outbox store uses an inline keyPath (`id`), and IndexedDB REJECTS an
 * explicit key alongside one — so `idbSet` would throw a DataError here. The
 * record supplies its own `id`.
 */
export function idbPut(store: string, value: { id: string } & Record<string, unknown>): Promise<void> {
  return withStore<void>(store, "readwrite", (s) => {
    s.put(value);
  });
}

export function idbDel(store: string, key: IDBValidKey): Promise<void> {
  return withStore<void>(store, "readwrite", (s) => {
    s.delete(key);
  });
}

export function idbAll<T>(store: string): Promise<T[]> {
  return withStore<T[]>(store, "readonly", (s) => s.getAll());
}

export function idbKeys(store: string): Promise<IDBValidKey[]> {
  return withStore<IDBValidKey[]>(store, "readonly", (s) => s.getAllKeys());
}

export function idbClear(store: string): Promise<void> {
  return withStore<void>(store, "readwrite", (s) => {
    s.clear();
  });
}

/** Cache helpers — thin typed wrappers over the generic store API. */
export function cacheGet<T>(key: string): Promise<T | undefined> {
  return idbGet<T>(STORE_CACHE, key);
}
export function cacheSet(key: string, value: unknown): Promise<void> {
  return idbSet(STORE_CACHE, key, value);
}
export function cacheDel(key: string): Promise<void> {
  return idbDel(STORE_CACHE, key);
}

/**
 * Drop every cached query reply. Called when the signed-in identity changes, so
 * one account's data (a driver's orders, the owner's money) can never be served
 * to the next account. The outbox is deliberately untouched: a queued write is
 * the user's own data and must survive a sign-out.
 */
export function clearQueryCache(): Promise<void> {
  return idbClear(STORE_CACHE).catch(() => undefined);
}

/**
 * Cached replies are wrapped rather than stored bare, so a reply that happens to
 * have a `data` field of its own can never be mistaken for the wrapper.
 */
export interface CachedQuery {
  __cached: true;
  data: unknown;
}

export function cacheSetQuery(key: string, data: unknown): Promise<void> {
  return cacheSet(key, { __cached: true, data } satisfies CachedQuery);
}

/** The value of a cached reply, unwrapped. Tolerates a bare (legacy) value. */
export function unwrapCached(value: unknown): unknown {
  if (value && typeof value === "object" && (value as CachedQuery).__cached === true) {
    return (value as CachedQuery).data;
  }
  return value;
}

export async function cacheGetQuery<T>(key: string): Promise<T | undefined> {
  const entry = await cacheGet(key);
  if (entry === undefined) return undefined;
  return unwrapCached(entry) as T;
}

/** The cache key for one query. Stable for equal inputs regardless of key order. */
export function queryCacheKey(path: string, input: unknown): string {
  return `${path}|${stableStringify(input ?? null)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
