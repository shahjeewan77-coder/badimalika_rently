import { Redirect } from "wouter";
import { useAuth } from "@/_core/useAuth";
import { useAccount } from "@/lib/useAccount";
import { Spinner } from "@/components/ui/primitives";
import Dashboard from "./Dashboard";
import DriverHome from "./DriverHome";

// Role-aware home: Owner → dashboard; Driver → today's assignment + actions.
export default function Home() {
  const { user, isLoading } = useAuth();
  const { account, isLoading: acctLoading } = useAccount();

  if (isLoading) return <Spinner />;
  if (!user) return <Redirect to="/login" />;
  if (acctLoading || !account) return <Spinner />;

  return account.role === "driver" ? <DriverHome /> : <Dashboard />;
}
