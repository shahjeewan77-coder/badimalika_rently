# AGENT.md — build guide for this full-stack scaffold

You are filling a **pre-built** full-stack template. The platform SDK under
`_core/` is done and correct — **you never edit `_core/`**. You write only the
business seams. Read this once, then `grep`/read the specific `_core` file
before you call into it (don't guess signatures).

## Stack
React 19 + Vite + Tailwind + shadcn/ui + wouter · tRPC + superjson + zod ·
Drizzle ORM (**Postgres**) · Hono server · jose/bcryptjs auth.

## Directory map
```
client/src/pages,components   ← YOU write UI
client/src/App.tsx            ← YOU wire wouter routes
client/src/lib/utils.ts       cn() — every components/ui/* imports it; don't delete
client/src/_core/             platform frontend SDK (useAuth, trpc client, publicUrl) — don't edit
server/routers.ts             ← YOU write tRPC procedures (thin)
server/db.ts                  ← YOU write Drizzle queries
server/services/              ← YOU write external integrations (compose _core primitives)
server/_core/                 platform backend SDK — DON'T EDIT
drizzle/schema.ts             ← YOU add business tables (don't touch `users` auth cols)
drizzle/migrations/           generated migration files (commit them)
shared/                       types/constants shared client↔server
```

## Your authoring order (DESIGN §5.3)
1. `drizzle/schema.ts` — add business tables (FK to `users.id`, index owner cols).
2. `pnpm db:generate` → creates a migration; then `pnpm db:migrate` (dev DB).
3. `server/db.ts` — owner-scoped queries.
4. `server/routers.ts` — thin procedures (public/protected/admin).
5. `client/src/pages` + `components`, then wire routes in `App.tsx`.
6. Verify (3 signals): dev-server logs clean · `pnpm test` · screenshot the page.

## `_core` API cheat-sheet (read the file before using)
- **auth** (`server/_core/auth.ts`): `authProvider().login/logout/getSession`,
  `registerLocalUser(email,pw,name)`. Session is a cookie — never roll your own.
  `login` throws `AuthError` on bad credentials → `UNAUTHORIZED`; `registerLocalUser`
  throws `EmailTakenError` (an `AuthError`) when the address already has an account
  → `CONFLICT`. Both messages are written for the user; pass them straight through.
- **trpc** (`server/_core/trpc.ts`): `publicProcedure` / `protectedProcedure`
  (`ctx.user` guaranteed) / `adminProcedure`. `ctx = { c, db, user }`. Any error that
  ESCAPES a procedure reaches the client as a bare 500 "Something went wrong."
  (the real one is logged server-side) — so an untranslated failure is not a leak,
  but it is also not an explanation. Raise the `TRPCError` yourself.
- **test-caller** (`server/_core/test-caller.ts`): `makeCaller(overrides?)` — the ONLY
  way to call `appRouter` from a test. Do not build your own caller and do not reach
  for `createCaller` directly; pass a partial ctx to act as a specific user.
- **db** (`server/_core/db.ts`): shared Drizzle `db` + `schema`, plus
  `isUniqueViolation(e, constraint?)` — the ONLY correct way to read a failed write.
  Drizzle does not re-throw the driver error: it wraps it, and the wrapper's message
  is `Failed query: <your sql>\nparams: <every bound value>`, so `/unique/.test(e.message)`
  matches nothing and a duplicate escapes as a 500. Map it to `CONFLICT` with a
  sentence the user can act on ("You already have a project with that name.").

### Atomic writes — there is no `db.transaction`

The database runs behind an HTTP driver (`DB_DRIVER=http`): one request per
query, so there is no session to hold a `BEGIN` open in. `db.transaction` is not
on the type — calling it is a compile error, not a runtime surprise.

Three ways to get atomicity, weakest first — take the first that fits:

1. **One statement.** Put the decision in `WHERE`, read the answer off
   `RETURNING`. A multi-row `INSERT` is atomic on its own; `SET n = n + 1` is
   already safe against concurrent callers.

   ```ts
   const row = (await db.insert(items).values({ ... }).onConflictDoNothing().returning()).at(0);
   if (!row) throw new AlreadyExistsError();     // zero rows IS the signal
   ```

2. **`atomic([...])`** when several writes must all land or none:

   ```ts
   import { atomic, db } from "./_core/db";

   const id = crypto.randomUUID();                 // ids here, not in SQL, so a
   const [board, member] = await atomic((d) => [   // later statement can use them
     d.insert(boards).values({ id, ownerId, name }).returning(),
     d.insert(boardMembers).values({ boardId: id, userId: ownerId, role: "owner" }).returning(),
   ]);
   ```

   A list whose length is only known at runtime needs the tuple type spelled out,
   because `atomic` takes a non-empty tuple: `atomic((d) => ids.map((id) =>
   d.update(t).set({...}).where(eq(t.id, id))) as unknown as [BatchItem<"pg">, ...BatchItem<"pg">[]])`
   — guard it with an early return for the empty case.

3. **Read and compute here, then write with guards.** You cannot read a result
   mid-`atomic` and branch on it, so do the reads first and make every write
   re-check in SQL what you read:

   ```ts
   const before = await db.select() /* ... */;         // the version you EXPECTED
   const revisionId = crypto.randomUUID();             // THIS call's own marker
   const mine = sql`exists (select 1 from ${noteRevisions} where ${noteRevisions.id} = ${revisionId}::uuid)`;
   const [, updated] = await atomic((d) => [
     // First, and sourced from the row it guards, so it still sees the OLD version.
     d.insert(noteRevisions).select((qb) => qb.select({ id: sql`${revisionId}::uuid`.as("id"), /* ... */ })
       .from(notes).where(and(eq(notes.id, id), eq(notes.version, expected)))),
     d.update(notes).set({ /* ... */ version: expected + 1 })
       .where(and(eq(notes.id, id), eq(notes.version, expected)))         // the version you READ
       .returning(),
     d.delete(noteLinks).where(and(eq(noteLinks.fromNoteId, id), mine)),  // dependent: `mine`
   ]);
   if (updated.length === 0) throw new StaleWriteError(before);   // zero rows IS the signal
   ```

   Every guard names the version you READ, never `expected + 1`. A caller one
   save behind sees exactly the version its own successful write would have
   produced, so no version value can tell "mine landed" from "somebody else's
   did" — generate the dependent row's id in TS and let `exists (…)` on that id
   be the discriminator on every statement downstream of the first write.

   `select … for update` DOES work inside `atomic` — it is a real transaction —
   and is how you serialise concurrent callers, including when a guard's
   subquery reads a row this unit does not otherwise write: lock that row as the
   unit's first statement. Outside `atomic` it locks nothing: the lock dies with
   its statement.

Two things `tsc` does NOT catch here, both fatal on the first real call:

- an `insert().select()` must list **every** column of the target table, in
  `drizzle/schema.ts` declaration order, defaults supplied explicitly and
  interleaved in position (``id: sql`gen_random_uuid()` ``, ``createdAt:
  sql`now()` ``). Drizzle validates the whole set synchronously at `.select()`
  call time, so a subset compiles, ships, and throws on first use.
- a bare bind parameter in a SELECT target list needs an explicit cast when its
  target column is not text — ``sql`${id}::uuid` ``, `::int`, `::bigint`. An
  untyped `$n` there can resolve to `text`, and `text` has no assignment cast to
  those types.

Never: `db.transaction`, your own `pg.Pool`/`neon()`, or `.for("update")`
outside `atomic`.

- **storage** (`server/_core/storage.ts`): `storagePutUrl(relKey, contentType?, {ownerId?})`
  → `{ uploadUrl, publicPath }` — **`contentType` is mandatory for the actual upload**:
  the platform REJECTS a missing content type, so treat it as required even though the
  parameter is optional in the type signature (only omit it for a `"get"`/`"head"`/`"delete"`
  op, never for `"put"`). Uploads are restricted to a fixed whitelist — see the recipe below.
  `storageCommit(relKey, {ownerId?, name?})` → `FileRecord`;
  `storageGet(relKey)` → `FileRecord | null`;
  `storageListByOwner(ownerId, {limit?, offset?})` → `FileRecord[]`;
  `storageListAll({limit?, offset?})` → `FileRecord[]` (**not** user-scoped — adminProcedure only);
  `storageCountByOwner(ownerId)` → `number`; `storageCountAll()` → `number` (**not**
  user-scoped — adminProcedure only);
  `storageDeleteOwned(ownerId, relKey)` → `boolean`;
  `storageDeleteAnonymous(relKey)` → `boolean` (only deletes a row with NO owner —
  the compliant primitive for "let the visitor remove the attachment they just added");
  `storageDeleteAny(relKey)` → `boolean` (**not**
  user-scoped — adminProcedure only); `serveAppStorage(c)` for the read route.
  Note the owner argument comes FIRST on every owner-scoped function above
  (`storageListByOwner`, `storageDeleteOwned`, `storageCountByOwner`) — it is
  never a field on the options object.
  Failures throw `StorageError` whose `code` is a `StorageErrorCode`:
  `"not_found"` (no such object) · `"forbidden"` (key malformed, or already owned by
  someone else) · `"not_configured"` (storage env vars missing) · `"failed"`
  (platform rejected it — e.g. a content type off the whitelist). Map these to
  `TRPCError`s rather than letting them surface as a 500; `filesRouter` shows how.
  Never handle S3 creds.
- **fetch/email/llm/jobs**: outbound HTTP / mail / AI / scheduled tasks — always
  via these primitives, never raw SDKs (see `server/services/README.md`).
- **publicUrl** (`client/src/_core/public-url.ts` — CLIENT side): `publicUrl(path)`
  → the absolute URL for any link you hand to a HUMAN: a "copy public link" button,
  a URL in an email, a QR code. **Never build one from `location.origin`.** In the
  Studio preview that origin is served by a service worker inside the author's own
  browser tab, so a link built from it 404s for whoever receives it; `publicUrl`
  returns a shareable link there and the app's real public URL once published.
  Links the app only follows itself (router navigation, fetches) need nothing here.
- **internal (do NOT call directly):** `context.ts` / `serve.ts` /
  `index.ts` — wiring; use the primitives above, not these.
- **env** (`server/_core/env.ts`): `env.config(name, fallback?)` and
  `env.secret(name)` read the app owner's own configuration and API keys, set in
  the platform UI under Settings → Environment variables (dev and prod hold
  SEPARATE values). Everything else on `env` is platform-owned — read
  `env.databaseUrl` / `env.jwtSecret` / `env.storage` directly, never through
  these two. Call them WHERE YOU USE THEM, not at module top level: a top-level
  call makes one unset variable take down every page, including the ones that
  don't need it.

## Recipe: file uploads (3 steps — step 3 is the one people forget)

The browser PUTs straight to object storage, so the server never sees the upload
finish. Nothing is listable until you commit it.

1. `storagePutUrl(key, contentType, { ownerId: ctx.user.id })` → `{ uploadUrl }` —
   `contentType` is effectively REQUIRED here: the platform rejects a `"put"` with
   none. It also enforces a fixed whitelist — nothing else is accepted:
   `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`,
   `application/pdf`, `text/plain`, `text/csv`, `application/json`,
   `audio/mpeg`, `audio/wav`, `video/mp4`, `video/webm`. Note `image/svg+xml`
   is deliberately NOT allowed (SVG is a stored-XSS vector), and there is no
   docx/xlsx/zip/markdown support. A rejected content type surfaces as a
   `BAD_REQUEST` TRPCError from `uploadUrl` (see `filesRouter` in `routers.ts`)
   — don't let it fall through as an opaque 500.
2. client `fetch(uploadUrl, { method: "PUT", body: file })`
3. `storageCommit(key, { ownerId: ctx.user.id, name: file.name })` → indexed row

Then `storageListByOwner(ctx.user.id)` renders "my files", and
`storageDeleteOwned(ctx.user.id, key)` removes one. Copy `filesRouter` in
`server/routers.ts` — it is the canonical shape.

Always pass `ownerId` on authenticated paths: without it, one logged-in user can
overwrite another's file (keys are visible in `/app-storage/<key>` URLs). Use an
unguessable key built from a uuid prefix PLUS a sanitized basename of the
caller-supplied name (`` `${crypto.randomUUID()}-${sanitizeBasename(name)}` ``,
as `filesRouter.uploadUrl` does) — a uuid prefix alone does not help if the rest
of the key is attacker-controlled (e.g. a `name` of `"/../someone-elses-key"`).

For a public/anonymous upload with no `ownerId` (e.g. a contact-form
attachment), use `storageDeleteAnonymous(key)` to let the visitor remove it —
never `storageDeleteAny` from a `publicProcedure`, which would let any visitor
delete any file by key.

`/app-storage/<key>` is **unauthenticated** — it 307-redirects to a signed GET
for ANY key in the app's prefix, with no session check. Owner scoping on
`files` protects listing and deleting only, never reading. The URL itself IS
the capability: never store something there that must not leak to anyone who
gets the link.

Rows in `files` are not a guarantee the object still exists: the platform's
owner-facing storage panel can delete objects directly, with no access to this
app's database, leaving a row whose `/app-storage/<key>` 404s. Handle that 404
gracefully in the UI (e.g. broken-thumbnail fallback), don't treat it as a bug.

## Hard rules
- Do NOT edit anything in `_core/` (frontend or backend), the `users` auth columns,
  or the `files` table — `users` and `files` are SYSTEM tables that `_core` reads
  and writes. Add your own business tables alongside them.
- Do NOT read/write the local filesystem at runtime, and do NOT store secrets in
  code — files go through `_core/storage`, secrets through injected env.
- Every user-scoped query MUST filter by `ctx.user.id` (see `server/db.ts`).
- Never `db.transaction` — see "Atomic writes". `.for("update")` only means
  something inside `atomic()`.
- Never pattern-match a database error's `message` — use `isUniqueViolation(e)` (or a
  typed error from `server/db.ts`). Every UNIQUE index a user can collide with (a
  taken name, a double booking, a re-used SKU) needs a `CONFLICT` with wording that
  says what to do next; a 409 the user understands, a 500 they can only retry.
- Business code depends only on `user.id`, never on how auth happened.
- Capabilities the template does NOT support (persistent WebSocket servers,
  long-running workers, native deps): tell the user, don't hack around `_core`.
- Nothing in this repo serves the platform's preview tooling any more. The
  element picker and commenting in Studio's preview come from a script the
  host-router injects into the HTML on its way to the browser, so `vite.config.ts`
  is yours to change freely — there is no plugin or vendored bundle to preserve.
  (Until 2026-09 there was: a `teamily:studio-preview-bridge` plugin and a 70 KB
  `studio/preview-bridge.js`, which reached only projects scaffolded after the
  template carried it and froze at whatever version they got.)
- `storageDeleteOwned`/`storageDeleteAny`/`storageDeleteAnonymous` HARD-DELETE the
  `files` row. A business table with a column referencing `files.id` (e.g.
  `attachmentId: uuid().references(() => files.id)`) MUST specify `onDelete:
  "cascade"` or `"set null"` — the default leaves a dangling FK that makes the
  delete 500 with a Postgres foreign-key-violation instead of removing the row.
- Need a new config value or API key? Write `env.secret("FOO")` in the code, then
  **tell the user to add `FOO` under Settings → Environment variables** in your
  reply. You can never see these values. Do NOT invent one, do NOT hard-code one,
  and do NOT write `/workspace/app/.env` — that file is rebuilt from the database
  every time the preview starts, so anything you put there is gone a second later.

## Testing (verify signal #2)
Tests run with **vitest** (`pnpm test` → `vitest run`; `pnpm typecheck` → `tsc --noEmit`).
Put a test next to the code as `*.test.ts` (e.g. `server/routers.test.ts`) — `vitest.config.ts`
owns the test root and already globs `client/src`, `server`, `shared`. Environment is
**node** (no jsdom): test the business seams, not rendered components.
Minimal server test: import the router, call a procedure through a test caller
with a fake `ctx = { c, db, user }`, assert the returned row is owner-scoped.
Keep tests business-seam-focused — never test `_core`.

## Commands
`pnpm dev` (Vite SPA :3000 + API :3001) · `pnpm build` · `pnpm test` ·
`pnpm typecheck` · `pnpm db:generate` / `pnpm db:migrate`.

## Deleting files and changing migrations
- Delete files with `delete_file`, never `rm` in the shell. The sandbox and the
  workspace sync both ways and NEITHER direction deletes: a file removed only on
  disk is written back by the next sync.
- After changing `drizzle/schema.ts`, run the `apply_migrations` tool — not
  `pnpm db:generate` / `pnpm db:migrate` in the shell. The tool also saves the
  migration files to the workspace; the shell commands do not.
- Never `rm -rf drizzle/migrations` to regenerate. Every regeneration writes a
  new `0000_*` file under a new random name while the old ones come back from
  the workspace, and publishing refuses migrations the journal does not list.

## Reference data vs seed data
- Rows the app needs in order to work — built-in themes, categories, plans, any
  list the UI reads but users do not create — go in through
  `apply_migrations(slug, data_sql=..., data_name=...)`. That makes them a
  migration, and publish applies migrations to prod.
- A seed script (`scripts/seed.ts`, anything you run with `tsx`) only ever
  touches the DEV database. Use it for demo rows; the published app starts
  without them.
- Write `data_sql` so it can meet rows that already exist:
  `INSERT ... ON CONFLICT (slug) DO NOTHING` (needs a unique index on that
  column). To change a built-in row later, pass another `data_sql` with an
  `UPDATE`; never edit a migration that has already run.
- Never `drizzle-kit generate --custom` in the shell: the journal it writes is
  overwritten by the next sync, and publish refuses the orphaned file.
- A list the app ships with can still arrive empty (a failed query, a deleted
  row). Render its empty state; never read `[0]` of it unguarded.
