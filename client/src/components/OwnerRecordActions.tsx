import { useState } from "react";
import { AlertTriangle, Pencil, Trash2 } from "lucide-react";
import { trpc } from "@/_core/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorNote, Modal } from "@/components/ui/primitives";

/**
 * The owner's "delete anything" confirmation.
 *
 * Deleting a record cascades — an order takes its lines, invoice and tracking
 * pings with it — so a generic "are you sure?" is not good enough: the owner has
 * to see WHAT is about to go. Callers pass the concrete consequences (already
 * counted by the matching `admin.*DeletePreview` query) as rows, plus an optional
 * amber warning line, and this renders them before the destructive button arms.
 */
export function DeleteRecordDialog({
  open,
  onClose,
  title,
  subtitle,
  rows,
  warning,
  confirmLabel = "Delete permanently",
  busy,
  error,
  onConfirm,
  footnote = "This cannot be undone. The deletion is recorded in the audit trail.",
  impactHeading = "This will also remove",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  rows: Array<{ label: string; value: string | number; tone?: "danger" | "muted" }>;
  warning?: string | null;
  confirmLabel?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  /**
   * The permanence line at the bottom. Defaults to the delete wording, because
   * most of these dialogs DO delete. A reversible action (removing a driver from
   * the roster only deactivates them) must override it — telling the owner
   * "this cannot be undone" about something they can undo in one click is a lie
   * that makes them hesitate to use a feature that is safe by design.
   */
  footnote?: string | null;
  /**
   * Heading over the impact rows. "This will also remove" is right for a delete,
   * but wrong for an action that KEEPS history — there the rows read "orders that
   * keep their name", and a heading promising removal contradicts them.
   */
  impactHeading?: string;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            <Trash2 className="h-4 w-4" /> {busy ? "Deleting…" : confirmLabel}
          </Button>
        </>
      }
    >
      {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}

      <div className="rounded-lg border bg-muted/40 p-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {impactHeading}
        </p>
        <dl className="space-y-1.5 text-sm">
          {rows.map((r) => (
            <div key={r.label} className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd
                className={
                  r.tone === "danger"
                    ? "font-semibold tabular-nums text-destructive"
                    : "font-semibold tabular-nums"
                }
              >
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {warning && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{warning}</span>
        </div>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}

      {footnote && <p className="text-xs text-muted-foreground">{footnote}</p>}
    </Modal>
  );
}

/**
 * A single-field (or few-field) owner edit, in a modal.
 *
 * Deliberately generic: each page hands it its own field descriptors, so adding
 * "the owner can edit X" to a new record type is a few lines rather than a
 * bespoke form. Validation stays on the server — this only collects the values.
 */
export type EditField = {
  key: string;
  label: string;
  type?: "text" | "number" | "date";
  placeholder?: string;
  step?: string;
  help?: string;
};

export function EditRecordDialog({
  open,
  onClose,
  title,
  fields,
  initial,
  busy,
  error,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  fields: EditField[];
  initial: Record<string, string>;
  busy?: boolean;
  error?: string | null;
  onSave: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(initial);
  // Re-seed when the dialog opens for a different record.
  const [seed, setSeed] = useState(JSON.stringify(initial));
  const current = JSON.stringify(initial);
  if (current !== seed) {
    setSeed(current);
    setValues(initial);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => onSave(values)} disabled={busy}>
            <Pencil className="h-4 w-4" /> {busy ? "Saving…" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {fields.map((f) => (
          <div key={f.key} className="space-y-1.5">
            <Label htmlFor={`edit-${f.key}`}>{f.label}</Label>
            <Input
              id={`edit-${f.key}`}
              type={f.type ?? "text"}
              step={f.step}
              placeholder={f.placeholder}
              value={values[f.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
            {f.help && <p className="text-xs text-muted-foreground">{f.help}</p>}
          </div>
        ))}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </Modal>
  );
}

/**
 * The owner's edit/delete toolbar for one row.
 *
 * Rendered ONLY for the owner — the parent pages gate on `account.role`, and the
 * server refuses a driver regardless. Both entry points are icon buttons so they
 * fit in a table row without breaking the layout.
 */
export function OwnerRowActions({
  onEdit,
  onDelete,
  editLabel = "Edit",
  deleteLabel = "Delete",
}: {
  onEdit?: () => void;
  onDelete?: () => void;
  editLabel?: string;
  deleteLabel?: string;
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      {onEdit && (
        <Button variant="ghost" size="icon" onClick={onEdit} title={editLabel} aria-label={editLabel}>
          <Pencil className="h-4 w-4" />
        </Button>
      )}
      {onDelete && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onDelete}
          title={deleteLabel}
          aria-label={deleteLabel}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

/** The live, owner-only "who changed what, and when" trail. */
export function AuditTrail({ entity, limit = 60 }: { entity?: string; limit?: number }) {
  const log = trpc.admin.auditLog.useQuery({ entity, limit });
  const rows = log.data ?? [];

  if (log.isLoading) return <p className="text-sm text-muted-foreground">Loading the audit trail…</p>;
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No changes recorded yet. Every owner edit and delete appears here the moment it happens.
      </p>
    );
  }

  return (
    <ul className="divide-y">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
          <div className="min-w-0">
            <p className="text-sm">{r.summary ?? `${r.action} ${r.entity}`}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {r.actorName ?? r.actorUserId} · {r.entity}
              {r.targetLabel ? ` · ${r.targetLabel}` : ""}
            </p>
          </div>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {new Date(r.createdAt).toLocaleString()}
          </span>
        </li>
      ))}
    </ul>
  );
}
