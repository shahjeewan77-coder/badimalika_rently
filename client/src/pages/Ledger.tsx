import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { BookOpen, Search, Plus } from "lucide-react";
import { trpc } from "@/_core/trpc";
import { AppLayout } from "@/components/AppLayout";
import {
  PageHeader,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Spinner,
  EmptyState,
  Modal,
  ErrorNote,
} from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { formatMoney } from "@shared/rental";

/**
 * Customer Ledger index — every customer with their current due balance. Clicking
 * a row opens that customer's full statement (opening balance, every invoice as a
 * debit, every receipt as a credit, running/closing due).
 *
 * Owner-only: the route guard and the ledger API both refuse a driver, so a driver
 * never sees a due balance or a receipt here.
 */
export default function Ledger() {
  const [, navigate] = useLocation();
  const customers = trpc.customers.list.useQuery();
  const [query, setQuery] = useState("");
  const [openAdd, setOpenAdd] = useState(false);

  const rows = customers.data ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((c) => c.name.toLowerCase().includes(q) || (c.phone ?? "").includes(q));
  }, [rows, query]);

  const totalDue = useMemo(() => rows.reduce((s, c) => s + (c.due ?? 0), 0), [rows]);

  return (
    <AppLayout>
      <PageHeader
        title="Customer Ledger"
        subtitle="Due balance per customer. Open a customer to see every invoice, every receipt and the running balance."
        actions={
          <>
            <Button variant="outline" onClick={() => navigate("/customers")}>
              Customers
            </Button>
            <Button onClick={() => setOpenAdd(true)}>
              <Plus className="h-4 w-4" /> Add customer
            </Button>
          </>
        }
      />

      <Card>
        <CardContent className="pt-6">
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search customers…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {customers.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="h-5 w-5" />}
          title="No customers yet"
          description="Add the businesses and people you rent to. Once an order is dispatched, its sales invoice appears on the customer's ledger automatically."
          action={<Button onClick={() => setOpenAdd(true)}>Add customer</Button>}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="h-5 w-5" />}
          title="No matches"
          description="No customer matches that search."
          action={
            <Button variant="outline" onClick={() => setQuery("")}>
              Clear search
            </Button>
          }
        />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Customer</TH>
                <TH>Phone</TH>
                <TH className="text-right">Opening</TH>
                <TH className="text-right">Due balance</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {filtered.map((c) => (
                <TR key={c.id} className="cursor-pointer" onClick={() => navigate(`/customers/${c.id}/ledger`)}>
                  <TD className="font-medium">{c.name}</TD>
                  <TD className="text-muted-foreground">{c.phone ?? "—"}</TD>
                  <TD className="text-right tabular-nums text-muted-foreground">{formatMoney(c.openingBalance ?? 0)}</TD>
                  <TD
                    className={
                      (c.due ?? 0) > 0
                        ? "text-right font-semibold tabular-nums text-destructive"
                        : "text-right font-semibold tabular-nums text-emerald-600 dark:text-emerald-400"
                    }
                  >
                    {formatMoney(c.due ?? 0)}
                  </TD>
                  <TD className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => navigate(`/customers/${c.id}/ledger`)}>
                      Open ledger
                    </Button>
                  </TD>
                </TR>
              ))}
              <TR className="bg-muted/40">
                <TD className="font-semibold">Total</TD>
                <TD />
                <TD />
                <TD className="text-right font-bold tabular-nums">{formatMoney(totalDue)}</TD>
                <TD />
              </TR>
            </TBody>
          </Table>
        </>
      )}

      <AddCustomerModal open={openAdd} onClose={() => setOpenAdd(false)} />
    </AppLayout>
  );
}

function AddCustomerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState({ name: "", phone: "", address: "", openingBalance: "" });
  const [error, setError] = useState<string | null>(null);

  const create = trpc.customers.create.useMutation({
    onSuccess: () => {
      utils.customers.list.invalidate();
      utils.dashboard.summary.invalidate();
    },
  });

  async function onAdd() {
    setError(null);
    if (!form.name.trim()) {
      setError("Name is required.");
      return;
    }
    try {
      await create.mutateAsync({
        name: form.name.trim(),
        phone: form.phone || undefined,
        address: form.address || undefined,
        openingBalance: form.openingBalance ? Number(form.openingBalance) : undefined,
      });
      setForm({ name: "", phone: "", address: "", openingBalance: "" });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the customer.");
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add customer"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onAdd} disabled={create.isPending}>
            {create.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label>Name *</Label>
          <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Phone</Label>
            <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Address</Label>
            <Input value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Opening balance (Rs)</Label>
          <Input
            type="number"
            step="0.01"
            value={form.openingBalance}
            onChange={(e) => setForm((f) => ({ ...f, openingBalance: e.target.value }))}
            placeholder="0.00"
          />
          <p className="text-xs text-muted-foreground">Due this customer already owed before you started using the app.</p>
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Modal>
  );
}
