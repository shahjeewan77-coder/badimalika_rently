import { useState } from "react";
import { Truck, Plus, UserCog, CalendarClock, RotateCcw } from "lucide-react";
import { trpc } from "@/_core/trpc";
import { AppLayout } from "@/components/AppLayout";
import { PageHeader, Table, THead, TBody, TR, TH, TD, Spinner, Modal, ErrorNote, Badge, Select } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { bsDisplay, todayBs } from "@/lib/format";
import { DeleteRecordDialog, EditRecordDialog, OwnerRowActions } from "@/components/OwnerRecordActions";
import { LIVE_POLL_MS, pollWhileOnline } from "@/lib/live";

/**
 * Fleet & team.
 *
 * Every row here is fully editable and removable by the owner, and both actions
 * are the same shape for a truck and for a driver:
 *
 *   * edit  — a modal with every field, validated on the server (no duplicate
 *             plate, no duplicate phone, required fields enforced);
 *   * remove — a dialog that states, in real counts, what still refers to the
 *             record. Nothing with history is deleted: it is retired, so orders,
 *             stock movements, trip routes and the audit trail keep naming it and
 *             no report is left pointing at a row that vanished.
 *
 * A truck on an active trip, or a driver holding a locked order, is refused with
 * a message that says what to resolve first.
 */
export default function Vehicles() {
  const utils = trpc.useUtils();
  const vehicles = trpc.vehicles.list.useQuery(undefined, {
    refetchInterval: pollWhileOnline(LIVE_POLL_MS),
  });
  const drivers = trpc.drivers.list.useQuery(undefined, {
    refetchInterval: pollWhileOnline(LIVE_POLL_MS),
  });
  // Only trucks in service may be picked for today's assignment.
  const activeVehicles = trpc.vehicles.active.useQuery(undefined, {
    refetchInterval: pollWhileOnline(LIVE_POLL_MS),
  });
  const todayAssignments = trpc.assignments.forDate.useQuery({}, {
    refetchInterval: pollWhileOnline(LIVE_POLL_MS),
  });
  const recent = trpc.assignments.recent.useQuery();

  const [vOpen, setVOpen] = useState(false);
  const [dOpen, setDOpen] = useState(false);

  /**
   * Refresh everything that shows a vehicle or a driver.
   *
   * A plate and a driver name are printed on orders, the live map, stock
   * movements and the dashboard, so an edit that only invalidated its own list
   * would leave the change invisible exactly where it matters.
   */
  function refreshFleet() {
    void utils.vehicles.list.invalidate();
    void utils.vehicles.active.invalidate();
    void utils.drivers.list.invalidate();
    void utils.drivers.active.invalidate();
    void utils.users.list.invalidate();
    void utils.assignments.forDate.invalidate();
    void utils.assignments.recent.invalidate();
    void utils.assignments.mine.invalidate();
    void utils.orders.list.invalidate();
    void utils.dashboard.summary.invalidate();
    void utils.rentals.onRent.invalidate();
    void utils.tracking.live.invalidate();
    void utils.tracking.history.invalidate();
    void utils.admin.auditLog.invalidate();
  }

  const createVehicle = trpc.vehicles.create.useMutation({ onSuccess: refreshFleet });
  const editVehicle = trpc.vehicles.update.useMutation({ onSuccess: refreshFleet });
  const removeVehicle = trpc.vehicles.remove.useMutation({ onSuccess: refreshFleet });
  const restoreVehicle = trpc.vehicles.restore.useMutation({ onSuccess: refreshFleet });

  const createDriver = trpc.drivers.create.useMutation({ onSuccess: refreshFleet });
  const editDriver = trpc.drivers.update.useMutation({ onSuccess: refreshFleet });
  const removeDriver = trpc.drivers.remove.useMutation({ onSuccess: refreshFleet });
  const restoreDriver = trpc.drivers.restore.useMutation({ onSuccess: refreshFleet });

  // ── vehicle edit / remove ──
  const [vehicleEditFor, setVehicleEditFor] = useState<{
    id: string;
    name: string;
    number: string;
    type: string | null;
  } | null>(null);
  const [vehicleDeleteFor, setVehicleDeleteFor] = useState<{ id: string; name: string } | null>(null);
  const vehiclePreview = trpc.vehicles.deletePreview.useQuery(
    { id: vehicleDeleteFor?.id ?? "" },
    { enabled: !!vehicleDeleteFor },
  );

  // ── driver edit / remove ──
  const [driverEditFor, setDriverEditFor] = useState<{
    id: string;
    name: string;
    phone: string | null;
    licenseNo: string | null;
    /** Today's vehicle, so the owner can set it from the same dialog. */
    currentVehicleId: string;
  } | null>(null);
  const [driverDeleteFor, setDriverDeleteFor] = useState<{ id: string; name: string } | null>(null);
  const driverPreview = trpc.drivers.deletePreview.useQuery(
    { id: driverDeleteFor?.id ?? "" },
    { enabled: !!driverDeleteFor },
  );

  const [vForm, setVForm] = useState({ name: "", number: "", type: "" });
  const [dForm, setDForm] = useState({ name: "", phone: "", licenseNo: "" });
  const [error, setError] = useState<string | null>(null);

  const today = todayBs();

  /** Today's vehicle for a driver, read from the assignment table itself. */
  function todaysVehicleId(driverId: string): string {
    const a = (todayAssignments.data ?? []).find((x) => x.driverId === driverId);
    return a?.vehicleId ?? "";
  }

  async function addVehicle() {
    setError(null);
    if (!vForm.name.trim() || !vForm.number.trim()) {
      setError("Name and number are required.");
      return;
    }
    try {
      await createVehicle.mutateAsync({
        name: vForm.name.trim(),
        number: vForm.number.trim(),
        type: vForm.type.trim() || undefined,
      });
      setVOpen(false);
      setVForm({ name: "", number: "", type: "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the vehicle.");
    }
  }

  async function addDriver() {
    setError(null);
    if (!dForm.name.trim()) {
      setError("Name is required.");
      return;
    }
    try {
      await createDriver.mutateAsync({
        name: dForm.name.trim(),
        phone: dForm.phone.trim() || undefined,
        licenseNo: dForm.licenseNo.trim() || undefined,
      });
      setDOpen(false);
      setDForm({ name: "", phone: "", licenseNo: "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the driver.");
    }
  }

  return (
    <AppLayout>
      <PageHeader
        title="Vehicles & Drivers"
        subtitle={`Fleet and team. Every row is editable and removable. Today's assignments — ${today.long}.`}
        actions={
          <>
            <Button variant="outline" onClick={() => setDOpen(true)}>
              <UserCog className="h-4 w-4" /> Add driver
            </Button>
            <Button onClick={() => setVOpen(true)}>
              <Plus className="h-4 w-4" /> Add vehicle
            </Button>
          </>
        }
      />

      {/* Two tables of six columns each get clipped inside a half-width card —
          the action buttons fell off the right edge. Full width, side by side on
          wide screens, is what makes every row's edit/remove reachable. */}
      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Truck className="h-4 w-4 text-primary" /> Vehicles ({(vehicles.data ?? []).length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {vehicles.isLoading ? (
              <Spinner />
            ) : (vehicles.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No vehicles yet.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Number</TH>
                    <TH>Type</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {(vehicles.data ?? []).map((v) => {
                    const retired = v.isActive === false;
                    return (
                      <TR key={v.id} className={retired ? "opacity-60" : undefined}>
                        <TD className="font-medium">{v.name}</TD>
                        <TD className="text-muted-foreground">{v.number}</TD>
                        <TD className="text-muted-foreground">{v.type ?? "—"}</TD>
                        <TD>
                          {retired ? (
                            <Badge tone="muted">Retired</Badge>
                          ) : (
                            <Badge tone="success">In service</Badge>
                          )}
                        </TD>
                        <TD className="whitespace-nowrap text-right">
                          {retired ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={restoreVehicle.isPending}
                              onClick={() => restoreVehicle.mutate({ id: v.id })}
                            >
                              <RotateCcw className="h-3.5 w-3.5" /> Put back in service
                            </Button>
                          ) : (
                            <OwnerRowActions
                              editLabel={`Edit ${v.name}`}
                              deleteLabel={`Remove ${v.name}`}
                              onEdit={() => {
                                // Clear any error left by a previous attempt, so a
                                // fresh dialog never opens showing a stale refusal.
                                editVehicle.reset();
                                setVehicleEditFor({
                                  id: v.id,
                                  name: v.name,
                                  number: v.number,
                                  type: v.type,
                                });
                              }}
                              onDelete={() => {
                                removeVehicle.reset();
                                setVehicleDeleteFor({ id: v.id, name: v.name });
                              }}
                            />
                          )}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UserCog className="h-4 w-4 text-primary" /> Drivers ({(drivers.data ?? []).length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {drivers.isLoading ? (
              <Spinner />
            ) : (drivers.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No drivers yet.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Phone</TH>
                    <TH>Vehicle today</TH>
                    <TH>Login</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {(drivers.data ?? []).map((d) => {
                    const inactive = d.isActive === false;
                    const assigned = (todayAssignments.data ?? []).find((a) => a.driverId === d.id);
                    return (
                      <TR key={d.id} className={inactive ? "opacity-60" : undefined}>
                        <TD className="whitespace-nowrap font-medium">{d.name}</TD>
                        <TD className="whitespace-nowrap text-muted-foreground">{d.phone ?? "—"}</TD>
                        <TD className="whitespace-nowrap text-muted-foreground">
                          {assigned ? (
                            <>
                              {assigned.vehicleName}{" "}
                              <span className="text-xs">({assigned.vehicleNumber})</span>
                            </>
                          ) : (
                            "—"
                          )}
                        </TD>
                        <TD className="whitespace-nowrap">
                          {d.userId ? <Badge tone="success">Linked</Badge> : <Badge tone="muted">No login</Badge>}
                        </TD>
                        <TD className="whitespace-nowrap">
                          {inactive ? <Badge tone="muted">Removed</Badge> : <Badge tone="success">On roster</Badge>}
                        </TD>
                        <TD className="whitespace-nowrap text-right">
                          {inactive ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={restoreDriver.isPending}
                              onClick={() => restoreDriver.mutate({ id: d.id })}
                            >
                              <RotateCcw className="h-3.5 w-3.5" /> Put back on roster
                            </Button>
                          ) : (
                            <OwnerRowActions
                              editLabel={`Edit ${d.name}`}
                              deleteLabel={`Remove ${d.name} from the roster`}
                              onEdit={() => {
                                editDriver.reset();
                                setDriverEditFor({
                                  id: d.id,
                                  name: d.name,
                                  phone: d.phone,
                                  licenseNo: d.licenseNo,
                                  currentVehicleId: todaysVehicleId(d.id),
                                });
                              }}
                              onDelete={() => {
                                removeDriver.reset();
                                setDriverDeleteFor({ id: d.id, name: d.name });
                              }}
                            />
                          )}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4 text-primary" /> Today's assignments
          </CardTitle>
        </CardHeader>
        <CardContent>
          {(todayAssignments.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No driver has picked a vehicle yet today. Drivers self-assign from their home screen, or set it from the
              driver's edit dialog here.
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Driver</TH>
                  <TH>Vehicle</TH>
                  <TH>Date (BS)</TH>
                </TR>
              </THead>
              <TBody>
                {(todayAssignments.data ?? []).map((a) => (
                  <TR key={a.id}>
                    <TD className="font-medium">{a.driverName ?? "—"}</TD>
                    <TD>
                      {a.vehicleName} <span className="text-muted-foreground">({a.vehicleNumber})</span>
                    </TD>
                    <TD className="text-muted-foreground">{bsDisplay(a.dateAd)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent assignment history</CardTitle>
        </CardHeader>
        <CardContent>
          {(recent.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No assignments recorded yet.</p>
          ) : (
            <div className="space-y-2">
              {(recent.data ?? []).slice(0, 10).map((a) => (
                <div key={a.id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                  <span className="font-medium">{a.driverName}</span>
                  <span className="text-muted-foreground">
                    {a.vehicleName} ({a.vehicleNumber})
                  </span>
                  <span className="text-xs text-muted-foreground">{bsDisplay(a.dateAd)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── vehicle: edit every field ─────────────────────────────────────── */}
      <EditRecordDialog
        open={!!vehicleEditFor}
        onClose={() => setVehicleEditFor(null)}
        title={`Edit ${vehicleEditFor?.name ?? "vehicle"}`}
        fields={[
          { key: "name", label: "Vehicle name", help: "Shown on orders, assignments and the live map." },
          { key: "number", label: "Number plate", help: "Must be unique in your fleet." },
          { key: "type", label: "Type / model", help: "Truck, Tipper, Pickup, Crane…" },
        ]}
        initial={{
          name: vehicleEditFor?.name ?? "",
          number: vehicleEditFor?.number ?? "",
          type: vehicleEditFor?.type ?? "",
        }}
        busy={editVehicle.isPending}
        error={editVehicle.error instanceof Error ? editVehicle.error.message : null}
        onSave={async (v) => {
          if (!vehicleEditFor) return;
          if (!v.name.trim() || !v.number.trim()) return;
          try {
            await editVehicle.mutateAsync({
              id: vehicleEditFor.id,
              name: v.name.trim(),
              number: v.number.trim(),
              type: v.type.trim() || null,
            });
            setVehicleEditFor(null);
          } catch {
            // The message is rendered from `editVehicle.error` inside the dialog.
          }
        }}
      />

      {/* ── vehicle: remove, with the real consequences counted ──────────── */}
      <DeleteRecordDialog
        open={!!vehicleDeleteFor}
        onClose={() => setVehicleDeleteFor(null)}
        title={
          vehiclePreview.data?.canHardDelete
            ? `Delete ${vehicleDeleteFor?.name ?? "vehicle"}?`
            : vehiclePreview.data?.alreadyRetired
              ? `${vehicleDeleteFor?.name ?? "This vehicle"} is already retired`
              : `Remove ${vehicleDeleteFor?.name ?? "vehicle"} from the fleet?`
        }
        subtitle={
          vehiclePreview.data?.canHardDelete
            ? "Nothing has ever used this vehicle, so the record is deleted outright."
            : "The truck leaves your fleet; the history that names it does not go with it. Orders, stock movements, routes and the audit trail keep reading correctly."
        }
        confirmLabel={
          vehiclePreview.data?.canHardDelete ? "Delete permanently" : "Remove from fleet"
        }
        impactHeading={
          vehiclePreview.data?.canHardDelete ? "Nothing refers to it" : "What still names this vehicle"
        }
        rows={
          vehiclePreview.data
            ? [
                {
                  label: "Orders that name it (kept)",
                  value: vehiclePreview.data.ordersAssigned,
                  tone: "muted" as const,
                },
                {
                  label: "Daily assignments that name it (kept)",
                  value: vehiclePreview.data.assignments,
                  tone: "muted" as const,
                },
                {
                  label: "Audit entries about it (kept)",
                  value: vehiclePreview.data.auditEntries,
                  tone: "muted" as const,
                },
              ]
            : [{ label: "Calculating what this affects", value: "…" }]
        }
        warning={
          vehiclePreview.data?.onActiveTrip
            ? "This vehicle is on an active trip right now. Mark the trip returned (or undo the lock) before removing it — it is the vehicle the live map is labelling."
            : vehiclePreview.data?.canHardDelete
              ? null
              : "Nothing is deleted, so no report breaks: the vehicle simply stops being offered for new orders. You can put it back in service at any time."
        }
        footnote={
          vehiclePreview.data?.canHardDelete
            ? "This cannot be undone. The deletion is recorded in the audit trail."
            : "Reversible: put it back in service from this same table. The change is recorded in the audit trail."
        }
        busy={removeVehicle.isPending}
        error={removeVehicle.error instanceof Error ? removeVehicle.error.message : null}
        onConfirm={async () => {
          if (!vehicleDeleteFor) return;
          try {
            await removeVehicle.mutateAsync({ id: vehicleDeleteFor.id });
            setVehicleDeleteFor(null);
          } catch {
            // Rendered from the mutation's own error.
          }
        }}
      />

      {/* ── driver: edit every field, including today's vehicle ──────────── */}
      <Modal
        open={!!driverEditFor}
        onClose={() => setDriverEditFor(null)}
        title={`Edit ${driverEditFor?.name ?? "driver"}`}
        footer={
          <>
            <Button variant="outline" onClick={() => setDriverEditFor(null)} disabled={editDriver.isPending}>
              Cancel
            </Button>
            <Button
              disabled={editDriver.isPending || !driverEditFor}
              onClick={async () => {
                if (!driverEditFor) return;
                if (!driverEditFor.name.trim()) return;
                try {
                  await editDriver.mutateAsync({
                    id: driverEditFor.id,
                    name: driverEditFor.name.trim(),
                    phone: driverEditFor.phone?.trim() || null,
                    licenseNo: driverEditFor.licenseNo?.trim() || null,
                    vehicleId: driverEditFor.currentVehicleId || null,
                  });
                  setDriverEditFor(null);
                } catch {
                  // Rendered below from the mutation error.
                }
              }}
            >
              {editDriver.isPending ? "Saving…" : "Save changes"}
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="d-name">Driver name *</Label>
            <Input
              id="d-name"
              value={driverEditFor?.name ?? ""}
              onChange={(e) =>
                setDriverEditFor((d) => (d ? { ...d, name: e.target.value } : d))
              }
              placeholder="Kabiraj"
            />
            <p className="text-xs text-muted-foreground">
              Shown on orders, the live map and route history. Also updates their login name.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="d-phone">Phone</Label>
              <Input
                id="d-phone"
                value={driverEditFor?.phone ?? ""}
                onChange={(e) =>
                  setDriverEditFor((d) => (d ? { ...d, phone: e.target.value } : d))
                }
                placeholder="9800000001"
              />
              <p className="text-xs text-muted-foreground">
                Also a login handle, so it must be unique.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="d-license">License no.</Label>
              <Input
                id="d-license"
                value={driverEditFor?.licenseNo ?? ""}
                onChange={(e) =>
                  setDriverEditFor((d) => (d ? { ...d, licenseNo: e.target.value } : d))
                }
                placeholder="DL-1001"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="d-vehicle">Vehicle today</Label>
            <Select
              id="d-vehicle"
              value={driverEditFor?.currentVehicleId ?? ""}
              onChange={(e) =>
                setDriverEditFor((d) => (d ? { ...d, currentVehicleId: e.target.value } : d))
              }
            >
              <option value="">No vehicle</option>
              {(activeVehicles.data ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.number})
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">
              Sets the driver's assignment for today — the same record their own home screen writes.
            </p>
          </div>
          {editDriver.error instanceof Error && <ErrorNote>{editDriver.error.message}</ErrorNote>}
        </div>
      </Modal>

      {/* ── driver: remove, with the real consequences counted ───────────── */}
      <DeleteRecordDialog
        open={!!driverDeleteFor}
        onClose={() => setDriverDeleteFor(null)}
        title={
          driverPreview.data?.canHardDelete
            ? `Delete ${driverDeleteFor?.name ?? "driver"}?`
            : `Remove ${driverDeleteFor?.name ?? "this driver"} from the roster?`
        }
        subtitle={
          driverPreview.data?.canHardDelete
            ? "Nothing has ever used this driver, so the record is deleted outright."
            : "They stop appearing in every driver picker. Nothing is deleted — their orders, routes and audit entries keep naming them, so the history stays true."
        }
        confirmLabel={
          driverPreview.data?.canHardDelete ? "Delete permanently" : "Remove from roster"
        }
        impactHeading={
          driverPreview.data?.canHardDelete ? "Nothing refers to them" : "What still names this driver"
        }
        rows={
          driverPreview.data
            ? [
                { label: "Orders that keep their name", value: driverPreview.data.ordersInvolved, tone: "muted" as const },
                { label: "Stock movements kept", value: driverPreview.data.stockMovements, tone: "muted" as const },
                { label: "Tracking pings kept", value: driverPreview.data.trackingPings, tone: "muted" as const },
                { label: "Daily vehicle assignments kept", value: driverPreview.data.assignments, tone: "muted" as const },
                {
                  label: "Login",
                  value: driverPreview.data.hasLogin ? "kept (no longer shown in pickers)" : "none",
                  tone: "muted" as const,
                },
              ]
            : [{ label: "Calculating what this affects", value: "…" }]
        }
        warning={
          driverPreview.data?.onActiveTrip
            ? driverPreview.data.activeTripStatus === "on_transit"
              ? "This driver has locked an order for dispatch. Only they can dispatch it, and their location is what the live map is following — resolve that order first."
              : "This driver is on an active trip, so their location is what the live map is following. Remove them once the trip is marked returned."
            : driverPreview.data?.alreadyInactive
              ? "This driver has already been removed from the roster."
              : driverPreview.data?.canHardDelete
                ? null
                : "Nothing is deleted by this — you can put them back on the roster at any time."
        }
        footnote={
          driverPreview.data?.canHardDelete
            ? "This cannot be undone. The deletion is recorded in the audit trail."
            : "Reversible: put them back on the roster from this same table at any time. The change is recorded in the audit trail."
        }
        busy={removeDriver.isPending}
        error={removeDriver.error instanceof Error ? removeDriver.error.message : null}
        onConfirm={async () => {
          if (!driverDeleteFor) return;
          try {
            await removeDriver.mutateAsync({ id: driverDeleteFor.id });
            setDriverDeleteFor(null);
          } catch {
            // Rendered from the mutation's own error.
          }
        }}
      />

      <Modal
        open={vOpen}
        onClose={() => setVOpen(false)}
        title="Add vehicle"
        footer={
          <>
            <Button variant="outline" onClick={() => setVOpen(false)}>
              Cancel
            </Button>
            <Button onClick={addVehicle} disabled={createVehicle.isPending}>
              {createVehicle.isPending ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Name *</Label>
            <Input value={vForm.name} onChange={(e) => setVForm((f) => ({ ...f, name: e.target.value }))} placeholder="Truck 3" />
          </div>
          <div className="space-y-1.5">
            <Label>Number *</Label>
            <Input value={vForm.number} onChange={(e) => setVForm((f) => ({ ...f, number: e.target.value }))} placeholder="BA 8 KHA 8901" />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Input value={vForm.type} onChange={(e) => setVForm((f) => ({ ...f, type: e.target.value }))} placeholder="Truck / Tipper / Pickup" />
          </div>
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      </Modal>

      <Modal
        open={dOpen}
        onClose={() => setDOpen(false)}
        title="Add driver"
        footer={
          <>
            <Button variant="outline" onClick={() => setDOpen(false)}>
              Cancel
            </Button>
            <Button onClick={addDriver} disabled={createDriver.isPending}>
              {createDriver.isPending ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Name *</Label>
            <Input value={dForm.name} onChange={(e) => setDForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Phone</Label>
            <Input value={dForm.phone} onChange={(e) => setDForm((f) => ({ ...f, phone: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>License no.</Label>
            <Input value={dForm.licenseNo} onChange={(e) => setDForm((f) => ({ ...f, licenseNo: e.target.value }))} />
          </div>
          <p className="text-xs text-muted-foreground">
            This adds the driver to the roster. To give them a login, use the Users page.
          </p>
          <p className="text-xs text-muted-foreground">
            Removing a driver later keeps every past order and route naming them — it only takes them off the roster.
          </p>
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      </Modal>
    </AppLayout>
  );
}