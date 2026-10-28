// ── Cross-screen freshness ────────────────────────────────────────────────────
//
// Polling keeps each screen current on its own. This closes the other gap: when
// a driver's app finishes a queued write and pushes it to the server, the owner
// may be sitting on a completely different page that happens to show the same
// order. The offline provider cannot know which queries are on screen, so this
// provider does the one thing that is always safe — after a sync that actually
// sent something, mark every cached read stale so whatever is mounted refetches,
// and whatever is not refetches when it is next shown.
//
// It is mounted inside the React Query provider but outside the router, so it is
// active on every route and survives navigation.

import { useEffect, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useOfflineState } from "./offline/provider";

export function LiveDataProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { lastSyncAt } = useOfflineState();
  const seen = useRef<number | null>(null);

  useEffect(() => {
    if (!lastSyncAt) return;
    if (seen.current === lastSyncAt) return;
    const first = seen.current === null;
    seen.current = lastSyncAt;
    // The sync that runs at sign-in clears nothing that needs clearing; only a
    // later sync that carries real work is a reason to refetch the world.
    if (first) return;
    void qc.invalidateQueries();
  }, [lastSyncAt, qc]);

  return <>{children}</>;
}
