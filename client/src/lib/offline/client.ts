// ── tRPC client with the offline layer wired in ──────────────────────────────
//
// `makeTrpcClient()` is what `main.tsx` builds. The link order matters:
//
//   offlineMutation → offlineQuery → httpBatchLink
//
// so a mutation is intercepted (and possibly queued) before the query link, and
// both sit in front of the real HTTP transport. `rawMutation` is the same
// transport WITHOUT the offline links — it is what the sync engine uses to
// replay the queue, so a replay can never be re-queued by itself.

import { createTRPCClient, httpBatchLink, type TRPCClient } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../../../../server/routers";
import { offlineMutationLink, offlineQueryLink } from "./links";
import { trpc } from "@/_core/trpc";

export function makeOfflineTrpcClient() {
  return trpc.createClient({
    links: [
      offlineMutationLink(),
      offlineQueryLink(),
      httpBatchLink({ url: "/trpc", transformer: superjson }),
    ],
  });
}

let raw: TRPCClient<AppRouter> | null = null;

/** The plain transport, with no offline interception. */
export function makeRawClient(): TRPCClient<AppRouter> {
  return createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: "/trpc", transformer: superjson })],
  });
}

function rawClient(): TRPCClient<AppRouter> {
  raw ??= makeRawClient();
  return raw;
}

/**
 * Call a mutation by its dotted path.
 *
 * The typed proxy is walked at runtime rather than statically because the sync
 * engine replays procedures it only knows by name.
 */
export function rawMutation(path: string, input: unknown): Promise<unknown> {
  const parts = path.split(".");
  let node: unknown = rawClient();
  for (let i = 0; i < parts.length - 1; i += 1) {
    node = (node as Record<string, unknown> | undefined)?.[parts[i]];
  }
  const proc = (node as Record<string, { mutate?: (i: unknown) => Promise<unknown> }> | undefined)?.[
    parts[parts.length - 1]
  ];
  if (!proc?.mutate) return Promise.reject(new Error(`Unknown procedure: ${path}`));
  return proc.mutate(input);
}
