# Equipment Rental Management System

A full-stack, installable (PWA) app for an equipment rental business that rents
equipment on a **day**, **hour**, or **pillar** basis.

- **Stack:** React 19 + Vite + Tailwind v4 (client) · tRPC + Drizzle ORM + PostgreSQL (server)
- **Auth:** email **or username/phone** + password, with server sessions
- **Installable:** PWA manifest + service worker (works offline for the app shell)
- **Dates:** Bikram Sambat (Nepali) calendar throughout the dashboard

---

## 1. What it does

### Billing / stock
- Every order/invoice line carries **two quantities**:
  - **Actual Qty** — the quantity delivered; this moves **stock/inventory**.
  - **Billed Qty** — the quantity charged; this drives the **invoice amount**.
  - They may differ (e.g. deliver 20 pillars, bill 18).
- Each line has a **rental basis** — `day`, `hour`, or `pillar` — with a **rate per basis**.
- Line amount = `rate × units × billedQty`.

### Users & roles
- **Owner / Admin** — the first account created. Creates driver logins, approves orders, sees all money.
- **Driver** — logs in with credentials the owner provides. Self-assigns the vehicle they drive each day.
- Seeded with **7 vehicles** and **7 drivers** (plus starter equipment and customers).

### Logging in (email is optional for drivers)
- The login screen accepts an **email, a username, or a phone number** plus a password.
- When the owner creates a driver login, **email is optional**. Give the driver a
  **username** (3–32 chars: letters, numbers, dot, dash, underscore) and/or a
  **phone number** — either works as the login handle.
- Usernames are **unique**; a duplicate is refused with a clear message.
- The owner account flow is unchanged: the first signup is the Owner/Admin and
  signs in with its email.

### Order → invoice → return flow
1. A driver (or the owner) creates an order: pick a customer (or **add a new customer inline**), add items with basis, rate, Actual Qty and Billed Qty.
2. The order goes to the owner as **Pending Approval**.
3. **The owner reviews and edits it** (see below) and then **Approves** (or Rejects).
4. A driver **locks** an approved order for dispatch → it becomes **On Transit** and is **hidden from other drivers**.
5. The driver clicks **Dispatched** → a **Sales Invoice** is created automatically and the products are marked **On Rent**.
6. When any driver picks the products up, **Mark returned** → the products leave the On Rent list and go **back to Stock**.

### Owner review & edit before approving
On a **Pending Approval** order the owner sees a **Review & Edit** button. It opens a panel
where **every** field can be corrected before approval:

- **Order header** — customer, driver, vehicle, order date, notes.
- **Every line item** — equipment, rental basis (day / hour / pillar), rate, units,
  **Actual Qty**, **Billed Qty**. Lines can be added or removed.
- The amount updates live as you type, so you see the effect before saving.

Two actions are offered:

| Action | What it does |
|---|---|
| **Save changes** | Writes the corrections and keeps the order in **Pending Approval**, so you can keep working and approve later. |
| **Save & approve** | Saves and immediately approves, in one step. |

Being able to edit **before** approval is what keeps the two-quantity rule honest: the
corrected **Actual Qty** is the figure that later moves **stock**, and the corrected
**Billed Qty** is the figure that drives the **invoice amount**. Once an order is approved
it is frozen and can no longer be edited here.

### Forgot password (6-digit code by email)
The login screen has a **Forgot password?** link:

1. Enter your **email** → the app mails a **6-digit code**.
2. Enter the **code** (valid **10 minutes**, **single use**).
3. Choose a **new password** → then log in with it.

The code is stored **hashed** (bcrypt) — never in plain text — guesses against one code are
capped, and requests are rate-limited (a per-IP cooldown plus a per-account hourly cap).

> **Setup required.** Email is sent over **your own** SMTP account — see
> [section 3](#3-configure-email-for-forgot-password-smtp). **Until SMTP is configured the
> flow still works**: the app does not crash, it says *"Email is not configured on the
> server"*, logs the code to the **server console** (`[otp] … code=……`), and — outside
> production only — also shows it on screen in a clearly-labelled *test code* box. That keeps
> the flow testable before you have a mailbox. In production it is **never** shown or logged.

### Money visibility
- **Amount due is only ever visible in the Owner app.** Drivers see line items and quantities, but every invoice total is stripped server-side for driver requests.

### Customer ledger & receipts (owner only)
A customer's balance is **derived, never stored**:

```
closing due = opening balance + Σ sales invoices − Σ receipts
```

Because it is computed on read, the ledger and the dashboard can never disagree and the
figure can never drift out of step with the documents behind it.

- **Customer Ledger** (sidebar → *Customer Ledger*) lists every customer with their
  **opening balance** and current **due balance**, and a total across all customers.
- Clicking a customer opens their **statement**: opening balance, then every
  **sales invoice (debit)** and every **receipt (credit)** in date order, each row
  showing the **running balance due**, and summary cards for **Total invoiced**,
  **Total received** and **Closing due**.
- **Record receipt** takes the **amount**, **payment mode** (`cash`, `bank`, `cheque`,
  `mobile`), **reference number**, **date** (entered in AD, shown in **Bikram Sambat**)
  and free-text **notes**. A receipt **reduces** the customer's due.
- **Opening balance** lets the owner set the due a customer carried in from before the
  app was used, so the ledger starts from the truth rather than from zero. It can also be
  set when adding a customer, and is editable from the ledger page.
- The **current due** also appears on the **Customers** list and as a **Customer dues**
  card on the dashboard.
- A receipt can be **deleted** (the trash icon on the receipt row) if it was entered by mistake.

**The driver app is unchanged: drivers have no ledger, no dues and no receipts.** The
sidebar entry is hidden, the pages are behind an owner-only route guard, and every ledger
and receipt endpoint refuses a driver server-side.

### Dashboard
- Summary cards for the whole pipeline (pending, approved, on transit, on rent, returned), billing, and stock.
- **Every summary card is clickable** and opens the matching detailed view.
- A **Bikram Sambat calendar** and BS dates are shown throughout.

---

## 2. Run it locally

Requirements: **Node.js 20+**, **pnpm**, and a **PostgreSQL** database.

```bash
# 1. Install dependencies
pnpm install

# 2. Configure the database
#    Create a .env file in the project root with:
#    DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME
#    JWT_SECRET=some-long-random-string

# 3. Create the tables
pnpm drizzle-kit push        # or: pnpm drizzle-kit generate && pnpm drizzle-kit migrate

# 4. Start the dev server (API + web)
pnpm dev
# open http://localhost:3000
```

### First run
1. Open the app and click **Create the owner account**.
2. The first signup becomes the **Owner/Admin**, and the app **seeds** 7 vehicles, 7 drivers, 8 equipment items and 3 customers automatically.
3. Go to **Users → Create driver login** to make a driver account. Email is optional —
   enter a **username** and/or **phone** instead, then hand the credentials to the driver.
   The driver signs in with that username (or phone) on the login screen.

### Production build
```bash
pnpm build
pnpm start
```

---

## 3. Configure email for forgot password (SMTP)

The forgot-password flow mails its 6-digit code through **your own** mailbox. Nothing is
sent until you configure these **environment variables** (app root `.env` for local runs,
or *Settings → Environment variables* on the platform):

| Variable | Required | Example | Notes |
|---|---|---|---|
| `SMTP_HOST` | **yes** | `smtp.gmail.com` | With `SMTP_PASS` unset, mail is skipped and the code is logged instead. |
| `SMTP_PORT` | optional | `465` | Defaults to `587`. Use **465** for Gmail (implicit TLS); `587` also works (STARTTLS). |
| `SMTP_USER` | recommended | `you@gmail.com` | The full mailbox address used to authenticate. |
| `SMTP_PASS` | **yes** | 16-char app password | A **Gmail App Password** — *not* your normal Gmail password. |
| `MAIL_FROM` | optional | `Sharma Equipment <you@gmail.com>` | Defaults to `SMTP_USER`. |

Minimal working Gmail example:

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=you@gmail.com
SMTP_PASS=abcdefghijklmnop      # 16 characters, NO spaces
MAIL_FROM=Sharma Equipment <you@gmail.com>
```

### How to create a Gmail App Password

Google rejects your normal account password for SMTP, so you need an **App Password**.
It requires 2-Step Verification to exist first.

1. **Turn on 2-Step Verification** (skip if already on): go to <https://myaccount.google.com/security>
   → *How you sign in to Google* → **2-Step Verification** → finish the setup.
2. **Open App Passwords**: go to <https://myaccount.google.com/apppasswords>
   (or search *App passwords* in your Google Account).
3. **Create one**: type a name such as `Equipment Rental` → click **Create**.
4. Google shows a **16-character password in four groups of four**, e.g. `abcd efgh ijkl mnop`.
   **Copy it now** — it is shown only once.
5. Paste it into `SMTP_PASS` with the **spaces removed** → `abcdefghijklmnop`.
   (This is the most common failure: the spaces are display formatting, not part of the password.)
6. Set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER=your full Gmail address`,
   then **restart the app**.

**Notes**
- *App passwords are unavailable:* the option is hidden if 2-Step Verification is off, and it does
  not exist for accounts that only use *Sign in with Google*, nor for some Workspace tenants where
  an admin has disabled it — in that case ask your admin, or use another mailbox/provider.
- *"Username and Password not accepted":* re-copy the app password (spaces removed) or generate a new one.
- *Gmail also requires a verified `MAIL_FROM` sender,* so keep `MAIL_FROM` equal to `SMTP_USER`.
- *No mailbox yet?* Leave SMTP unset. The flow still runs and logs the code to the server console,
  as described in the forgot-password section above.

---

## 4. Install as an app (PWA)

Once the app is open in a browser:
- **Desktop (Chrome/Edge):** click the install icon in the address bar, or menu → *Install Equipment Rental*.
- **Android:** browser menu → *Add to Home screen*.
- **iPhone (Safari):** Share → *Add to Home Screen*.

It then opens full-screen like a native app. The in-app **Download** page also offers an install button when the browser supports it.

---

## 5. Project layout

```
client/            React app (pages, components, design system)
  src/pages/       Login, ForgotPassword, Signup, Dashboard, DriverHome, Orders, NewOrder,
                   OrderDetail, Invoices, Rentals, Stock, Customers, Ledger, CustomerLedger,
                   Vehicles, Users, Download
  src/components/  AppLayout, BsCalendar, UI primitives
  public/          manifest.webmanifest, sw.js, icons
server/            tRPC API
  routers.ts       All procedures (auth, orders, invoices, rentals, customers, receipts,
                   dashboard, users…)
  db.ts            Account-scoped data access + ledger/receipt queries + seeding
  services/        smtp-mail.ts — sends the forgot-password code over the owner's SMTP
  _core/           Platform primitives (auth, db, storage, trpc) — do not edit
shared/            Code shared by client and server
  bs-calendar.ts   Bikram Sambat ⇄ Gregorian conversion (BS 2000–2090)
  rental.ts        Rental basis / status constants and formatters
  ledger.ts        Pure customer-ledger maths (opening + invoices − receipts, running due)
drizzle/           Database schema + migrations
```

---

## 6. Key rules implemented

| Requirement | Where |
|---|---|
| Actual Qty hits stock, Billed Qty hits invoice | `server/db.ts` (`dispatchOrder`, `returnOrder`), `order_items` table |
| Rental basis day / hour / pillar with rate | `shared/rental.ts`, `order_items.basis` |
| Owner + Driver roles | `profiles` table, `server/routers.ts` (`requireOwner`) |
| Driver daily vehicle self-assignment | `vehicle_assignments` table, `assignments.setMine` |
| Inline new customer | `orders.create` accepts `newCustomer` |
| Owner approval | `orders.approve` / `orders.reject` |
| Lock hides order from other drivers | `orders.lock` + `listOrders` driver filter |
| Dispatched → auto Sales Invoice | `dispatchOrder` |
| Amount due owner-only | `orders.get` strips invoice totals for drivers |
| On Rent → back to Stock on pickup | `returnOrder` |
| Bikram Sambat dates | `shared/bs-calendar.ts`, `BsCalendar` component |
| Clickable summary cards | `Dashboard.tsx` `StatCard` |
| **Owner review & edit before approving** | `orders.update` + `updatePendingOrder` (guided transaction), `OrderDetail.tsx` `OrderEditor` |
| **Forgot password by emailed code** | `auth.requestPasswordReset` / `verifyResetCode` / `resetPassword`, `password_reset_codes` table, `services/smtp-mail.ts`, `ForgotPassword.tsx` |
| **Email optional for drivers; login by username/phone** | `profiles.username`, `resolveLoginEmail`, `users.createDriver`, `Login.tsx` |
| **Driver lock keeps the order visible to the locker** | `listOrders` driver filter (driver's own + unlocked approved + **locked by me**) |
| **Customer ledger (opening + invoices − receipts)** | `shared/ledger.ts` `buildLedger`, `db.getCustomerLedger`, `customers.ledger` |
| **Receipt entry (amount, mode, ref, BS date, notes)** | `receipts` table, `receipts.create` / `remove`, `CustomerLedger.tsx` |
| **Due balance on Customers list + dashboard** | `customerDueMap`, `customers.list`, `dashboard.summary` `dues` |
| **Ledger/receipts hidden from drivers** | owner-only route guard + `requireOwner` on `customers.ledger` and all `receipts.*` |

---

## 7. Publish note (this build)

Publishing is the account owner's own action — the **Publish** button in the app UI. The publish
endpoint requires that owner session and answers `401 "No valid authentication credentials found"`
to every other caller, so it cannot be triggered from inside the sandbox.

This build was blocked by exactly one file: **`vite.config.ts`**, which is platform-shipped, carried
an extra `optimizeDeps` block that is not in the scaffold. Restoring it byte-exact — so every
platform-owned file matches the canonical scaffold — is what unblocks publishing.

If publishing ever refuses again, diff the platform-owned files against a fresh scaffold *first*:
`vite.config.ts`, `tsconfig.json`, `vitest.config.ts`, `components.json`, `drizzle.config.ts`,
`pnpm-workspace.yaml`, `Dockerfile`, `.dockerignore`, `.gitignore`, and everything under
`server/_core` and `client/src/_core`.

---

## 8. Notes & limitations

- The forgot-password email needs the SMTP variables in section 3 to be set; without them the
  app does not crash — it reports that email is not configured and logs the code (outside
  production) so the flow stays testable.
- Driver credentials are shown once in the Users page for you to hand over; no other email/SMS is sent.
- No payment gateway; "Amount due" is a record, not a payment. A **receipt** recorded against a
  customer reduces their due, but nothing here talks to a bank or a card processor.
- The ledger has no partial allocation: a receipt reduces the customer's overall due rather than
  being tied to a specific invoice, which is what the running-balance statement shows.
- Live GPS tracking **does** exist (section 9). Map tiles need a connection; the rest of the
  app, including the driver's trip screen, keeps working offline.
- The BS calendar table covers **BS 2000–2090**.

---

## 9. Live tracking — how it works, and the bug that was fixed

### How it works

While a driver has an **active trip** (an order locked for dispatch = `on_transit`, or `on_rent`)
their device watches its own position with the browser Geolocation API and posts a fix about every
**30 seconds**, plus immediately on the first fix of a trip. It **stops by itself when the trip
ends**, so a driver is never tracked when they are not out with equipment.

The tracker is mounted **above the router** (`client/src/lib/trackingProvider.tsx`), once per
signed-in session — not inside a screen. The **Live tracking** card on the driver's home is only a
*view* of that state. This matters: the card has to disappear when the driver opens Orders, but the
tracking must not.

A fix taken with no signal goes into the **same offline outbox** as every other write. The server
still refuses a ping from a driver with no active trip, so a stale queue cannot report a position
after the trip ended.

The owner's **Live Tracking** page (`/tracking`) shows a marker per driver who is currently on a
trip — name, vehicle, and how long ago the fix arrived — plus a marker per active delivery site,
refreshing every 20 seconds. Selecting a past trip in **Trip history** draws the route taken.

Only the **driver who locked the order** is tracked and shown, and only they may dispatch it. The
order detail keeps all three actors separately (created by / transited by / dispatched by).

### The bug: a vehicle on transit never appeared

Three independent faults, plus one that made the map lie:

1. **`client/src/lib/offline/links.ts` — an inverted argument.** `decideQueue(path, online)` was
   called with `isOffline()`. Every decision was therefore backwards: a *queueable* write was
   parked in the outbox while the app was **online** and attempted while **offline**. Because the
   outbox was only retried on an offline→online transition, a stranded ping stayed stranded for the
   whole trip. `tracking.ping` is queueable, so **no driver fix ever reached the server**.
   Worse, the queued envelope was counted as a delivery, so the card reported *"Updates sent"* while
   the owner's map received nothing.
   *Fix:* pass `getOnline()`; report a queued fix as **queued**, never as sent.
2. **The tracker lived inside the card.** `DriverTrackingCard` renders only on `/`. A driver opening
   Orders, Stock or a new order on a live trip unmounted it, which ran `clearWatch()` and cleared the
   posting interval — so tracking stopped exactly when the driver was on the road.
   *Fix:* the tracker moved to `TrackingProvider`, above the router (see above).
3. **`server/db.ts` `latestDriverLocations` had no status filter.** The newest ping per driver was
   returned regardless of whether that trip had finished, so a **returned** order's last known
   position stayed on the "live" map forever — which looks identical to a stale tracker.
   *Fix:* restrict to `on_transit` / `on_rent`.
4. **Nothing retried an already-queued write while online.** `OfflineProvider` now drains a
   non-empty outbox on a 15-second interval and immediately when a write is queued.

### How to test it

1. As the **owner**, open **Customers → Set site** and give a customer coordinates.
2. As the **driver who will lock the order**, set today's vehicle (**My vehicle today**).
3. Have the driver create an order, the owner approve it, and that driver **lock it for dispatch**.
4. On the driver's home, press **Share my location** and allow the prompt.
5. Navigate to **Orders** and stay there — tracking must continue (this is the regression).
6. As the owner open **Live Tracking**: the driver's marker, name and vehicle appear and move as the
   driver moves. **Trip history → Show route** draws the path.
7. **Offline test:** set the browser Offline. The card shows *"N updates waiting to upload"*. Go back
   online and they upload on their own.

**No real GPS?** Use DevTools ▸ **Sensors ▸ Location** — the app reads whatever the browser reports,
so a mocked position behaves exactly like a real one. A headless browser that blocks geolocation
cannot drive this; use a real browser window.

- The BS calendar table covers **BS 2000–2090**.
