import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  bigint,
  boolean,
  doublePrecision,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ──────────────────────────────────────────────────────────────────────────────
// SYSTEM TABLE — managed by the scaffold. The Agent MUST NOT redefine or drop
// the auth columns here; it only ADDS business tables below.
// ──────────────────────────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"), // null for SSO-linked users (future)
  name: text("name"),
  role: text("role").notNull().default("user"), // 'user' | 'admin'
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// SYSTEM TABLE — managed by the scaffold, written by server/_core/storage.ts.
export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull().unique(),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    contentType: text("content_type"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("files_owner_idx").on(t.ownerId), index("files_created_idx").on(t.createdAt)],
);

// ──────────────────────────────────────────────────────────────────────────────
// BUSINESS TABLES — Equipment Rental Management
//
// Account scoping: every business row carries `ownerId` = the OWNER account's
// user id. The owner's own profile has ownerId = their own id; a driver's
// profile has ownerId = the owner who created them. Every query filters by the
// caller's resolved account id (see server/db.ts `accountIdFor`).
// ──────────────────────────────────────────────────────────────────────────────

// Business profile for a user: role + display info + which account they belong to.
export const profiles = pgTable(
  "profiles",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("driver"), // 'owner' | 'driver'
    displayName: text("display_name"),
    phone: text("phone"),
    // Login handle for drivers. Email is optional, so a driver may sign in with
    // a username (or their phone) instead. Globally unique; NULL for the owner
    // and for any driver created with an email only.
    username: text("username"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("profiles_owner_idx").on(t.ownerId),
    uniqueIndex("profiles_username_uq").on(t.username),
  ],
);

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    phone: text("phone"),
    address: text("address"),
    // A due carried into the ledger from before this system was used, so the
    // customer's running/closing balance starts from the truth rather than 0.
    openingBalance: doublePrecision("opening_balance").notNull().default(0),
    // Optional delivery-site coordinates, so the owner's live map can plot the
    // destination of an active trip. Null until the owner sets them.
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("customers_owner_idx").on(t.ownerId)],
);

export const vehicles = pgTable(
  "vehicles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    number: text("number").notNull(),
    type: text("type"),
    // Retiring a truck must never rewrite what happened: orders, stock movements
    // and trip history all keep naming it. So a delete that would strand history
    // is a DEACTIVATION (isActive = false) rather than a row delete — the same
    // treatment drivers already get. Only a vehicle nothing refers to is removed
    // outright.
    isActive: boolean("is_active").notNull().default(true),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("vehicles_owner_idx").on(t.ownerId),
    index("vehicles_owner_active_idx").on(t.ownerId, t.isActive),
  ],
);

export const drivers = pgTable(
  "drivers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    phone: text("phone"),
    licenseNo: text("license_no"),
    // Removing a driver from the roster must never touch history, so a delete is a
    // DEACTIVATION: the row stays, `isActive` goes false, and they disappear from
    // every picker and roster. Orders, tracking pings and the audit trail still
    // name them, which is the point — an order carried by someone who has since
    // left is still a true record of what happened.
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("drivers_owner_idx").on(t.ownerId)],
);

// One row per driver per day: which vehicle they are driving. Changeable next day.
export const vehicleAssignments = pgTable(
  "vehicle_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id, { onDelete: "cascade" }),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "cascade" }),
    dateAd: text("date_ad").notNull(), // YYYY-MM-DD (Gregorian)
    dateBs: text("date_bs").notNull(), // YYYY-MM-DD (Bikram Sambat)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("assignments_owner_idx").on(t.ownerId),
    uniqueIndex("assignments_driver_date_uq").on(t.driverId, t.dateAd),
  ],
);

export const equipment = pgTable(
  "equipment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code"),
    unit: text("unit").notNull().default("pcs"),
    totalQty: doublePrecision("total_qty").notNull().default(0),
    onRentQty: doublePrecision("on_rent_qty").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("equipment_owner_idx").on(t.ownerId)],
);

// Order lifecycle:
//   pending_approval → approved → on_transit → dispatched → on_rent → returned
//   (rejected is terminal)
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    driverId: uuid("driver_id").references(() => drivers.id, { onDelete: "set null" }),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending_approval"),
    orderDateAd: text("order_date_ad").notNull(),
    orderDateBs: text("order_date_bs").notNull(),
    notes: text("notes"),
    // When a driver locks an order for dispatch, it is hidden from other drivers.
    // The locking driver is ALSO the one whose location is tracked, and the only
    // one allowed to dispatch the order.
    lockedByDriverId: uuid("locked_by_driver_id").references(() => drivers.id, {
      onDelete: "set null",
    }),
    // The vehicle the LOCKING driver was driving when they took the order for
    // dispatch. `vehicleId` above records the vehicle the order was CREATED
    // with, which belongs to whoever took it — but the trip belongs to the
    // locker, so the vehicle actually on the road is theirs. Every in-transit /
    // tracking read resolves the trip vehicle as
    // COALESCE(transit_vehicle_id, vehicle_id), so an order locked by a second
    // driver shows that driver's vehicle, while the original one is still on
    // record in `vehicle_id`.
    transitVehicleId: uuid("transit_vehicle_id").references(() => vehicles.id, {
      onDelete: "set null",
    }),
    // ── the three actors ──
    // An order can be taken by one driver and locked/dispatched by a different
    // one, so "the driver" is not a single fact about an order. These three
    // columns record each step separately, and stay correct when the owner later
    // reassigns `driverId`:
    //   createdBy    — who took the order (null when the owner entered it)
    //   transitedBy  — who locked it for dispatch (the tracked + dispatching driver)
    //   dispatchedBy — who marked it dispatched
    createdByDriverId: uuid("created_by_driver_id").references(() => drivers.id, {
      onDelete: "set null",
    }),
    transitedByDriverId: uuid("transited_by_driver_id").references(() => drivers.id, {
      onDelete: "set null",
    }),
    dispatchedByDriverId: uuid("dispatched_by_driver_id").references(() => drivers.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("orders_owner_idx").on(t.ownerId), index("orders_status_idx").on(t.status)],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    equipmentId: uuid("equipment_id")
      .notNull()
      .references(() => equipment.id, { onDelete: "restrict" }),
    basis: text("basis").notNull().default("day"), // 'day' | 'hour' | 'pillar'
    rate: doublePrecision("rate").notNull().default(0),
    // Actual Qty hits stock/inventory; Billed Qty hits the invoice amount.
    actualQty: doublePrecision("actual_qty").notNull().default(0),
    billedQty: doublePrecision("billed_qty").notNull().default(0),
    // Number of days / hours / pillars the line is charged for.
    units: doublePrecision("units").notNull().default(1),
    lineAmount: doublePrecision("line_amount").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("order_items_order_idx").on(t.orderId)],
);

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    invoiceNo: text("invoice_no").notNull(),
    invoiceDateAd: text("invoice_date_ad").notNull(),
    invoiceDateBs: text("invoice_date_bs").notNull(),
    subtotal: doublePrecision("subtotal").notNull().default(0),
    total: doublePrecision("total").notNull().default(0),
    amountDue: doublePrecision("amount_due").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("invoices_owner_idx").on(t.ownerId),
    uniqueIndex("invoices_order_uq").on(t.orderId),
  ],
);

// Money received from a customer against their outstanding due. Invoices (via
// orders) are the debits on a customer's ledger; receipts are the credits. The
// due balance is therefore `openingBalance + sum(invoices.total) -
// sum(receipts.amount)` — derived on read, never stored, so it can never drift.
export const receipts = pgTable(
  "receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    amount: doublePrecision("amount").notNull().default(0),
    mode: text("mode").notNull().default("cash"), // 'cash' | 'bank' | 'cheque' | 'mobile'
    referenceNo: text("reference_no"),
    notes: text("notes"),
    dateAd: text("date_ad").notNull(), // YYYY-MM-DD (Gregorian)
    dateBs: text("date_bs").notNull(), // YYYY-MM-DD (Bikram Sambat)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("receipts_owner_idx").on(t.ownerId),
    index("receipts_customer_idx").on(t.customerId),
  ],
);

// Audit trail of every stock movement (out on dispatch, in on return).
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    equipmentId: uuid("equipment_id")
      .notNull()
      .references(() => equipment.id, { onDelete: "cascade" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    type: text("type").notNull(), // 'out' | 'in'
    qty: doublePrecision("qty").notNull().default(0),
    dateAd: text("date_ad").notNull(),
    dateBs: text("date_bs").notNull(),
    // Who physically moved this stock: the driver who dispatched it (`out`) or
    // the driver who brought it back (`in`). Null when the owner did it.
    // `set null` so removing a driver from the roster never deletes the
    // movement — the name below still names them.
    driverId: uuid("driver_id").references(() => drivers.id, { onDelete: "set null" }),
    // The name snapshotted at the time of the movement, so the report still
    // reads "returned by Kabiraj" after that driver leaves the roster. Also
    // holds the owner's name for owner-recorded movements.
    actorName: text("actor_name"),
    // ── reversals (owner "undo") ──
    // When the owner undoes a return, the stock that was put back has to come
    // off the shelf again. That is written as its OWN row pointing at the
    // movement it reverses, so the history stays complete and the running
    // balance stays correct — the original return is never edited or deleted.
    //
    // The UNIQUE index below is what makes undo idempotent at the database
    // level: a second attempt to reverse the same movement cannot insert a
    // second row, so stock can never be double-reversed even if two requests
    // race. Postgres allows many NULLs in a unique index, so ordinary
    // movements (which reverse nothing) are unaffected.
    reversalOfId: uuid("reversal_of_id"),
    // Why the owner reversed it. Shown in the movement report and the audit
    // trail, so a correction is never anonymous.
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("movements_owner_idx").on(t.ownerId),
    index("movements_equip_idx").on(t.equipmentId),
    uniqueIndex("movements_reversal_uq").on(t.reversalOfId),
  ],
);

// ── live GPS vehicle tracking ─────────────────────────────────────────────────
//
// One row per location ping a driver's device sends while a trip is active
// (order locked for dispatch / on transit / on rent). The rows ARE the trip's
// route history: the owner's map reads the newest ping per driver for the live
// marker, and the whole series for the route taken.
//
// `orderId` is nullable with `onDelete: "set null"` so a deleted order does not
// take its location history with it (the history is still a record of where a
// vehicle went). `driverId` cascades, because a ping with no driver is
// meaningless. `recordedAt` is the DEVICE's timestamp (when the fix was taken),
// which is what the route is ordered by; `createdAt` is when the server stored
// it, which is what a late-synced offline ping is judged by.
export const tripLocations = pgTable(
  "trip_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id, { onDelete: "cascade" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    accuracy: doublePrecision("accuracy"),
    speed: doublePrecision("speed"),
    heading: doublePrecision("heading"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("trip_locations_owner_idx").on(t.ownerId),
    index("trip_locations_driver_idx").on(t.driverId),
    index("trip_locations_order_idx").on(t.orderId),
    index("trip_locations_recorded_idx").on(t.recordedAt),
  ],
);

// ── audit trail ──────────────────────────────────────────────────────────────
//
// Who changed or deleted what, and when. The owner can edit and delete ANY
// record in the system, including ones that are already dispatched or on rent,
// so every one of those actions writes a row here: an append-only history is
// what makes that power reviewable rather than invisible.
//
// `actorUserId` deliberately has NO foreign key: deleting a user must not erase
// the record of what they did, so this is plain text + a snapshot of the name at
// the time of the action. `targetId` is also plain text, because the row it
// refers to may be gone by the time the entry is read.
//
// `summary` is the human sentence shown in the UI; `detail` holds the structured
// before/after so a diff can be inspected without joining anything.
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").notNull(),
    actorName: text("actor_name"),
    actorRole: text("actor_role").notNull().default("owner"),
    /** 'create' | 'update' | 'delete' */
    action: text("action").notNull(),
    /** 'order' | 'customer' | 'equipment' | 'vehicle' | 'receipt' | 'invoice' | 'user' | 'driver' */
    entity: text("entity").notNull(),
    targetId: text("target_id"),
    targetLabel: text("target_label"),
    summary: text("summary"),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_owner_idx").on(t.ownerId),
    index("audit_created_idx").on(t.createdAt),
    index("audit_entity_idx").on(t.entity),
  ],
);

// ── password reset (forgot-password OTP) ───────────────────────────────────────
// One row per requested reset code. The 6-digit code is stored HASHED (bcrypt) —
// never in plain text — and is single-use (`consumedAt`), short-lived
// (`expiresAt`) and attempt-capped (`attempts`). `requestIp` backs the per-IP
// rate limit that lives in server/db.ts.
export const passwordResetCodes = pgTable(
  "password_reset_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    requestIp: text("request_ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("reset_codes_user_idx").on(t.userId),
    index("reset_codes_created_idx").on(t.createdAt),
  ],
);