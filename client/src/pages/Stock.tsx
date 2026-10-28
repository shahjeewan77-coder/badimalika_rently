import { Link } from "wouter";
import { useMemo, useState } from "react";
import { Boxes, Plus, ArrowDownToLine, ArrowUpFromLine, ExternalLink } from "lucide-react";
import { trpc } from "@/_core/trpc";
import { AppLayout } from "@/components/AppLayout";
import { PageHeader, Table, THead, TBody, TR, TH, TD, Spinner, EmptyState, Badge, Modal, ErrorNote } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAccount } from "@/lib/useAccount";
import { bsDisplay, relativeTime } from "@/lib/format";
import { formatQty } from "@shared/rental";
import { DeleteRecordDialog, EditRecordDialog, OwnerRowActions } from "@/components/OwnerRecordActions";
import { LIVE_POLL_MS, pollWhileOnline } from "@/lib/live";

export default function Stock() {
  const { account } = useAccount();
  const isOwner = account?.role === "owner";
  const utils = trpc.useUtils();
  const equipment = trpc.equipment.list.useQuery(undefined, {
    refetchInterval: pollWhileOnline(LIVE_POLL_MS),
  });
  const movements = trpc.equipment.movements.useQuery({});
  const create = trpc.equipment.create.useMutation({ onSuccess: () => utils.equipment.list.invalidate() });

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", code: "", unit: "pcs", totalQty: "0" });
  const [error, setError] = useState<string | null>(null);

  // ── owner: edit / delete any piece of equipment ──
  const [editFor, setEditFor] = useState<{
    id: string;
    name: string;
    code: string | null;
    unit: string;
    totalQty: number;
  } | null>(null);
  const [deleteFor, setDeleteFor] = useState<{ id: string; name: string } | null>(null);

  const deletePreview = trpc.admin.equipmentDeletePreview.useQuery(
    { id: deleteFor?.id ?? "" },
    { enabled: isOwner && !!deleteFor },
  );
  const del = trpc.admin.deleteEquipment.useMutation({
    onSuccess: () => {
      utils.equipment.list.invalidate();
      utils.equipment.movements.invalidate();
      utils.orders.list.invalidate();
      utils.invoices.list.invalidate();
      utils.dashboard.summary.invalidate();
      utils.admin.auditLog.invalidate();
      setDeleteFor(null);
    },
  });
  const edit = trpc.admin.editEquipment.useMutation({
    onSuccess: () => {
      utils.equipment.list.invalidate();
      utils.admin.auditLog.invalidate();
      setEditFor(null);
    },
  });

  const rows = equipment.data ?? [];

  // Delivered-out / returned-in totals per item, rolled up from the movement
  // log the page already loads. `useMemo` so it is recomputed only when that
  // log changes, not on every poll tick.
  const totals = useMemo(() => {
    const map = new Map<string, { out: number; in: number }>();
    for (const m of movements.data ?? []) {
      const cur = map.get(m.equipmentId) ?? { out: 0, in: 0 };
      const qty = Number(m.qty) || 0;
      if (m.type === "in") cur.in += qty;
      else cur.out += qty;
      map.set(m.equipmentId, cur);
    }
    return map;
  }, [movements.data]);

  async function onAdd() {
    setError(null);
    if (!form.name) {
      setError("Name is required.");
      return;
    }
    try {
      await create.mutateAsync({
        name: form.name,
        code: form.code || undefined,
        unit: form.unit || undefined,
        totalQty: Number(form.totalQty) || 0,
      });
      setOpen(false);
      setForm({ name: "", code: "", unit: "pcs", totalQty: "0" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add equipment.");
    }
  }

  return (
    <AppLayout>
      <PageHeader
        title="Stock report"
        subtitle="Opening, delivered out, returned in, and closing stock for every item. Click a closing figure to see that item's full movement history."
        actions={
          isOwner && (
            <Button onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" /> Add equipment
            </Button>
          )
        }
      />

      {equipment.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Boxes className="h-5 w-5" />}
          title="No equipment yet"
          description="Add the equipment you rent out — mixers, scaffolding, pillars — with its total quantity."
          action={isOwner ? <Button onClick={() => setOpen(true)}>Add equipment</Button> : undefined}
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Equipment</TH>
              <TH className="text-right">Opening</TH>
              <TH className="text-right">Delivered out</TH>
              <TH className="text-right">Returned in</TH>
              <TH className="text-right">On rent</TH>
              <TH className="text-right">Closing stock</TH>
              {isOwner && <TH />}
            </TR>
          </THead>
          <TBody>
            {rows.map((e) => {
              const opening = Number(e.totalQty);
              const onRent = Number(e.onRentQty);
              const closing = opening - onRent;
              const t = totals.get(e.id) ?? { out: 0, in: 0 };
              return (
                <TR key={e.id}>
                  <TD>
                    <div className="font-medium">{e.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {e.code ? `${e.code} · ` : ""}
                      {e.unit}
                    </div>
                  </TD>
                  <TD className="text-right tabular-nums text-muted-foreground">{formatQty(opening)}</TD>
                  <TD className="text-right tabular-nums">
                    {t.out > 0 ? (
                      <span className="font-medium text-orange-600 dark:text-orange-400">{formatQty(t.out)}</span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TD>
                  <TD className="text-right tabular-nums">
                    {t.in > 0 ? (
                      <span className="font-medium text-emerald-700 dark:text-emerald-400">{formatQty(t.in)}</span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TD>
                  <TD className="text-right tabular-nums">
                    {onRent > 0 ? <Badge tone="accent">{formatQty(onRent)}</Badge> : "0"}
                  </TD>
                  <TD className="text-right">
                    {/* The closing figure IS the link to the movement report.
                        Only the owner gets a link; a driver sees a plain number
                        (the route is owner-guarded too, so this is cosmetic —
                        the server refuses either way). */}
                    {isOwner ? (
                      <Link
                        href={`/stock/${e.id}/movements`}
                        title={`Open the movement report for ${e.name}`}
                        className="group inline-flex items-center gap-1 rounded-md px-2 py-1 font-semibold tabular-nums text-primary underline-offset-4 hover:bg-primary/10 hover:underline"
                      >
                        {formatQty(closing)}
                        <ExternalLink className="h-3.5 w-3.5 opacity-60 group-hover:opacity-100" />
                      </Link>
                    ) : (
                      <span className="font-semibold tabular-nums">{formatQty(closing)}</span>
                    )}
                  </TD>
                  {isOwner && (
                    <TD className="text-right">
                      <OwnerRowActions
                        editLabel={`Edit ${e.name}`}
                        deleteLabel={`Delete ${e.name}`}
                        onEdit={() =>
                          setEditFor({
                            id: e.id,
                            name: e.name,
                            code: e.code ?? null,
                            unit: e.unit,
                            totalQty: Number(e.totalQty),
                          })
                        }
                        onDelete={() => setDeleteFor({ id: e.id, name: e.name })}
                      />
                    </TD>
                  )}
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent stock movements</CardTitle>
        </CardHeader>
        <CardContent>
          {(movements.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No movements yet — they are logged on dispatch (out) and pickup (in).</p>
          ) : (
            <div className="space-y-2">
              {(movements.data ?? []).slice(0, 12).map((m) => (
                <div key={m.id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    {m.type === "out" ? (
                      <ArrowUpFromLine className="h-4 w-4 text-orange-500" />
                    ) : (
                      <ArrowDownToLine className="h-4 w-4 text-emerald-500" />
                    )}
                    <span className="font-medium">{m.equipmentName}</span>
                    <Badge tone={m.type === "out" ? "accent" : "success"}>
                      {m.type === "out" ? "Out" : "In"} {formatQty(m.qty)}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {bsDisplay(m.dateAd)} · {relativeTime(m.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <DeleteRecordDialog
        open={!!deleteFor}
        onClose={() => setDeleteFor(null)}
        title={`Delete ${deleteFor?.name ?? "equipment"}?`}
        subtitle="The equipment, its stock history and every order line that used it go together — no order is left pointing at equipment that no longer exists."
        rows={
          deletePreview.data
            ? [
                { label: "Order lines using it", value: deletePreview.data.orderLines, tone: "danger" as const },
                { label: "Orders affected", value: deletePreview.data.affectedOrders, tone: "danger" as const },
                { label: "Stock movements", value: deletePreview.data.stockMovements, tone: "danger" as const },
                { label: "Currently on rent", value: deletePreview.data.onRentQty, tone: "muted" as const },
              ]
            : [{ label: "Calculating what will be removed", value: "…" }]
        }
        warning={
          deletePreview.data && deletePreview.data.affectedOrders > 0
            ? `Orders that lose their last line are deleted with it; the rest keep their other lines and have their invoice total recalculated, so no customer is billed for equipment that is gone.`
            : "Nothing else references this equipment."
        }
        busy={del.isPending}
        error={del.error instanceof Error ? del.error.message : null}
        onConfirm={() => deleteFor && del.mutate({ id: deleteFor.id })}
      />

      <EditRecordDialog
        open={!!editFor}
        onClose={() => setEditFor(null)}
        title={`Edit ${editFor?.name ?? "equipment"}`}
        fields={[
          { key: "name", label: "Name" },
          { key: "code", label: "Code" },
          { key: "unit", label: "Unit" },
          {
            key: "totalQty",
            label: "Total quantity",
            type: "number",
            step: "0.01",
            help: "Cannot be set below the quantity currently on rent.",
          },
        ]}
        initial={
          editFor
            ? {
                name: editFor.name,
                code: editFor.code ?? "",
                unit: editFor.unit,
                totalQty: String(editFor.totalQty),
              }
            : {}
        }
        busy={edit.isPending}
        error={edit.error instanceof Error ? edit.error.message : null}
        onSave={(v) =>
          editFor &&
          edit.mutate({
            id: editFor.id,
            name: v.name.trim(),
            code: v.code.trim() || null,
            unit: v.unit.trim() || "pcs",
            totalQty: v.totalQty === "" ? undefined : Number(v.totalQty),
          })
        }
      />

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add equipment"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
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
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Concrete Mixer" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Code</Label>
              <Input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} placeholder="EQ-…" />
            </div>
            <div className="space-y-1.5">
              <Label>Unit</Label>
              <Input value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} placeholder="pcs" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Total quantity</Label>
            <Input
              type="number"
              min="0"
              value={form.totalQty}
              onChange={(e) => setForm((f) => ({ ...f, totalQty: e.target.value }))}
            />
          </div>
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      </Modal>
    </AppLayout>
  );
}
