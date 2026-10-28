// ── Local-id aliases ─────────────────────────────────────────────────────────
//
// A record created offline gets a `pending-…` id. Once the queue has synced it,
// the server's real id is recorded here, and every later read that names the old
// id is redirected to the new one — so a deep link to the order the driver just
// created keeps working after it has been uploaded, instead of 404-ing.

import { STORE_META, idbGet, idbSet } from "./idb";
import { isLocalId } from "./registry";

const ALIAS_KEY = "idAliases";

type AliasMap = Record<string, string>;

let cache: AliasMap | null = null;

async function load(): Promise<AliasMap> {
  if (cache) return cache;
  try {
    cache = (await idbGet<AliasMap>(STORE_META, ALIAS_KEY)) ?? {};
  } catch {
    cache = {};
  }
  return cache;
}

export async function setIdAlias(localId: string, realId: string): Promise<void> {
  const map = await load();
  map[localId] = realId;
  try {
    await idbSet(STORE_META, ALIAS_KEY, map);
  } catch {
    /* best effort */
  }
}

export async function getIdAlias(localId: string): Promise<string | null> {
  const map = await load();
  return map[localId] ?? null;
}

/** Rewrite any `input.id` (or `customerId`/`orderId`) that names a synced record. */
export async function resolveAliasInput(input: unknown): Promise<unknown> {
  if (!input || typeof input !== "object") return input;
  const obj = input as Record<string, unknown>;
  const next: Record<string, unknown> = { ...obj };
  let changed = false;
  for (const key of ["id", "customerId", "orderId"]) {
    const value = next[key];
    if (isLocalId(value)) {
      const real = await getIdAlias(value);
      if (real) {
        next[key] = real;
        changed = true;
      }
    }
  }
  return changed ? next : input;
}
