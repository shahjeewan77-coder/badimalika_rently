import { useState } from "react";
import { useLocation } from "wouter";
import { Users, Plus, BookOpen, MapPin } from "lucide-react";
import { trpc } from "@/_core/trpc";
import { AppLayout } from "@/components/AppLayout";
import { PageHeader, Table, THead, TBody, TR, TH, TD, Spinner, EmptyState, Modal, ErrorNote } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAccount } from "@/lib/useAccount";
import { formatMoney } from "@shared/rental";
import { DeleteRecordDialog, EditRecordDialog, OwnerRowActions } from "@/components/OwnerRecordActions";
import { LIVE_POLL_MS, pollWhileOnline } from "@/lib/live";

export default function Customers() {
  const utils = trpc.useUtils();
  const customers = trpc.customers.list.useQuery(undefined, {
    refetchInterval: pollWhileOnline(LIVE_POLL_MS),
  });
  const create = trpc.customers.create.useMutation({
    onSuccess: () => {
      utils.customers.list.invalidate();
      utils.dashboard.summary.invalidate();
    },
  });
  const [, navigate] = useLocation();
  const { account } = useAccount();
  const isOwner = account?.role === "owner";

  // ── owner: edit / delete any customer ──
  const [editFor, setEditFor] = useState<{
    id: string;
    name: string;
    phone: string | null;
    address: string | null;
    openingBalance: number;
  } | null>(null);
  const [deleteFor, setDeleteFor] = useState<{ id: string; name: string } | null>(null);

  const deletePreview = trpc.admin.customerDeletePreview.useQuery(
    { id: deleteFor?.id ?? "" },
    { enabled: isOwner && !!deleteFor },
  );
  const del = trpc.admin.deleteCustomer.useMutation({
    onSuccess: () => {
      utils.customers.list.invalidate();
      utils.dashboard.summary.invalidate();
      utils.orders.list.invalidate();
      utils.invoices.list.invalidate();
      utils.rentals.onRent.invalidate();
      utils.equipment.list.invalidate();
      utils.admin.auditLog.invalidate();
      setDeleteFor(null);
    },
  });
  const edit = trpc.admin.editCustomer.useMutation({
    onSuccess: () => {
      utils.customers.list.invalidate();
      utils.dashboard.summary.invalidate();
      utils.admin.auditLog.invalidate();
      setEditFor(null);
    },
  });

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", address: "", openingBalance: "" });
  const [error, setError] = useState<string | null>(null);

  // Delivery-site coordinates, so the owner's live map can plot where an active
  // trip is heading. Owner only.
  const [locFor, setLocFor] = useState<{ id: string; name: string } | null>(null);
  const [loc, setLoc] = useState({ latitude: "", longitude: "" });
  const [locError, setLocError] = useState<string | null>(null);
  const setLocation = trpc.tracking.setCustomerLocation.useMutation({
    onSuccess: () => {
      utils.customers.list.invalidate();
      utils.tracking.live.invalidate();
      setLocFor(null);
    },
  });

  function openLocation(c: { id: string; name: string; latitude?: number | null; longitude?: number | null }) {
    setLocFor({ id: c.id, name: c.name });
    setLoc({ latitude: c.latitude != null ? String(c.latitude) : "", longitude: c.longitude != null ? String(c.longitude) : "" });
    setLocError(null);
  }

  async function onSaveLocation() {
    if (!locFor) return;
    setLocError(null);
    const lat = loc.latitude.trim() === "" ? null : Number(loc.latitude);
    const lng = loc.longitude.trim() === "" ? null : Number(loc.longitude);
    if ((lat == null) !== (lng == null)) {
      setLocError("Enter both latitude and longitude, or clear both.");
      return;
    }
    if (lat != null && (Number.isNaN(lat) || lat < -90 || lat > 90)) {
      setLocError("Latitude must be between -90 and 90.");
      return;
    }
    if (lng != null && (Number.isNaN(lng) || lng < -180 || lng > 180)) {
      setLocError("Longitude must be between -180 and 180.");
      return;
    }
    try {
      await setLocation.mutateAsync({ customerId: locFor.id, latitude: lat, longitude: lng });
    } catch (e) {
      setLocError(e instanceof Error ? e.message : "Could not save the location.");
    }
  }

  const rows = customers.data ?? [];

  async function onAdd() {
    setError(null);
    if (!form.name) {
      setError("Name is required.");
      return;
    }
    try {
      await create.mutateAsync({
        name: form.name,
        phone: form.phone || undefined,
        address: form.address || undefined,
        openingBalance: isOwner && form.openingBalance ? Number(form.openingBalance) : undefined,
      });
      setOpen(false);
      setForm({ name: "", phone: "", address: "", openingBalance: "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the customer.");
    }
  }

  return (
    <AppLayout>
      <PageHeader
        title="Customers"
        subtitle="Add customers here, or inline while creating an order."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> Add customer
          </Button>
        }
      />

      {customers.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Users className="h-5 w-5" />}
          title="No customers yet"
          description="Add the businesses and people you rent to. You can also create one on the fly from the New order screen."
          action={<Button onClick={() => setOpen(true)}>Add customer</Button>}
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Phone</TH>
              <TH>Address</TH>
              {isOwner && <TH className="text-right">Due balance</TH>}
              {isOwner && <TH />}
            </TR>
          </THead>
          <TBody>
            {rows.map((c) => (
              <TR key={c.id}>
                <TD className="font-medium">{c.name}</TD>
                <TD className="text-muted-foreground">{c.phone ?? "—"}</TD>
                <TD className="text-muted-foreground">{c.address ?? "—"}</TD>
                {isOwner && (
                  <TD
                    className={
                      (c.due ?? 0) > 0
                        ? "text-right font-semibold tabular-nums text-destructive"
                        : "text-right font-semibold tabular-nums text-emerald-600 dark:text-emerald-400"
                    }
                  >
                    {formatMoney(c.due ?? 0)}
                  </TD>
                )}
                {isOwner && (
                  <TD className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openLocation(c)}>
                        <MapPin className="h-4 w-4" /> {c.latitude != null ? "Site set" : "Set site"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => navigate(`/customers/${c.id}/ledger`)}>
                        <BookOpen className="h-4 w-4" /> Ledger
                      </Button>
                      <OwnerRowActions
                        editLabel={`Edit ${c.name}`}
                        deleteLabel={`Delete ${c.name}`}
                        onEdit={() =>
                          setEditFor({
                            id: c.id,
                            name: c.name,
                            phone: c.phone ?? null,
                            address: c.address ?? null,
                            openingBalance: c.openingBalance ?? 0,
                          })
                        }
                        onDelete={() => setDeleteFor({ id: c.id, name: c.name })}
                      />
                    </div>
                  </TD>
                )}
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <DeleteRecordDialog
        open={!!deleteFor}
        onClose={() => setDeleteFor(null)}
        title={`Delete ${deleteFor?.name ?? "customer"}?`}
        subtitle="The customer and their entire history go together — nothing is left pointing at a record that no longer exists."
        rows={
          deletePreview.data
            ? [
                { label: "Orders", value: deletePreview.data.orders, tone: "danger" as const },
                { label: "of which still open (holding stock)", value: deletePreview.data.openOrders, tone: "muted" as const },
                { label: "Sales invoices", value: deletePreview.data.invoices, tone: "danger" as const },
                { label: "Receipts", value: deletePreview.data.receipts, tone: "danger" as const },
              ]
            : [{ label: "Calculating what will be removed", value: "…" }]
        }
        warning={
          deletePreview.data && deletePreview.data.openOrders > 0
            ? `This customer has ${deletePreview.data.openOrders} order(s) currently out. Equipment they hold is returned to available stock so nothing stays stuck on rent.`
            : "Their due balance is removed with them. This cannot be undone."
        }
        busy={del.isPending}
        error={del.error instanceof Error ? del.error.message : null}
        onConfirm={() => deleteFor && del.mutate({ id: deleteFor.id })}
      />

      <EditRecordDialog
        open={!!editFor}
        onClose={() => setEditFor(null)}
        title={`Edit ${editFor?.name ?? "customer"}`}
        fields={[
          { key: "name", label: "Name" },
          { key: "phone", label: "Phone" },
          { key: "address", label: "Address" },
          {
            key: "openingBalance",
            label: "Opening balance",
            type: "number",
            step: "0.01",
            help: "The due balance is opening + invoices − receipts, so changing this moves the ledger.",
          },
        ]}
        initial={
          editFor
            ? {
                name: editFor.name,
                phone: editFor.phone ?? "",
                address: editFor.address ?? "",
                openingBalance: String(editFor.openingBalance),
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
            phone: v.phone.trim() || null,
            address: v.address.trim() || null,
            openingBalance: v.openingBalance === "" ? undefined : Number(v.openingBalance),
          })
        }
      />

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add customer"
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
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Phone</Label>
            <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Address</Label>
            <Input value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
          </div>
          {isOwner && (
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
          )}
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      </Modal>

      <Modal
        open={!!locFor}
        onClose={() => setLocFor(null)}
        title={`Delivery site — ${locFor?.name ?? ""}`}
        footer={
          <>
            <Button variant="outline" onClick={() => setLocFor(null)}>
              Cancel
            </Button>
            <Button onClick={onSaveLocation} disabled={setLocation.isPending}>
              {setLocation.isPending ? "Saving…" : "Save location"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            The coordinates of this customer's delivery site, so it appears on the live tracking map. Leave both blank to remove it.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Latitude</Label>
              <Input
                type="number"
                step="any"
                value={loc.latitude}
                onChange={(e) => setLoc((l) => ({ ...l, latitude: e.target.value }))}
                placeholder="27.7172"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Longitude</Label>
              <Input
                type="number"
                step="any"
                value={loc.longitude}
                onChange={(e) => setLoc((l) => ({ ...l, longitude: e.target.value }))}
                placeholder="85.3240"
              />
            </div>
          </div>
          {locError && <ErrorNote>{locError}</ErrorNote>}
        </div>
      </Modal>
    </AppLayout>
  );
}
