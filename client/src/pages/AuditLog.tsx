import { useState } from "react";
import { History } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { PageHeader, Select } from "@/components/ui/primitives";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AuditTrail } from "@/components/OwnerRecordActions";

/**
 * The audit trail. The owner can edit and delete ANY record — including orders
 * that are already dispatched or on rent — so this is where that power is
 * reviewable: who changed what, when, and what the delete took with it.
 *
 * Owner-only. A driver has no route here (the guard redirects), and the server
 * refuses `admin.auditLog` regardless.
 */
const ENTITIES = [
  { value: "", label: "Everything" },
  { value: "order", label: "Orders" },
  { value: "customer", label: "Customers" },
  { value: "equipment", label: "Equipment" },
  { value: "vehicle", label: "Vehicles" },
  { value: "invoice", label: "Invoices" },
  { value: "receipt", label: "Receipts" },
  { value: "user", label: "Users" },
];

export default function AuditLog() {
  const [entity, setEntity] = useState("");

  return (
    <AppLayout>
      <PageHeader
        title="Audit trail"
        subtitle={
          <>
            Every owner edit and delete, with who did it and when. This is the record behind the ability to change
            anything at any stage. <History className="inline h-3.5 w-3.5" />
          </>
        }
      />

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Recent activity</CardTitle>
          <Select value={entity} onChange={(e) => setEntity(e.target.value)} className="w-44">
            {ENTITIES.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </Select>
        </CardHeader>
        <CardContent>
          <AuditTrail entity={entity || undefined} limit={100} />
        </CardContent>
      </Card>
    </AppLayout>
  );
}
