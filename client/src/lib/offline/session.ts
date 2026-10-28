// ── Offline session ──────────────────────────────────────────────────────────
//
// "Login works offline for a previously logged-in user."
//
// The session cookie is HttpOnly and never visible to JS, so offline the app
// cannot check whether that cookie is still valid. What it CAN do:
//
//   1. remember who was last signed in (a small public record — never a token),
//      and
//   2. keep a PBKDF2 verifier of their password on this device.
//
// When the app opens with no internet and a remembered session exists, the login
// screen asks for the password and checks it against that verifier. A correct
// password restores the session locally so the app is usable offline; the real
// cookie is re-validated on the next request that reaches the server.
//
// The verifier is salted with the user id and derived with 60k PBKDF2-SHA256
// iterations, so it cannot be turned back into the password. It is stored only
// because the request requires offline login to work at all; if the platform
// exposes no WebCrypto (non-secure context), no verifier is stored and offline
// login is simply unavailable — the app says so instead of guessing.

import { STORE_META, idbDel, idbGet, idbSet } from "./idb";

const SESSION_KEY = "offlineSession";
const LAST_USER_KEY = "lastUserId";

export interface OfflineSession {
  userId: string;
  /** What the user typed to sign in (email, username or phone). */
  identifier: string;
  email: string;
  name: string | null;
  role: "owner" | "driver";
  displayName: string | null;
  /** PBKDF2 verifier, or null when WebCrypto is unavailable. */
  verifier: string | null;
  password?: never;
  savedAt: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Derive the password verifier, or null when WebCrypto is not usable. */
export async function deriveVerifier(userId: string, password: string): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const enc = new TextEncoder();
    const key = await subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await subtle.deriveBits(
      { name: "PBKDF2", salt: enc.encode(`erm|${userId}`), iterations: 60_000, hash: "SHA-256" },
      key,
      256,
    );
    return bytesToBase64(new Uint8Array(bits));
  } catch {
    return null;
  }
}

/** True when the password matches the stored verifier for this device. */
export async function verifyPassword(session: OfflineSession, password: string): Promise<boolean> {
  if (!session.verifier) return false;
  const candidate = await deriveVerifier(session.userId, password);
  return !!candidate && candidate === session.verifier;
}

export async function saveOfflineSession(input: {
  userId: string;
  identifier: string;
  email: string;
  name: string | null;
  role: "owner" | "driver";
  displayName: string | null;
  password: string;
}): Promise<OfflineSession | null> {
  try {
    const verifier = await deriveVerifier(input.userId, input.password);
    const session: OfflineSession = {
      userId: input.userId,
      identifier: input.identifier.trim(),
      email: input.email,
      name: input.name,
      role: input.role,
      displayName: input.displayName,
      verifier,
      savedAt: Date.now(),
    };
    await idbSet(STORE_META, SESSION_KEY, session);
    await idbSet(STORE_META, LAST_USER_KEY, input.userId);
    return session;
  } catch {
    return null;
  }
}

export async function loadOfflineSession(): Promise<OfflineSession | null> {
  try {
    return (await idbGet<OfflineSession>(STORE_META, SESSION_KEY)) ?? null;
  } catch {
    return null;
  }
}

export async function clearOfflineSession(): Promise<void> {
  try {
    await idbDel(STORE_META, SESSION_KEY);
  } catch {
    /* best effort */
  }
}

/** The remembered user id — used to scope the outbox to one account. */
export async function loadRememberedUserId(): Promise<string | null> {
  try {
    const session = await loadOfflineSession();
    if (session) return session.userId;
    const id = await idbGet<string>(STORE_META, LAST_USER_KEY);
    return id ?? null;
  } catch {
    return null;
  }
}
