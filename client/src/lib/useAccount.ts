import { trpc } from "@/_core/trpc";

export interface AccountInfo {
  userId: string;
  email: string;
  name: string | null;
  role: "owner" | "driver";
  displayName: string | null;
  phone: string | null;
  accountId: string;
  driverId: string | null;
  driverName: string | null;
}

/** The signed-in user's business profile (role, account, linked driver). */
export function useAccount() {
  const q = trpc.account.me.useQuery(undefined, { staleTime: 30_000 });
  return { account: (q.data as AccountInfo | undefined) ?? null, isLoading: q.isLoading, refetch: q.refetch };
}
