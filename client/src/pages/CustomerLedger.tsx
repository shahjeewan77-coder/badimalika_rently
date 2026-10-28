import { useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import {
  ArrowLeft,
  Wallet,
  Plus,
  Receipt as ReceiptIcon,
  TrendingDown,
  TrendingUp,
  Trash2,
  Save,
} from "lucide-react";
import { trpc } from "@/_core/trpc";
import { AppLayout } from "@/components/AppLayout";
import {
  PageHeader,
  StatCard,
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
  Select,
  Textarea,
  Badge,
} from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { bsDisplay, todayBs } from "@/lib/format";
import { formatMoney } from "@shared/rental";

const MODES = [
  { value: "cash", label: "Cash" },
  { value: "bank", label: "Bank" },
  { value: "cheque", label: "Cheque" },
  { value: "mobile", label: "Mobile" },
] as const;

type Mode = (typeof MODES)[number]["value"];

/**
 * Customer ledger: opening balance, every sales invoice (debit), every receipt
 * (credit), and the running / closing due. Recording a receipt reduces the due.
 * Owner-only — the page and the API both refuse a driver.
 */
export default function CustomerLedger() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const customerId = params.id ?? "";

  const ledger = trpc.customers.ledger.useQuery({ customerId }, { enabled: !!customerId });
  const [openReceipt, setOpenReceipt] = useState(false);
  const [openOpening, setOpenOpening] = useState(false);

  const removeReceipt = trpc.receipts.remove.useMutation({
    onSuccess: () => {
      utils.customers.ledger.invalidate();
      utils.customers.list.invalidate();
      utils.receipts.list.invalidate();
      utils.dashboard.summary.invalidate();
    },
  });

  if (ledger.isLoading) {
    return (
      <AppLayout>
        <Spinner />
      </AppLayout>
    );
  }
  if (ledger.isError || !ledger.data) {
    return (
      <AppLayout>
        <EmptyState
          title="Ledger not available"
          description="This customer's ledger is visible in the owner app only, or the customer was removed."
          action={<Button onClick={() => navigate("/customers")}>Back to customers</Button>}
        />
      </AppLayout>
    );
  }

  const { customer, rows, totals } = ledger.data;
  // Newest entry first reads better on screen; the running balance stored on each
  // row is still computed oldest-first, so it stays correct.
  const displayRows = [...rows].reverse();

  return (
    <AppLayout>
      <PageHeader
        title={`Ledger — ${customer.name}`}
        subtitle={
          <>
            {customer.phone ? `${customer.phone} · ` : ""}
            {customer.address ?? "No address"} · opening balance {formatMoney(totals.openingBalance)} (BS dates)
          </>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => navigate("/customers")}>
              <ArrowLeft className="h-4 w-4" /> Customers
            </Button>
            <Button variant="outline" onClick={() => setOpenOpening(true)}>
              <Save className="h-4 w-4" /> Opening balance
            </Button>
            <Button onClick={() => setOpenReceipt(true)}>
              <Plus className="h-4 w-4" /> Record receipt
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Opening balance"
          value={formatMoney(totals.openingBalance)}
          tone="default"
          icon={<Wallet className="h-5 w-5" />}
        />
        <StatCard
          label="Total invoiced"
          value={formatMoney(totals.totalInvoiced)}
          tone="warning"
          icon={<TrendingUp className="h-5 w-5" />}
        />
        <StatCard
          label="Total received"
          value={formatMoney(totals.totalReceived)}
          tone="success"
          icon={<TrendingDown className="h-5 w-5" />}
        />
        <StatCard
          label="Closing due"
          value={formatMoney(totals.closingDue)}
          tone={totals.closingDue > 0 ? "danger" : "success"}
          icon={<Wallet className="h-5 w-5" />}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ReceiptIcon className="h-4 w-4 text-primary" /> Statement
          </CardTitle>
        </CardHeader>
        <CardContent>
          {displayRows.length === 0 ? (
            <EmptyState
              icon={<ReceiptIcon className="h-5 w-5" />}
              title="No ledger entries yet"
              description="This customer has no invoices or receipts. Issue a sales invoice (dispatch an order) or record a receipt to start the ledger."
              action={<Button onClick={() => setOpenReceipt(true)}>Record receipt</Button>}
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Date (BS)</TH>
                  <TH>Particulars</TH>
                  <TH className="text-right">Debit</TH>
                  <TH className="text-right">Credit</TH>
                  <TH className="text-right">Balance due</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {displayRows.map((r) => (
                  <TR key={`${r.kind}-${r.id}`}>
                    <TD className="whitespace-nowrap text-muted-foreground">{bsDisplay(r.dateAd)}</TD>
                    <TD className="font-medium">
                      <span className="mr-2">
                        <Badge tone={r.kind === "invoice" ? "warning" : "success"}>{r.kind === "invoice" ? "Invoice" : "Receipt"}</Badge>
                      </span>
                      {r.description}
                    </TD>
                    <TD className="text-right tabular-nums">{r.debit ? formatMoney(r.debit) : "—"}</TD>
                    <TD className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                      {r.credit ? formatMoney(r.credit) : "—"}
                    </TD>
                    <TD className="text-right font-semibold tabular-nums">{formatMoney(r.running)}</TD>
                    <TD className="text-right">
                      {r.kind === "receipt" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Delete receipt"
                          disabled={removeReceipt.isPending}
                          onClick={() => removeReceipt.mutate({ id: r.id })}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ReceiptModal open={openReceipt} onClose={() => setOpenReceipt(false)} customerId={customer.id} customerName={customer.name} />
      <OpeningModal
        open={openOpening}
        onClose={() => setOpenOpening(false)}
        customerId={customer.id}
        initial={totals.openingBalance}
      />
    </AppLayout>
  );
}

function ReceiptModal({
  open,
  onClose,
  customerId,
  customerName,
}: {
  open: boolean;
  onClose: () => void;
  customerId: string;
  customerName: string;
}) {
  const utils = trpc.useUtils();
  const today = todayBs();
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<Mode>("cash");
  const [referenceNo, setReferenceNo] = useState("");
  const [dateAd, setDateAd] = useState(today.ad);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = trpc.receipts.create.useMutation({
    onSuccess: () => {
      utils.customers.ledger.invalidate();
      utils.customers.list.invalidate();
      utils.receipts.list.invalidate();
      utils.dashboard.summary.invalidate();
    },
  });

  const bsPreview = useMemo(() => {
    try {
      return bsDisplay(dateAd);
    } catch {
      return "—";
    }
  }, [dateAd]);

  async function onSave() {
    setError(null);
    const value = Number(amount);
    if (!value || value <= 0) {
      setError("Enter the amount received.");
      return;
    }
    try {
      await create.mutateAsync({
        customerId,
        amount: value,
        mode,
        referenceNo: referenceNo || undefined,
        notes: notes || undefined,
        dateAd,
      });
      setAmount("");
      setReferenceNo("");
      setNotes("");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the receipt.");
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Record receipt — ${customerName}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={create.isPending}>
            {create.isPending ? "Saving…" : "Save receipt"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label>Amount received (Rs) *</Label>
          <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Payment mode</Label>
            <Select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Reference no.</Label>
            <Input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} placeholder="Cheque / txn ref" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Date</Label>
          <Input type="date" value={dateAd} onChange={(e) => setDateAd(e.target.value)} />
          <p className="text-xs text-muted-foreground">Bikram Sambat: {bsPreview}</p>
        </div>
        <div className="space-y-1.5">
          <Label>Notes</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything to remember about this payment…" />
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Modal>
  );
}

function OpeningModal({
  open,
  onClose,
  customerId,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  customerId: string;
  initial: number;
}) {
  const utils = trpc.useUtils();
  const [value, setValue] = useState(String(initial ?? 0));
  const [error, setError] = useState<string | null>(null);
  const setOpening = trpc.customers.setOpeningBalance.useMutation({
    onSuccess: () => {
      utils.customers.ledger.invalidate();
      utils.customers.list.invalidate();
      utils.dashboard.summary.invalidate();
    },
  });

  async function onSave() {
    setError(null);
    const n = Number(value);
    if (Number.isNaN(n)) {
      setError("Enter a number.");
      return;
    }
    try {
      await setOpening.mutateAsync({ customerId, openingBalance: n });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the opening balance.");
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Opening balance"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={setOpening.isPending}>
            {setOpening.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label>Due carried in from before (Rs)</Label>
          <Input type="number" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} />
          <p className="text-xs text-muted-foreground">
            The balance this customer already owed before you started using this app. The ledger opens from this figure.
          </p>
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Modal>
  );
}
