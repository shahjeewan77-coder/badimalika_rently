import { useState } from "react";
import { UserCog, Plus, KeyRound, Copy, Check } from "lucide-react";
import { trpc } from "@/_core/trpc";
import { AppLayout } from "@/components/AppLayout";
import { PageHeader, Table, THead, TBody, TR, TH, TD, Spinner, EmptyState, Modal, ErrorNote, Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DeleteRecordDialog, EditRecordDialog, OwnerRowActions } from "@/components/OwnerRecordActions";
import { LIVE_POLL_MS, pollWhileOnline } from "@/lib/live";

export default function Users() {
  const utils = trpc.useUtils();
  const users = trpc.users.list.useQuery(undefined, {
    refetchInterval: pollWhileOnline(LIVE_POLL_MS),
  });

  // ── owner: edit / delete any user account ──
  const [editFor, setEditFor] = useState<{
    userId: string;
    displayName: string | null;
    phone: string | null;
    role: string;
    driverId: string | null;
  } | null>(null);
  const [deleteFor, setDeleteFor] = useState<{ id: string; name: string } | null>(null);
  const deletePreview = trpc.admin.userDeletePreview.useQuery(
    { id: deleteFor?.id ?? "" },
    { enabled: !!deleteFor },
  );
  const del = trpc.admin.deleteUser.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      utils.drivers.list.invalidate();
      utils.orders.list.invalidate();
      utils.admin.auditLog.invalidate();
      setDeleteFor(null);
    },
  });
  const edit = trpc.admin.editUser.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      utils.drivers.list.invalidate();
      utils.admin.auditLog.invalidate();
      setEditFor(null);
    },
  });
  const createDriver = trpc.users.createDriver.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      utils.drivers.list.invalidate();
    },
  });

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", username: "", password: "", phone: "", licenseNo: "" });
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ loginId: string; password: string; email: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  const rows = users.data ?? [];

  async function onCreate() {
    setError(null);
    const hasIdentifier = Boolean(form.email.trim() || form.username.trim() || form.phone.trim());
    if (!form.name || form.password.length < 8) {
      setError("A driver name and a password of at least 8 characters are required.");
      return;
    }
    if (!hasIdentifier) {
      setError("Give the driver a username, phone number or email so they can log in.");
      return;
    }
    try {
      const res = await createDriver.mutateAsync({
        name: form.name,
        email: form.email.trim() || undefined,
        username: form.username.trim() || undefined,
        password: form.password,
        phone: form.phone.trim() || undefined,
        licenseNo: form.licenseNo || undefined,
      });
      setCreated({ loginId: res.loginId, password: form.password, email: form.email.trim() || null });
      setForm({ name: "", email: "", username: "", password: "", phone: "", licenseNo: "" });
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the login.");
    }
  }

  async function copyCreds() {
    if (!created) return;
    await navigator.clipboard.writeText(`Username: ${created.loginId}\nPassword: ${created.password}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <AppLayout>
      <PageHeader
        title="Users"
        subtitle="Create driver logins and hand the credentials over. Drivers never see amounts due."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> Create driver login
          </Button>
        }
      />

      {created && (
        <Card className="border-emerald-300 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-emerald-800 dark:text-emerald-300">
              <KeyRound className="h-4 w-4" /> Driver login created
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-emerald-900/80 dark:text-emerald-200/80">
              Share these credentials with the driver. This is the only time the password is shown.
            </p>
            <div className="rounded-lg border bg-card p-3 font-mono text-sm">
              <p>Username: {created.loginId}</p>
              <p>Password: {created.password}</p>
              {created.email && <p className="text-muted-foreground">Email: {created.email}</p>}
            </div>
            <p className="text-xs text-emerald-900/70 dark:text-emerald-200/70">
              The driver signs in with this username (or their phone number) on the login screen.
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={copyCreds}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? "Copied" : "Copy"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {users.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<UserCog className="h-5 w-5" />}
          title="No users yet"
          description="Create a login for each driver so they can take orders and dispatch."
          action={<Button onClick={() => setOpen(true)}>Create driver login</Button>}
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Role</TH>
              <TH>Username</TH>
              <TH>Phone</TH>
              <TH>Driver record</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {rows.map((u) => (
              <TR key={u.userId}>
                <TD className="font-medium">{u.displayName ?? "—"}</TD>
                <TD>
                  <Badge tone={u.role === "owner" ? "info" : "muted"}>{u.role === "owner" ? "Owner / Admin" : "Driver"}</Badge>
                </TD>
                <TD className="text-muted-foreground">{u.username ?? "—"}</TD>
                <TD className="text-muted-foreground">{u.phone ?? "—"}</TD>
                <TD>{u.driverId ? <Badge tone="success">Linked</Badge> : <Badge tone="muted">—</Badge>}</TD>
                <TD className="text-right">
                  <OwnerRowActions
                    editLabel={`Edit ${u.displayName ?? "user"}`}
                    deleteLabel={`Delete ${u.displayName ?? "user"}`}
                    onEdit={() =>
                      setEditFor({
                        userId: u.userId,
                        displayName: u.displayName,
                        phone: u.phone,
                        role: u.role,
                        driverId: u.driverId,
                      })
                    }
                    onDelete={() => setDeleteFor({ id: u.userId, name: u.displayName ?? "this user" })}
                  />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <DeleteRecordDialog
        open={!!deleteFor}
        onClose={() => setDeleteFor(null)}
        title={`Delete ${deleteFor?.name ?? "this user"}?`}
        subtitle="The login and the driver profile are removed. Their past orders are kept — a transaction belongs to the business, not to whoever entered it."
        rows={
          deletePreview.data
            ? [
                { label: "Driver profile", value: deletePreview.data.isDriver ? "removed" : "none", tone: "danger" as const },
                { label: "Orders kept (name cleared from history)", value: deletePreview.data.ordersInvolved, tone: "muted" as const },
              ]
            : [{ label: "Calculating what will be removed", value: "…" }]
        }
        warning={
          deletePreview.data?.isSelf
            ? "This is your own owner account — it cannot be deleted. Choose a driver account instead."
            : null
        }
        busy={del.isPending}
        error={del.error instanceof Error ? del.error.message : null}
        onConfirm={() => deleteFor && del.mutate({ id: deleteFor.id })}
      />

      <EditRecordDialog
        open={!!editFor}
        onClose={() => setEditFor(null)}
        title={`Edit ${editFor?.displayName ?? "user"}`}
        fields={[
          { key: "name", label: "Display name" },
          { key: "phone", label: "Phone" },
          ...(editFor?.driverId
            ? [{ key: "driverName", label: "Driver record name", help: "The name shown on orders and the tracking map." }]
            : []),
        ]}
        initial={
          editFor
            ? {
                name: editFor.displayName ?? "",
                phone: editFor.phone ?? "",
                driverName: editFor.displayName ?? "",
              }
            : {}
        }
        busy={edit.isPending}
        error={edit.error instanceof Error ? edit.error.message : null}
        onSave={(v) =>
          editFor &&
          edit.mutate({
            id: editFor.userId,
            name: v.name.trim() || undefined,
            driverName: editFor.driverId && v.driverName.trim() ? v.driverName.trim() : undefined,
            driverPhone: v.phone.trim() || null,
          })
        }
      />

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create driver login"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={onCreate} disabled={createDriver.isPending}>
              {createDriver.isPending ? "Creating…" : "Create login"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Driver name *</Label>
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Username</Label>
            <Input
              value={form.username}
              placeholder="e.g. ram"
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">
              The driver logs in with this. 3\u201332 characters: letters, numbers, dot, dash or underscore.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Email (optional)</Label>
            <Input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Password * (min 8)</Label>
            <Input value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>License no.</Label>
              <Input value={form.licenseNo} onChange={(e) => setForm((f) => ({ ...f, licenseNo: e.target.value }))} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Email is optional \u2014 a driver can log in with their username or phone number instead.
          </p>
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      </Modal>
    </AppLayout>
  );
}
