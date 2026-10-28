import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Plus, Trash2, UserPlus, ArrowLeft } from "lucide-react";
import { trpc } from "@/_core/trpc";
import { AppLayout } from "@/components/AppLayout";
import { PageHeader, Select, Textarea, Spinner, ErrorNote, Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BASIS_LABELS, BASIS_UNIT_LABELS, RENTAL_BASES, formatMoney, type RentalBasis } from "@shared/rental";
import { todayBs } from "@/lib/format";

interface Line {
  key: string;
  equipmentId: string;
  basis: RentalBasis;
  rate: string;
  actualQty: string;
  billedQty: string;
  units: string;
}

const newLine = (): Line => ({
  key: crypto.randomUUID(),
  equipmentId: "",
  basis: "day",
  rate: "",
  actualQty: "1",
  billedQty: "1",
  units: "1",
});

export default function NewOrder() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const today = todayBs();

  const customers = trpc.customers.list.useQuery();
  const equipment = trpc.equipment.list.useQuery();
  const createOrder = trpc.orders.create.useMutation({
    onSuccess: (order) => {
      utils.orders.list.invalidate();
      utils.dashboard.summary.invalidate();
      navigate(`/orders/${order.id}`);
    },
  });

  const [customerId, setCustomerId] = useState("");
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ name: "", phone: "", address: "" });
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [error, setError] = useState<string | null>(null);

  const createCustomer = trpc.customers.create.useMutation({
    onSuccess: (c) => {
      utils.customers.list.invalidate();
      setCustomerId(c.id);
      setAddingCustomer(false);
      setNewCustomer({ name: "", phone: "", address: "" });
    },
  });

  const totals = useMemo(() => {
    let amount = 0;
    let actual = 0;
    let billed = 0;
    for (const l of lines) {
      const rate = Number(l.rate) || 0;
      const units = Number(l.units) || 0;
      const bq = Number(l.billedQty) || 0;
      amount += rate * units * bq;
      actual += Number(l.actualQty) || 0;
      billed += bq;
    }
    return { amount, actual, billed };
  }, [lines]);

  function update(key: string, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function onSubmit() {
    setError(null);
    if (!customerId && !addingCustomer) {
      setError("Choose a customer, or add a new one.");
      return;
    }
    const valid = lines.filter((l) => l.equipmentId && Number(l.rate) >= 0);
    if (valid.length === 0) {
      setError("Add at least one item with a rate.");
      return;
    }
    try {
      await createOrder.mutateAsync({
        customerId: customerId || undefined,
        newCustomer: !customerId && addingCustomer ? { name: newCustomer.name, phone: newCustomer.phone || undefined, address: newCustomer.address || undefined } : undefined,
        notes: notes || undefined,
        items: valid.map((l) => ({
          equipmentId: l.equipmentId,
          basis: l.basis,
          rate: Number(l.rate) || 0,
          actualQty: Number(l.actualQty) || 0,
          billedQty: Number(l.billedQty) || 0,
          units: Number(l.units) || 0,
        })),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the order.");
    }
  }

  return (
    <AppLayout>
      <PageHeader
        title="New order"
        subtitle={`${today.long} · ${today.weekday}`}
        actions={
          <Button variant="outline" onClick={() => navigate("/orders")}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Customer</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!addingCustomer ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                    <option value="">Select a customer…</option>
                    {(customers.data ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.phone ? ` — ${c.phone}` : ""}
                      </option>
                    ))}
                  </Select>
                  <Button variant="outline" onClick={() => setAddingCustomer(true)} className="shrink-0">
                    <UserPlus className="h-4 w-4" /> New customer
                  </Button>
                </div>
              ) : (
                <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">Add a new customer</p>
                    <Button variant="ghost" size="sm" onClick={() => setAddingCustomer(false)}>
                      Cancel
                    </Button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Name *</Label>
                      <Input
                        value={newCustomer.name}
                        onChange={(e) => setNewCustomer((c) => ({ ...c, name: e.target.value }))}
                        placeholder="Customer name"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Phone</Label>
                      <Input
                        value={newCustomer.phone}
                        onChange={(e) => setNewCustomer((c) => ({ ...c, phone: e.target.value }))}
                        placeholder="98…"
                      />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label>Address</Label>
                      <Input
                        value={newCustomer.address}
                        onChange={(e) => setNewCustomer((c) => ({ ...c, address: e.target.value }))}
                        placeholder="City / site"
                      />
                    </div>
                  </div>
                  <Button
                    size="sm"
                    disabled={!newCustomer.name || createCustomer.isPending}
                    onClick={() => createCustomer.mutate({ name: newCustomer.name, phone: newCustomer.phone || undefined, address: newCustomer.address || undefined })}
                  >
                    {createCustomer.isPending ? "Saving…" : "Save customer"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Items</CardTitle>
              <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, newLine()])}>
                <Plus className="h-4 w-4" /> Add line
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              {equipment.isLoading ? (
                <Spinner />
              ) : (
                lines.map((l, idx) => {
                  const lineAmount = (Number(l.rate) || 0) * (Number(l.units) || 0) * (Number(l.billedQty) || 0);
                  return (
                    <div key={l.key} className="space-y-3 rounded-lg border p-3">
                      <div className="flex items-center justify-between">
                        <Badge tone="muted">Line {idx + 1}</Badge>
                        {lines.length > 1 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                            aria-label="Remove line"
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5 sm:col-span-2">
                          <Label>Equipment *</Label>
                          <Select value={l.equipmentId} onChange={(e) => update(l.key, { equipmentId: e.target.value })}>
                            <option value="">Select equipment…</option>
                            {(equipment.data ?? []).map((eq) => (
                              <option key={eq.id} value={eq.id}>
                                {eq.name}
                                {eq.code ? ` (${eq.code})` : ""} — {eq.unit}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label>Rental basis *</Label>
                          <Select value={l.basis} onChange={(e) => update(l.key, { basis: e.target.value as RentalBasis })}>
                            {RENTAL_BASES.map((b) => (
                              <option key={b} value={b}>
                                {BASIS_LABELS[b]}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label>Rate per {l.basis} (Rs) *</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={l.rate}
                            onChange={(e) => update(l.key, { rate: e.target.value })}
                            placeholder="0.00"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label>{BASIS_UNIT_LABELS[l.basis]} (count)</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={l.units}
                            onChange={(e) => update(l.key, { units: e.target.value })}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label>Actual Qty (delivered)</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={l.actualQty}
                            onChange={(e) => update(l.key, { actualQty: e.target.value })}
                          />
                          <p className="text-[11px] text-muted-foreground">Hits stock / inventory</p>
                        </div>
                        <div className="space-y-1.5">
                          <Label>Billed Qty</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={l.billedQty}
                            onChange={(e) => update(l.key, { billedQty: e.target.value })}
                          />
                          <p className="text-[11px] text-muted-foreground">Hits the invoice amount</p>
                        </div>
                      </div>
                      <div className="flex items-center justify-between border-t pt-2 text-sm">
                        <span className="text-muted-foreground">
                          {formatMoney(Number(l.rate) || 0)} × {l.units || 0} {BASIS_UNIT_LABELS[l.basis].toLowerCase()} × {l.billedQty || 0} billed
                        </span>
                        <span className="font-semibold tabular-nums">{formatMoney(lineAmount)}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Notes</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Site details, delivery instructions…" />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Lines</span>
                <span className="font-medium">{lines.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Actual qty (stock)</span>
                <span className="font-medium tabular-nums">{totals.actual}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Billed qty (invoice)</span>
                <span className="font-medium tabular-nums">{totals.billed}</span>
              </div>
              <div className="flex justify-between border-t pt-3 text-base">
                <span className="font-semibold">Order amount</span>
                <span className="font-bold tabular-nums">{formatMoney(totals.amount)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                The order goes to the owner for approval. Amount due is only shown in the owner app.
              </p>
              {error && <ErrorNote>{error}</ErrorNote>}
              <Button className="w-full" onClick={onSubmit} disabled={createOrder.isPending}>
                {createOrder.isPending ? "Submitting…" : "Submit for approval"}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
