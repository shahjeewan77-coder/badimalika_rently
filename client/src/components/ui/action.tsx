// ── Action buttons: never a silent click ──────────────────────────────────────
//
// Every state transition in the app (approve, lock, dispatch, pickup, return,
// delete) goes through one of these two components, so the three things a user
// needs from a button cannot be forgotten on one screen and remembered on
// another:
//
//   * it LOCKS while the request is in flight, so an impatient second tap cannot
//     turn "lock the order" into two attempts;
//   * it SHOWS the progress, with a spinner and a "Locking…" label, so the click
//     is visibly acknowledged even if the network takes a second;
//   * it REPORTS the outcome — a green confirmation, or the server's own error
//     text. A failure is never silent.
//
// The success note clears itself. The error does not: it stays until the next
// attempt, because an error the user missed is worse than one they have to
// dismiss.

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface AsyncActionState {
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: unknown;
  reset: () => void;
}

function errorMessage(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * A button that runs one mutation.
 *
 * `idle` / `busy` are the two labels, so the change is described in the same
 * words the button used ("Lock for dispatch" → "Locking…").
 */
export function ActionButton({
  mutation,
  onClick,
  idle,
  busy,
  variant = "default",
  size,
  className,
  icon,
  disabled,
  title,
}: {
  mutation: AsyncActionState;
  onClick: () => void;
  idle: string;
  busy: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  className?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  const [flash, setFlash] = useState(false);
  const wasPending = useRef(false);

  // A short green flash on success. The real confirmation is the page data
  // changing underneath, but the button acknowledging the click closes the loop
  // before that lands.
  useEffect(() => {
    if (wasPending.current && mutation.isSuccess) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 1600);
      return () => clearTimeout(t);
    }
    wasPending.current = mutation.isPending;
    return undefined;
  }, [mutation.isPending, mutation.isSuccess]);

  return (
    <Button
      variant={variant}
      size={size}
      className={cn(
        flash && "border-emerald-500 text-emerald-600 dark:text-emerald-400",
        className,
      )}
      // A pending request disables the button: this is the double-submit guard.
      disabled={disabled || mutation.isPending}
      aria-busy={mutation.isPending}
      title={title}
      onClick={onClick}
    >
      {mutation.isPending ? (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-current/30 border-t-current" />
      ) : flash ? (
        <CheckCircle2 className="h-4 w-4" />
      ) : (
        icon
      )}
      {mutation.isPending ? busy : idle}
    </Button>
  );
}

/** A row of outcome notes for the mutations that were just attempted. */
export function ActionFeedback({
  items,
  successText,
}: {
  items: Array<{ mutation: AsyncActionState; done: string }>;
  /** Overrides every success message; omit to use each item's own. */
  successText?: string;
}) {
  const failure = items.find((i) => i.mutation.isError);
  if (failure) {
    const message = errorMessage(failure.mutation.error) ?? "That action failed.";
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
      >
        <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{message}</span>
      </div>
    );
  }

  const succeeded = [...items].reverse().find((i) => i.mutation.isSuccess);
  if (!succeeded) return null;
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-700 dark:text-emerald-300"
    >
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{successText ?? succeeded.done}</span>
    </div>
  );
}
