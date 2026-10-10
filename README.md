# Nexra B.V. — backend

NestJS 12 · TypeScript (ESM, NodeNext) · Prisma 7 · PostgreSQL (17 on port 5433 locally). The API behind the Next.js app in
`../nexra-accounting_frontend`. Plan: [`../docs/15-project-plan.md`](../docs/15-project-plan.md); rules: [`../CLAUDE.md`](../CLAUDE.md).

## Run it

```bash
cd nexra-accounting_backend
npm install                 # also generates the Prisma client (src/generated/prisma)
cp .env.example .env        # then fill in DATABASE_URL (your postgres password), the secrets and SEED_OWNER_*
npm run db:migrate          # creates the "nexra" database if needed and applies the migrations
npm run db:seed             # roles (Owner, Medewerker), pick-lists, the client / person forms + the owner account from SEED_OWNER_*
npm run start:dev           # http://localhost:4000/api   ·   GET /api/health
```

The browser never calls this server directly: the Next.js app proxies `/api/*` to it (`BACKEND_URL` in the frontend), so
cookies stay same-site and there is no CORS. (If something else on your machine already uses port 4000, set `PORT` in `.env`
and `BACKEND_URL` in the frontend's `.env.local` to the same free port.)

The seeded owner signs in with `SEED_OWNER_EMAIL` / `SEED_OWNER_PASSWORD` and must choose a new password straight away.
Without `SMTP_HOST` invitation and password-reset e-mails are not sent — they are written to this server's log, link included.

## Scripts

| Script | What it does |
|---|---|
| `npm run start:dev` | compile + restart on change |
| `npm run build` / `npm run start:prod` | production build (`dist/`) and start |
| `npm run lint` · `npm run format` | oxlint · prettier |
| `npm run db:migrate` | `prisma migrate dev` — create / apply migrations in development |
| `npm run db:migrate:deploy` | apply existing migrations (production) |
| `npm run db:seed` · `db:seed:dev` | reference data · synthetic demo data (never in production) |
| `npm run db:studio` · `db:reset` | browse the data · drop and recreate the database |

There are no test files and no test scripts — the project has none by design.

## Layout

```
prisma/                 schema.prisma, migrations/, seed.ts (reference data), seed-dev.ts (demo data)
prisma.config.ts        Prisma 7 config (schema path, migrations, seed command, DATABASE_URL)
src/
├─ main.ts              global prefix /api, helmet, cookie-parser, trust proxy, shutdown hooks
├─ app.module.ts        imports every infrastructure module once; global pipe / filter / interceptor
├─ lib/                 infrastructure — each a @Global() module + service, never instantiated by hand
│  ├─ config/           env validation (class-validator) + typed AppConfigService
│  ├─ database/         PrismaService (pg driver adapter)
│  ├─ mail/             MailService (nodemailer; without SMTP_HOST the mail is written to the log)
│  ├─ storage/          StorageService (local disk under STORAGE_DIR; an S3 driver can follow)
│  ├─ crypto/           AES-256-GCM encrypt / decrypt, sha256, random tokens
│  ├─ settings/         SettingsService — typed settings (default + min / max in code, values in the DB, cached)
│  ├─ exports/          ExportsService — any list as Excel (exceljs), PDF (pdfmake) or Word (docx), Dutch notation, office name / logo
│  └─ audit/            AuditService — one ActivityLog row per create / update / delete / sign-in
├─ common/              shared building blocks
│  ├─ api-result.ts, interceptors/   every answer is { data } or { data, meta }
│  ├─ filters/          every error is { code, message, fields?, details? } (Prisma errors mapped)
│  ├─ pipes/, validation/   422 with fields as translation keys (validation.required, validation.min|{"min":3})
│  ├─ dto/list-query.dto.ts, pagination.ts   search · page · pageSize · sort=field:dir · period · stats
│  ├─ guards/           global, in this order: DynamicThrottlerGuard → JwtAuthGuard → PermissionsGuard
│  └─ decorators/       @Public(), @RequirePermission('contracts.edit'), @CurrentUser(), @AllowWhileRestricted(), @AuthThrottle()
└─ module/              features, one folder each
   ├─ auth/             sign-in, tokens, sessions, passwords, e-mailed links, two-step verification
   ├─ users/ · roles/   accounts, invitations, per-person access · roles, permission catalogue (src/module/roles/permission-catalog.ts)
   ├─ security-settings/  the policy Ahmad edits in Settings → Security policy (bounds in security-settings.definitions.ts)
   ├─ settings/         Settings → Office, Language & formats, Calendar (+ GET /settings/public) on the settings registry
   ├─ numbering/        running numbers (client number …): prefix, padding, next; atomic allocation
   ├─ lists/            pick-lists and status lookups with Dutch + English names (GET /lookups?keys=)
   ├─ calendar/         Netherlands calendar: holidays, working-day arithmetic, deadlines
   ├─ files/            uploads (type / size checks), authorised download
   ├─ forms/            the admin-defined forms: definitions, drafts, revisions, value validation
   ├─ clients/          clients, their relations, folders / documents, data quality, export (Phase 6)
   ├─ people/           the humans behind owners, directors, contact persons and workers: one record each, restricted values (Phase 6 / 7)
   ├─ employees/        workers = a person employed by a client: grid, form, hourly-rate history, worker folders, export (Phase 7)
   └─ activity/         reads the audit trail, filter options, export   (contracts … follow)
```

## Sign-in, users and roles (Phase 4)

- **Cookies** (all httpOnly, set by this API): `nexra_access` (JWT, 15 min by default), `nexra_refresh` (opaque, only its sha256 is
  stored, path `/api/auth`, rotates on every refresh), `nexra_session` (a marker the Next.js proxy looks at). A refresh token used
  a second time (outside a 20-second two-tab grace) revokes its whole session. Every request also checks the session row:
  revoked, expired, idle too long, account disabled → 401.
- **Endpoints:** `POST /auth/login` (+ `/login/two-factor`), `/logout`, `/refresh`, `GET /auth/me`, `/permissions`, `PUT /auth/me`,
  `POST /auth/password`, `GET /auth/password-policy`, `POST /auth/forgot-password`, `/reset-password/check`, `/reset-password`,
  `/invite/check`, `/accept-invite`, `GET|DELETE /auth/sessions`, `POST /auth/sessions/revoke-others`,
  `POST /auth/two-factor/setup|enable|disable|recovery-codes`; `GET|POST|PUT|PATCH|DELETE /users`, `POST /users/:id/status|resend-invite|reset-password|two-factor/reset`;
  `GET|POST|PUT|DELETE /roles`, `GET /permissions/catalog`; `GET|PUT /settings/security`; `GET /activity`.
- **Permissions:** `@RequirePermission('area.action')` per route; routes without it need only a signed-in person. The owner role always
  has everything; nobody can give anybody (or any role) more access than they hold themselves; the last active owner cannot be
  disabled, deleted or demoted. The owner may send `X-Active-Role: <role key>` to see (and be limited to) what that role sees.
- **Account restrictions:** a temporary / reset / expired password (`mustChangePassword`) or "two-step verification required but not set
  up" limits the session to routes marked `@AllowWhileRestricted()` (`/auth/me`, `/auth/password`, `/auth/two-factor/*`, logout).
- **Security policy:** lockout, rate limits, session lengths, password rules, 2FA policy and upload size are settings with enforced
  minimum / maximum (`security-settings.definitions.ts`); a change applies at once (no restart). Rate limiting is per IP — behind
  Vercel → Render set `TRUST_PROXY_HOPS` correctly, otherwise everybody looks like the proxy.
- **Audit:** every sign-in, failed sign-in, password and two-step change, invitation, user / role / policy change is logged;
  secrets are redacted by `AuditService`.

## Core engines (Phase 5)

- **Settings registry** — a group of settings is a definition in code (`{ type, default, min, max, format, options }`) registered with
  `SettingsService.register(namespace, definitions)`; only values that differ from the default are stored. `GET|PUT /settings/office|locale|calendar`,
  `GET /settings/public` (office name + logo + default languages, any signed-in person). Format checks (`src/common/validation/formats.ts`):
  e-mail, phone (`+31…`), URL, postcode, KvK, BTW, IBAN, BSN / RSIN 11-test, loonheffingennummer — values are stored normalised.
- **Numbering** — `NumberingService.register(key, …)`, `allocate(key)` (atomic), `registerFloor(key, fn)` so a number already in use is never handed out.
- **Lists** — `ListsService.lookups(keys, locale)`, `activeCodes(key)`; the seed (`prisma/seed-data/lists.ts`) only creates what is missing.
- **Calendar** — inject `CalendarService`: `isWorkingDay`, `addWorkingDays`, `nextWorkingDay`, `workingDaysBetween`, `moveDeadline`. Every date
  rule in the app goes through it (never "+ 30 days").
- **Files** — `POST /files` (multipart, `purpose` + `area`), `GET /files/:id[/download?inline=1]`, `DELETE /files/:id` (deactivates). Features that
  own a file use `FilesService.assertUsable / link / retire`. Allowed types and purposes: `src/module/files/files.constants.ts`.
- **Forms** — a feature that saves records with admin-defined fields imports `FormsModule` and calls
  `FormValidationService.checkOrThrow(entity, patch, existingData, user.matrix)`, merges the cleaned values into `data`, and filters what it
  returns with `valuesFor(doc, data, user.matrix)`. New kinds of record are added to `FORM_ENTITIES` (`form-entities.ts`) and seeded in
  `prisma/seed-data/forms.ts`. A BSN field is always limited to the `personal_data` permission area.
- **Exports** — build an `ExportTable` (`{ title, subtitle, columns, rows, locale }`) and return `exports.download(response, table, format, user.name)`
  from a `GET …/export` route (see `users.controller.ts`, `activity.controller.ts`); check `exports.assertSize(rows.length)` first.

## Clients (Phase 6)

- `Client` keeps the fields the logic reads in columns (`number`, `name`, `legalForm`, `kvk`, `vatNumber`, `responsibleUserId`, status) and every other field of the
  client form in `data` (`client-record.ts` maps field keys to columns). `Person` + `ClientPerson` (role, start / end), `ClientRelation`, `Folder`, `UniqueFieldValue`.
- **Reading** — `GET /clients` builds its SQL in `forms/dynamic-query.ts` (search over `searchText`; `f.<field key>` filters for fields marked "filter"; `sort=<key>:dir`).
  `FormRecordsService` (forms module) is what every record module shares: encrypting restricted values (`enc:` prefix, `isEncryptedField`), the "unique" switch
  (`checkUnique` → 422 naming the holder, `claim` inside the saving transaction), the search text and audit snapshots without secrets.
- **Saving** — validate with `FormValidationService.check`, split into columns / `data` (`splitValues`), encode, claim unique values and create the folders in one
  transaction; every change writes an audit entry. A client is never deleted: `POST /clients/:id/status`.
- **Numbers** — the `client` sequence is three digits wide; `NumberingService.normalize()` pads a typed number, `registerFloor()` keeps the suggestion above every number in use.
- `npm run db:seed:dev` adds 28 synthetic demo clients (people, relations, folders) to a development database.

## Employees (Phase 7)

- **A worker is an employment of a person.** `Person` (module `people`: name, BSN, IBAN, address, ID document — the person form) + `Employee` (`personId`, `clientId`, `functionCode`,
  `startDate`, `endDate`, status as `isActive`, every other field of the employee form in `data`) + `RateHistory` (`rate`, `validFrom`, `note`; today's rate = the latest row that has
  started — `currentRateSql()` computes it in SQL so lists can sort and filter on it) + `Folder.employeeId`. Nothing is deleted: `POST /employees/:id/status`.
- **Saving a worker saves the person too** — `PeopleService.planCreate / planUpdate` check the person form without writing; `EmployeesService` validates the employee form, merges both
  sets of problems (the person's keys get a `person.` prefix) and commits everything in one transaction; a taken BSN is a 422 that names the holder (`details.conflicts`).
- **Routes shared with Clients** use `@RequireAnyPermission('clients.view', 'employees.view')` (handler-level, any-of): `GET /people/:id`, `/people/lookup`, `GET /clients/lookup`.
- **Folders** — `EmployeeFoldersService`: `<client folder>/<contracts folder>/<person name>`, `0-GESTOPT` for leavers, moved when the client changes, renamed with the person
  (`PeopleService.onChanged`). A worker's files are `entityType=employee`; `GET /clients/:id/documents` includes them only for people with `employees.view`.
- **List** — `GET /employees` joins `Employee`, `Person` and `Client`; filters are `f.<key>` (employee form) and `f.person.<key>` (person form); sort keys `name`, `client`, `status`,
  `updatedAt`, `<key>`, `person.<key>`; `expiring=true`; `stats=true`. Documents expiring = date fields of the person form whose key ends in `_expiry`, within `documents.expiryWarningDays`
  (`GET|PUT /settings/documents`, default 90) — only for people who may see those fields.
- `npm run db:seed:dev` also adds 94 synthetic demo workers (with rate history, folders, a few expiring documents).

New building blocks are created with the Nest CLI, always without spec files:
`npx nest g module module/<name>`, `npx nest g service module/<name>/<name> --flat --no-spec`, …
(imports keep their `.js` suffix — the project is ESM).

## Conventions

- **Database:** cuid ids, `createdAt` / `updatedAt`, `isActive` + `deactivatedAt` / `deactivatedById` / `deactivationReason`
  on main records (nothing is hard-deleted), `data Json` for the admin-defined dynamic fields, `searchText` for search.
  Extensions `citext`, `pg_trgm`, `unaccent` come with the first migration. Prisma only through the injected `PrismaService`.
- **Responses:** controllers return plain values (wrapped as `{ data }`) or `paged(rows, pageMeta(total, query))` for lists.
- **Audit:** every create / update / delete / activate / deactivate calls `AuditService.log(...)`; passwords, tokens, BSN and
  IBAN are never written to the log.
- **Config:** feature code never reads `process.env` — it asks `AppConfigService`. A bad `.env` stops the server at boot.
- **Secrets:** `.env` is never committed; `ENCRYPTION_KEY` must be kept safe — losing it makes encrypted values unreadable.
