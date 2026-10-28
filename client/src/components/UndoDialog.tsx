// ── Owner "undo" confirmation ────────────────────────────────────────────────
//
// Undoing a lock or a return changes stock, invoices and who is on the road, so
// a bare "are you sure?" is not enough. This dialog does three things:
//
//   * states EXACTLY what will be reversed, in the caller's own words (the rows
//     are passed in, already computed from the real record);
//   * requires a short reason, because an undo with no explanation is
//     indistinguishable from a mistake later — the reason is stored on the audit
//     entry;
//   * locks the confirm button while the request is in flight, so an impatient
//     second click cannot fire the undo twice.
//
// It is rendered only for the owner. The server refuses a driver regardless
// (`requireOwner` on both procedures), which is what actually enforces the rule.

import { useEffect, useState } from "react";
import { AlertTriangle, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorNote, Modal } from "@/components/ui/primitives";

export function UndoDialog({
  open,
  onClose,
  title,
  subtitle,
  rows,
  warning,
  confirmLabel,
  busy,
  error,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  /** What will be reversed, one line each. */
  rows: Array<{ label: string; value: string | number; tone?: "danger" | "muted" }>;
  /** An amber note for a consequence worth calling out. */
  warning?: string | null;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");

  // Re-seed each time the dialog opens, so a previous reason is never reused
  // for a different record.
  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const trimmed = reason.trim();
  const canConfirm = trimmed.length > 0 && !busy;

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
          <Button onClick={() => onConfirm(trimmed)} disabled={!canConfirm}>
            {busy ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-current/30 border-t-current" />
            ) : (
              <Undo2 className="h-4 w-4" />
            )}
            {busy ? "Undoing…" : confirmLabel}
          </Button>
        </>
      }
    >
      {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}

      <div className="rounded-lg border bg-muted/40 p-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          This will reverse
        </p>
        <dl className="space-y-1.5 text-sm">
          {rows.map((r) => (
            <div key={r.label} className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd
                className={
                  r.tone === "danger"
                    ? "text-right font-semibold tabular-nums text-destructive"
                    : "text-right font-semibold tabular-nums"
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

      <div className="space-y-1.5">
        <Label htmlFor="undo-reason">Reason (required)</Label>
        <Input
          id="undo-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Locked by the wrong driver"
          maxLength={200}
          autoFocus
        />
        <p className="text-xs text-muted-foreground">
          Stored on the audit trail, so this correction is never anonymous.
        </p>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      <p className="text-xs text-muted-foreground">
        The original record is kept — the undo is added as its own entry, so the history stays complete.
      </p>
    </Modal>
  );
}
