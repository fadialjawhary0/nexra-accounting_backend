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
| `npm run db:seed` · `db:seed:dev` | reference data (adds what is missing to an existing database) · synthetic demo data (never in production) |
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
│  ├─ documents/        DocumentsService — a Word template + a record → filled Word (docxtemplater) and PDF (LibreOffice, one at a time)
│  ├─ queue/            QueueService — pg-boss in PostgreSQL (its own `pgboss` schema): `@QueueProcessor()` / `@QueueWorker()` workers found through DiscoveryService (Phase 11)
│  ├─ ai/               AiService — the one door to OpenAI: strict JSON answers, usage + cost per call, monthly budget with a hard stop (Phase 11)
│  ├─ pdf/              PdfService — read the fields of a fillable PDF, fill it (pdf-lib + embedded font), make a page of positioned text (labels) (Phase 13)
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
   ├─ calendar/         Netherlands calendar: holidays (also for one client), working-day arithmetic, deadlines
   ├─ files/            uploads (type / size checks), authorised download
   ├─ forms/            the admin-defined forms: definitions, drafts, revisions, value validation
   ├─ clients/          clients, their relations, folders / documents, data quality, export (Phase 6)
   ├─ people/           the humans behind owners, directors, contact persons and workers: one record each, restricted values (Phase 6 / 7)
   ├─ employees/        workers = a person employed by a client: grid, form, hourly-rate history, worker folders, export (Phase 7)
   ├─ templates/        Word templates (versions, merge-field helper, preview with sample data) (Phase 8)
   ├─ contracts/        contracts: form, warnings, documents, send / sign / terminate / renew, reminder providers (Phase 8)
   ├─ reminders/        the reminder engine: providers register, rules are data, the hourly job (Phase 8)
   ├─ notifications/    in-app notifications (text key + params, per reader's language), preferences, e-mail digest (Phase 8)
   ├─ messaging/        WhatsApp message templates and the click-to-chat link (Phase 8)
   ├─ hours/            hour entries, the week grid, closed periods, surcharge rules, the pay calculator (Phase 9)
   ├─ salary-statements/  salary statements: preview, make, cancel, Word + PDF files, exports (Phase 9)
   ├─ invoices/         invoices (incoming / outgoing, credit notes), numbering, Word + PDF, the markup report (Phase 10)
   ├─ counterparties/   the companies that are not clients: staffing companies, hirers (Phase 10)
   ├─ reconciliation/   hours = pay = invoices: the pure allocation + reconcile functions, the report (Phase 10)
   ├─ inquiry/          the worker inquiry (one worker, one month) and its ZIP bundle (Phase 10)
   ├─ imports/          spreadsheet and file imports: column wizard, saved layouts, the AI file queue, the review list, saving (Phase 11); the AI inbox (17-10-2026)
   ├─ ai/               GET /ai/status · /usage, POST /ai/test (the AI settings are GET|PUT /settings/ai) (Phase 11)
   ├─ document-settings/  document types (valid-until rules, naming patterns), the folder template, required documents (Phase 12)
   ├─ documents/        the Documents page: list + search in contents, adding with versions, links, requirements, previews, text reading (queue `document-index`), reminders (Phase 12)
   ├─ official-forms/   the library of official PDF forms: editions, the field mapping, filling, the log of sent forms, AI fill from a photo, follow-up reminders (Phase 13)
   ├─ address-book/     the addresses post goes to and the envelope labels (A5 / DL / C5) (Phase 13)
   ├─ inspections/      versioned checklists, inspections, the matching engine, readiness, the sample, the bundle for the inspector, handovers, AI reading of a request, reminders (Phase 14)
   ├─ taxes/            the VAT tracker (steps, rows per client and period, ticks, bulk, deadlines), income-tax / corporate-tax returns with extensions, employer registrations, the nightly rows, reminders (Phase 15)
   ├─ tasks/            tasks: filters + counters, links to records, subtasks, messages, the `task_due` reminder, search (Phase 16)
   ├─ agenda/           appointments (meeting / team / reminder), guests, the reminder job, and the combined calendar feed (Phase 16)
   ├─ dashboard/        GET /dashboard (a section per area the person may open + the attention list) and GET /nav/badges (Phase 16)
   ├─ search/           the search registry: GET /search, typo tolerance; the providers live in the feature modules (Phase 16)
   ├─ reports/          the reports centre: 17 reports, periods, screen + Excel / PDF / Word, export presets (Phase 16)
   └─ activity/         reads the audit trail, filter options, export, the nightly clean-up of old entries (Phase 16)
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

## Documents, contracts, reminders (Phase 8)

- **Documents** (`src/lib/documents`, `@Global`) — `DocumentsService.render(bytes, context)` fills a Word file with **docxtemplater** (unknown tags are left as `{tag}` and reported; `inspect(bytes)` lists
  the tags a file uses), `toPdf(bytes)` converts with **LibreOffice** headless behind a `SerialQueue` (one conversion at a time). `LIBREOFFICE_PATH` is optional (the usual install folders and `soffice`
  on the PATH are tried); without LibreOffice the Word file is still made and the PDF is reported as unavailable (`pdf_unavailable`).
- **Templates** — `Template` + `TemplateVersion` (a Word file per version, its detected tags). `MergeFieldsService` builds the fields a template may use **from the form definitions** (`contract.*`,
  `employee.*`, `client.*`, `office.*`, `document.*`; all values pre-formatted in the template's language; restricted / encrypted fields are never offered). Permission area `templates`.
- **Contracts** — `Contract` keeps `type`, `startDate`, `endDate`, `status` in columns and the rest of the contract form in `data` (`contract-record.ts`); `ContractLifecycleService` does send / sign /
  terminate / cancel / reopen / renew and the nightly `endExpired` job; `ContractWarningsService` gives the advice (codes + params, switchable in `GET|PUT /settings/contracts`);
  `ContractDocumentsService` makes the Word + PDF, letters and the signed scan and files them in the worker's folder (`<template>_<client>_<worker>`). A signed contract updates the worker (setting);
  a worker who leaves ends their contracts (`EmployeesService.onStopped`). `ContractRemindersService` registers the four reminder providers.
- **Reminders** — `RemindersService.register(provider)`; a rule (`ReminderRule`) is data: trigger, offsets, calendar or working days, recipients (`roles`, `users`, `responsible`), channels. `ReminderSent`
  keeps it idempotent; the `@nestjs/schedule` job runs **every hour at :05** and acts in the hour set in `reminders.runHour` (default 7) when `reminders.enabled`; `POST /reminders/run` runs it now.
  A provider returns `ReminderItem`s (`subjectType`, `subjectId`, `dueOn`, `params`, `link`); recipients are filtered by what they may see.
- **Notifications** — `NotificationsService.deliver(deliveries)` stores a text key + params (`notification-texts.ts`), rendered in the reader's language by the API; per-person preferences per type;
  `GET /notifications`, `/unread-count`, `POST /read-all|:id/read|:id/unread`. E-mail goes out as one digest per person per run.
- **Messaging** — `MessageTemplate` (Dutch + English text with merge fields, audience worker / client); `POST /messaging/whatsapp-link` fills a message for a contract and returns the `wa.me` link; nothing is sent.
- Seed: lists (`contract_type`, `contract_status`, `termination_reason`, `template_kind`, `notification_type`, `notification_severity`), the `contract` form, nine **synthetic** starter templates
  (`prisma/seed-data/templates.ts`), seven WhatsApp messages, four reminder rules; `npm run db:seed:dev` adds demo contracts.

## Hours and salary statements (Phase 9)

- **Hours** (`src/module/hours`) — `HourEntry` = worker + the **employer client of that day** + date + `minutes` (break already off) + optional `startTime` / `endTime` / `breakMinutes` + `rate` (the day's
  hourly rate) + `source` + the `hour_entry` form values in `data`; a day may hold several entries. `HoursService` serves the **week grid** (`GET /hours/week`: the days from the calendar, one row per worker with
  seven cells, totals) and **saves cells** (`PUT /hours/cells`: each cell stands alone and answers `ok` / an error code; what a cell may do — add, change, clear — is checked against `hours.create` /
  `edit` / `delete`), copies a week, gives a worker's month (`GET /hours/month`) and lists / exports entries. Hours and clock times are `hours-time.ts` (minutes, `HH:MM`, ISO weeks, half-up `roundDiv`).
- **The day's rate** — taken from `RateHistory` when the hours are saved and **re-applied to open days** whenever the history changes: `EmployeeRatesService.onChanged(listener)` runs `HoursService.repriceFrom`
  inside the same transaction; closed days keep their rate. `POST /hours/reprice` does it on request.
- **Closed periods** — `PeriodLocksService`: a `PeriodLock` per worker (`manual` or made by a `statement`). Every write checks it (`assertEditable`): a closed day needs `hours.approve` **and** a reason, otherwise
  `period_locked` / `reason_required`; the reason goes into the audit entry. `POST /hours/locks` (a month, or from – to; for workers or every worker of a `clientId`), `POST /hours/locks/:id/release`.
- **Pay** — `pay-calculator.ts` is a **pure function** (entries + active rules + the calendar's day kinds + allowance % → lines and totals in cents; no floats, half-up rounding), used by the preview, the
  statements and the worker's month, so they agree to the cent. Rules (`SurchargeRule`, `GET|POST|PATCH|DELETE /hours/surcharges`, `settings.view` / `settings.edit`): weekend (days), holiday (a holiday beats
  a weekend), overtime (per day / per ISO week after N minutes — the week is counted whole, also outside the period), evening (a window, needs clock times); percentage of the rate or an amount per hour;
  optionally one client. `HoursPayService.preview` adds the **blockers** (`rate_missing`, `no_hours`, `statement_overlap`) and **advice** (`outside_employment`, `outside_contract`, `day_too_long`,
  `period_in_future`, `evening_needs_times`); the holiday allowance % and vacation build-up come from the worker's latest started contract, else `GET|PUT /settings/hours` (`hours.*`).
- **Wages are restricted** — `rate`, amounts and totals are only returned to people with `salary_statements.view` (`hours.view` alone gets hours, never money).
- **Salary statements** (`src/module/salary-statements`) — `GET /salary-statements/preview`, `POST /salary-statements` (freezes the lines in cents, makes the `PeriodLock`, then the documents),
  `POST /:id/documents` (again), `POST /:id/cancel` (reason; releases the lock), `GET` list / one / `…/export`, `GET /candidates` (the workers of a client with hours in a period — the screen makes the
  statements one by one). `StatementDocumentsService` fills the **`salary_statement` template** (`MergeFieldsService.forStatement`, merge group `statement` in `templates/statement-merge.ts`: totals, flags,
  and the `{#statement.lines}…{/statement.lines}` table loop) → Word + PDF filed in the worker's folder (`EmployeeFoldersService`); without a template the plain export table is used.
- Permission areas (group **money**): `hours` (view / create / edit / delete / export / approve) and `salary_statements` (view / create / delete / export) in `permission-catalog.ts`.
- Audit: cell changes are one entry per worker per request (`entityType` `hours`, before / after day → minutes); statements (`salary_statement`) and rules (`surcharge_rule`) have their own.
- Seed: the `hour_entry` form, the `salary_statement` item of `template_kind`, five **switched-off** example surcharge rules (`prisma/seed-data/surcharges.ts`), the starter "Loonstaat" template;
  `npm run db:seed:dev` adds six weeks of demo hours (no statements).

## Invoices, reconciliation and the worker inquiry (Phase 10)

- **Invoices** (`src/module/invoices`) — `Invoice` (incoming / outgoing, invoice / credit; the office's client + the other party = a `Counterparty` **or** another client) with `InvoiceLine`s (hours · markup · other).
  `InvoicesService` creates / edits drafts and received invoices (the lines are validated: a worker must belong to the right client, hours need a period and a time, the amount defaults to hours × rate),
  **issues** an outgoing draft (`InvoiceNumberingService` → per client and year, gap-free; `PeriodLocksService.lockForInvoice`; `InvoiceDocumentsService` fills the `invoice` template → Word + PDF filed with the client),
  moves invoices along (`POST /:id/status`: received → checked → paid, sent → paid, and back), **cancels** (incoming) and **credits** (a credit note for the whole invoice). The money is whole cents (`invoice-calc.ts`).
  Permission area `invoices` (view / create / edit / delete / export / approve); **approve** = issue, mark as checked, take back.
- **The hours ↔ invoice link is derived, never stored** — `src/module/reconciliation/allocation.ts` (a pure function) lets the counted lines (`COUNTED_INVOICE`: kind invoice, status sent / paid / received /
  checked, no standing credit note) cover a worker's registered hours day by day, per direction; `reconcile.ts` (pure) puts registered · paid · invoiced side by side for a worker kind (`work_kind` on the employee form:
  own · hired out · hired in) and names the causes (`not_paid`, `paid_more`, `not_invoiced`, `over_invoiced`, `line_math`). `ReconciliationService` is the loader (it widens the window until lines that share hours are
  allocated together); `GET /reconciliation[/export]`, `lineCoverage(invoiceId)` for the invoice screens, `linePay` for the markup report.
- **Closing a month** (`PeriodLocksService.close`) runs the reconciliation first: with differences the answer is `reconciliation_mismatch` and a `reason` is needed. Locks of kind `invoice` follow the invoice
  (`lock_belongs_to_invoice` stops a manual release).
- **Markup report** (`MarkupReportService`, `GET /invoices/markup[/export]`, needs `invoices.view` + `salary_statements.view`): billed minus the pay of the same hours, in € and % of the pay; a line counts in the period it starts.
- **Worker inquiry** (`src/module/inquiry`, `GET /employees/:id/inquiry`, `/export`, `/bundle`; needs `hours.view`): the days with where / paid / billed / invoice numbers, the month's statements and invoices, the
  verdict; money and invoices only for people who may see them; the bundle is a ZIP (`pizzip`) with the overview, the statement PDFs and the invoice documents.
- **Companies** (`src/module/counterparties`) — form entity `counterparty`; duplicates by KvK (else name) are refused; switched off, never deleted. Settings → Invoices is `GET|PUT /settings/invoices`
  (`invoices.vatPercent`, `paymentDays`, `gAccountPercent`, `numberFormat`, `numberPadding`).
- Templates: kind `invoice` with merge groups `invoice` and `recipient` (`templates/invoice-merge.ts`, `MergeFieldsService.forInvoice`); file purpose `invoice_document`; the client's `hours_invoices` folder.
- Seed: lists `work_kind`, `invoice_direction`, `invoice_kind`, `invoice_status`, `invoice_line_kind`, the `invoice` item of `template_kind`, forms `counterparty` and `invoice`, the `work_kind` field of the employee
  form, the starter "Factuur" template; `npm run db:seed:dev` adds two demo companies, a staffing company's received invoice and an outgoing draft.

## Imports, the queue and the AI (Phase 11)

- **Queue** (`src/lib/queue`) — pg-boss 12 on the same PostgreSQL (it creates its own `pgboss` schema at start). A worker is a method decorated `@QueueWorker({ queue, concurrency })` inside a class decorated
  `@QueueProcessor()`; `QueueService` finds them with Nest's `DiscoveryService`. Queues: `import-file` (one job per file, concurrency = the setting `ai.concurrency`, 3 tries, back-off from 30 s), `import-sheet`
  (check / save a spreadsheet), `import-accept` (save files in bulk), `import-inbox` (read the message of the AI inbox before its files). Work that sees a restart is picked up again (`ImportsService.recover()` at start).
- **AI** (`src/lib/ai`) — `AiService.extract({ feature, tier, instructions, text | images | files, schemaName, schema })` returns an object that fits the schema or throws an `AiError` (`ai_*` codes, also the translation
  keys of the screens). OpenAI's Responses API with strict JSON schemas, `store: false`; the key is `OPENAI_API_KEY` (and `OPENAI_BASE_URL` for a proxy) read by `AppConfigService.openai`. Each call adds an `AiUsage` row with
  tokens and an estimated cost (`ai.pricing.ts` list prices, or the prices typed in Settings → AI); the month's budget warns at a percentage and **stops the AI at 100 %**. Settings: `AI_DEFINITIONS`
  (`ai.settings.ts`) → `GET|PUT /settings/ai`; `GET /ai/status | usage`, `POST /ai/test`. **No key in `.env` = the import still files by folder and file names; spreadsheets never need the AI.**
- **Imports** (`src/module/imports`, permission area `imports`: view · create · edit · delete · export · approve) — `ImportJob` + `ImportItem` (+ `ImportMapping` for saved column layouts, `StoredFile.docType` / `docDate`).
  - *Spreadsheets* (`sheet-*.ts`): `POST /imports/spreadsheet` → `GET /imports/:id/sheet` (sheet, header row, proposed mapping, the fields of the target from the **live form definitions**) → `PUT /imports/:id/setup`
    → `POST /imports/:id/check` (background; nothing is saved) → `PATCH /imports/:id/items/:itemId` to correct a row → `POST /imports/:id/commit` (background; the person's own permissions, the normal services). Targets
    `client` (+ its owner), `employee`, `hours` (a row per day or per worker with weekday columns); duplicates policy `skip · fill · overwrite`; `ImportMapping` layouts; xls / ods through LibreOffice.
  - *Files* (`document-*.ts`, `classification-rules.ts`): `POST /imports` → `POST /imports/:id/files | zip` → `POST /imports/:id/start` → per file `import-file`: read by code (`unpdf`, Word, text) → rules (client
    folder `<nr>- `, `0-GESTOPT`, dated folders, file-name patterns) → AI sorting (quick model) → AI reading with a schema built from the form definitions → `DocumentEvaluatorService` (matching, merging fill-only,
    warnings) → `review`. Then `PATCH …/items/:itemId`, `POST …/items/:itemId/accept | reject | reread`, `POST /imports/:id/accept` (everything that is safe). `DocumentAcceptService` makes the records through
    `ClientsService`, `PeopleService`, `EmployeesService`, `ContractsService` + `ContractLifecycleService.sign`, `InvoicesService`, `CounterpartiesService`, `HoursService` (as the accepting person) and files the
    document with `DocumentFilingService` (worker folder or client folder, area `personal_data` for IDs and permits).
  - Job lifecycle `draft → processing → ready → done` (or `paused`, `cancelled`); `GET /imports/:id/report` exports the whole import and `GET /imports/export` the history list (Excel / PDF / Word). Every create / start / pause / resume / cancel / accept / reject / commit is audit-logged.
  - *The AI inbox* (17-10-2026; `inbox-*.ts`): a message to the box on the dashboard is a job of kind `inbox` — `POST /imports/inbox { instruction }` → `POST /imports/:id/files` (optional) →
    `POST /imports/:id/start` → queue `import-inbox` (`InboxReaderService`, activity `understanding`): AI feature `inbox` reads the plan (`inbox-kinds.ts`: tasks, appointments, new worker, worker change,
    worker leaves, client; the client / worker / employment of its files), one more call per worker or client reads its fields with the live forms; every action becomes an `ImportItem` of kind `action`
    with a `target` (`task · event · employee · employee_stop · client`), then the files go through `import-file` as above (the message as a hint, its client as the client of the files). `InboxActionsService`
    checks an action and accepts it through `TasksService`, `AgendaEventsService`, `EmployeesService` (create / update / `setStatus`) and `DocumentAcceptService.makeClient`, as the accepting person. A message
    the AI could not read: `POST /imports/:id/message` reads it again. `GET /imports?kind=inbox&mine=true` is the dashboard's list. Notices `inbox.review` / `inbox.failed`; the activity log names it `inbox`.
    Migration `20261017142648_ai_inbox` (`ImportItem.target`).
- Settings → Import is `GET|PUT /settings/imports` (`imports.maxFilesPerImport`, `maxZipMegabytes`, `skipKnownFiles`, `duplicates`); `GET|POST|PATCH|DELETE /imports/mappings` for the saved layouts.
- Seed: five system layouts (`prisma/seed-data/import-mappings.ts`), the notification texts of imports and the AI budget. Migration `20261012090000_imports`. (The document types the import files by are a table since Phase 12.)
- **Environment:** `OPENAI_API_KEY` (optional, see `.env.example`). Nothing else to install: pg-boss needs no Redis and no Docker.

## Documents (Phase 12)

- **Settings** (`src/module/document-settings`, no own permission area: reading the types is open to every signed-in person, changing needs `settings.edit`) — `DocumentType` (who it is for, validity `none · age · date · field`, standard
  folder, naming pattern, versions, personal data; `isSystem` types — the 14 codes the import and the generators know — cannot be switched off), `FolderTemplate` (three levels; `createFor(tx, client)` for a new client,
  `apply()` for existing ones) and `RequiredDocument` (type + who + a condition in the form builder's language over `client.*` / `employee.*` / `person.*`). `GET|POST|PATCH /document-types`, `/folder-templates`, `/required-documents`.
- **The page** (`src/module/documents`, area `documents`: view · create · edit · delete · export; what is visible follows the area of the file — `viewableAreas(matrix)` in `files.constants.ts`) —
  `DocumentsService` (list with the search over name / client / worker / type / **text**, details, change, remove / restore, versions, links, folders, export), `DocumentIntakeService` (adding: type → folder, area, name,
  duplicate check, `replaces` = next version; `suggest` from file names; `current`), `DocumentVersionsService` (the chain; also used by the import filing), `DocumentRequirementsService` (missing / expired / expiring, the
  overview), `DocumentViewService` (names, validity and versions for a page of files — one query each, never per row), `DocumentPreviewService` (PDF / image / text as they are, Word / Excel through LibreOffice, cached
  as `previews/<uuid>`), `DocumentTextService` + queue `document-index` (text for the search; `lib/documents/document-reader.service.ts` reads PDF, Word, Excel, OpenDocument, PowerPoint, RTF, text), `DocumentRemindersService`
  (`document_expiry`, `document_age`, `worker_document_expiry`). `GET|POST /documents`, `GET|PATCH|DELETE /documents/:id`, `POST …/restore | current | read | links`, `GET …/preview`, `GET /documents/overview | requirements |
  folders | current`, `POST /documents/suggest`, `GET /documents/export | requirements/export`.
- **`StoredFile`** keeps `clientId` (set by `FilesService` whenever a file is placed — `store`, `upload`, `place`, `file`, `link`), `docType`, `docDate`, `validUntil`, `rootId` / `version` / `isCurrent`, `previewKey`;
  `FilesService.tag()` says what kind of document a generated or placed file is and links it to a record (contracts, invoices, salary statements do). `DocumentLink` and `DocumentText` hang on it.
- Validity is one pure function (`document-settings/document-validity.ts`): `age` = date + months, `date` = typed, `field` = the person's date field; status `valid · expiring · expired · none`. The workers' grid reads the
  fields the types name (`DocumentTypesService.fieldKeys()`).
- Seed: 7 standard folders, 17 types, 4 required documents, 3 reminder rules (`prisma/seed-data/documents.ts`, `document-reminder-defaults.ts`). Migration `20261012120000_documents` copies the old lists `document_type`
  and `client_folder` into the tables, tags existing files with their client and type, deletes the lists and gives the staff role `documents → view`.

## Official forms and post (Phase 13)

- **PDF layer** (`src/lib/pdf`, `@Global`) — `PdfService.inspect` (fields with kind, page, options, max length, the PDF's own explanation, XFA flag), `fill` (values by field name; drops XFA, embeds Roboto so `ë é €` print,
  optional flatten, returns what was `unknown` / `truncated` / `failed`), `textPage` (a page of text blocks at millimetre positions). A PDF it cannot use is a `PdfError` (`pdf_encrypted · pdf_unreadable · pdf_no_fields`
  = translation keys). Packages `pdf-lib`, `@pdf-lib/fontkit`.
- **The library** (`src/module/official-forms`, area `official_forms`: view · create = fill in · edit = library, editions, mappings, addresses · delete = switch off / take out of the log · export) —
  `OfficialFormsService` (the forms), `OfficialFormVersionsService` (upload an edition with `copyMapping`, read it, save its mapping, the blank), `FormSourcesService` (the values a mapping may read, **from the live
  form definitions** — `client.*`, `person.*`, `employee.*` — plus computed ones and `office.*`, `form.*`, `period.*`; the people and workers of a client; resolving one value for one subject with the caller's own
  field permissions), `FormFillService` (`prepare` / `preview` / `submit`), `FormSubmissionsService` (the log, follow-up days, export, labels), `FormAiService` (photo / PDF → suggestions, feature `form_fill`),
  `OfficialFormRemindersService` (trigger `form_follow_up`). Pure helpers: `form-mapping.ts` (the mapping model + `sanitizeMapping`), `form-values.ts` (formats, tests, choices), `form-fields.ts`.
  Routes: `GET|POST /official-forms`, `GET|PATCH /official-forms/:id`, `POST …/status`, `GET /official-forms/export | sources | subjects`, `POST …/versions`, `GET …/versions/:versionId`,
  `PUT …/versions/:versionId/mapping`, `GET …/versions/:versionId/blank`, `POST …/prepare | preview | submissions | read-source`; `GET /form-submissions`, `GET|PATCH /form-submissions/:id`, `POST …/status`,
  `GET …/:id/label`, `GET /form-submissions/export`.
- **The address book** (`src/module/address-book`) — `AddressBookService` (CRUD, switch off, export; `addressLines()` writes an address as on an envelope), `AddressLabelsService` (label PDFs; sizes and the position of
  the recipient in `address-book.constants.ts`; Settings group `post`: `defaultLabel`, `printSender`, `textSize`, `offsetX`, `offsetY` — `GET|PUT /settings/post`). `GET|POST|PATCH /address-book`, `POST …/status`,
  `GET …/export | label-settings`, `GET …/:id/label?size=a5|dl|c5&sender=`.
- **A filled form** is filed as a document of the client (`FilesService.store`, purpose `form_document`, or `form_document_personal` when a sensitive value is in it; document type `form`, standard folder *Formulieren
  Belastingdienst*, name by the form's pattern), linked to the worker, and logged as a `FormSubmission` with a snapshot of the values that are **not** sensitive. Showing a sensitive value to the person filling in is
  audited as `revealed`. The follow-up day = the sent day + `followUpDays`, moved to a working day (`CalendarService.moveDeadline`).
- Seed: the lists `form_submission_status` and `address_category`, five addresses and **six forms as made-up fillable example PDFs with their mapping** (`prisma/seed-data/official-forms.ts`, `official-form-pdfs.ts`; each seeded
  mapping is checked with `sanitizeMapping` when seeding), the reminder rule `form_follow_up`. Migration `20261012124633_official_forms` (four tables; gives the staff role `official_forms → view, create`).

## Inspections (Phase 14)

- **What is stored and what is worked out.** `ChecklistTemplate` → `ChecklistVersion` (an *edition*: `sections` + `items` as JSON, `draft | published`, a published edition never changes) is what an inspector asks for; `Inspection`
  (number `CTR-0001`, client, kind and body from the lists `inspection_type` / `inspection_body`, status, date, the edition it uses) holds the decisions (`InspectionItem`, `InspectionItemFile`), `InspectionFollowUp`,
  `InspectionHandover`, a **snapshot** of the checklist when it was closed, and the dated folder. **What is ready is never stored** — `inspection-matching.ts` (pure) works it out from the client's documents.
  Documents carry the period they are about (`StoredFile.periodFrom / periodTo`). Area `inspections` (view · create · edit · delete = switch off · export = the bundle and the exports).
- **Files** (`src/module/inspections`): `checklist-doc.ts` (the shape of an edition, `sanitizeDoc` — problems come back as `sections.<n>.<part>` / `items.<n>.<part>` — period rules, cut-offs, scopes),
  `inspection-matching.ts` (periods, freshness, cut-offs, per-subject evaluation, the summary), `inspection-context.service.ts` (loads files, workers, parent chains and the sample in batches), `bsn-scan.ts` (the 11-test),
  `ChecklistTemplatesService` (+ controller: checklists, editions, drafts, publishing, export), `InspectionsService` (list + counters, create with numbering, change, status + snapshot, recurrence, follow-ups, export),
  `InspectionChecklistService` (the checklist view, decisions, lines by hand, export), `InspectionReadinessService`, `InspectionSampleService`, `InspectionFoldersService` (`Controles / <body> / <dd-mm-yyyy> / <part>`),
  `InspectionBundleService` (check, ZIP, merged PDF, the handover log), `InspectionRequestAiService` (feature `inspection_request`), `InspectionRemindersService` (`inspection_upcoming`, `inspection_response_due`,
  `inspection_follow_up`). The condition language of the lines is the form builder's (`module/forms/condition-check.ts`, shared with the required documents).
- **Routes:** `GET|POST /inspections`, `GET /inspections/export | readiness | readiness/export`, `GET|PATCH /inspections/:id`, `POST …/status | active | plan-next`, `GET …/checklist | checklist/export | sample | sample/export | handovers`,
  `PUT …/items/:code`, `PUT …/lines/switch` (`{ codes, on }` — lines on / off for this inspection), `PUT …/items/:code/files`, `POST|PATCH|DELETE …/custom-items`, `POST|PATCH|DELETE …/follow-ups`, `POST …/handovers | bundle/check | bundle | request/read | request/apply`;
  `GET|POST|PATCH /checklist-templates`, `POST …/:id/activate | deactivate`, `GET …/choices | options | export`, `GET …/:id/versions/:versionId`, `POST …/versions`, `PUT …/versions/:versionId`, `POST …/versions/:versionId/publish`,
  `DELETE …/versions/:versionId`; `GET|PUT /settings/inspections` (`recurrenceMonths`, `planNextOnClose`, `createFolder`, `sampleSize`, `sampleLookbackMonths`, `bsnCheck`, `maxBundleMegabytes`).
- **Bundle:** `bundle/check` lists what a bundle would hold and warns (BSN found — `certain` = next to the word BSN, `possible` = any other number that passes the 11-test —, files that could not be read, lines that are missing /
  too old, files hidden for the person); `bundle` answers `409 bsn_warning` until `acceptBsn` is sent, `422 bundle_too_large` over the setting, and logs an `InspectionHandover`. ZIP = a folder per line + `00 Inhoud.pdf` (+ the checklist
  as Excel); PDF = an index, then the documents in checklist order with a label of the line on every page (`PdfService.combine`).
- Seed: nine lists, 24 more document types, the **NEN 4400-1 checklist** (36 lines in 4 parts — a paraphrase, `prisma/seed-data/checklists.ts`), the three reminder rules, the numbering key `inspection`, the settings group.
- **On / off per line (17-10-2026):** `InspectionItem.decision` is `asked` (switched on by hand — beats the line's condition and rule) · `not_applicable` (off) · `done` (ticked, so on) · null (the line decides). Every line has
  `ask` = `every` | `months` (+ `askEveryMonths`: off while the client's last inspection of the same checklist that asked for it is less than N − 1 months ago, `automaticallyOff` in `inspection-matching.ts`; last-asked dates
  come from closed snapshots and, for open inspections, their decisions) | `manual`. Plan-next carries `asked` / `not_applicable` of `every` lines only. Edition 2 of the shipped checklist (57 lines, five parts) follows the
  bureau's PDF and is added by the seed on top of the shipped edition 1 (`replaces`), never on top of an edition of the office.
  Migrations `20261012154326_inspections` (tables + `StoredFile.periodFrom / periodTo`) and `20261012155000_inspections_access` (renames the area `tax_inspections` → `inspections` in roles and per-person access).

## Taxes (Phase 15)

- **Model** (migration `20261012181051_taxes`, which also renames the area `tax_forms` → `taxes` in roles and per-person access): `VatStep` (the checkboxes: code, names + heading nl / en, `isFiling`), `VatPeriod` (client, kind
  `quarter | month | year`, period, `ticks` JSON `{ stepCode: { at, by } }`, `completedAt`, note, active), `TaxReturn` (kind `income_tax | corporate_tax`, client, person, `taxYear`, period, status, filed day, `fileId`, the extension,
  active). Employer registrations are **worked out**, not stored. **Deadlines are never stored**: `TaxDeadlinesService` computes them from the settings and `CalendarService.moveDeadline`.
- **Files** (`src/module/taxes`): `taxes.constants.ts` (codes, settings `TAXES_DEFINITIONS`, reminder defaults), `tax-periods.ts` (pure period maths: `periodContaining`, `parsePeriodKey`, `addMonthsKeepEnd`), `vat-ticks.ts`,
  `VatStepsService` (+ controller), `VatPeriodsService` (grid, overview, ensure / generate, ticks — one atomic JSONB update — bulk, notes, switching off, export), `TaxReturnsService` (+ controller: list, generate, create, update,
  extension, switching off, export), `EmployerRegistrationsService`, `TaxesGenerationService` (`@Cron('30 3 * * *')` + at start-up), `TaxRemindersService` (`vat_deadline`, `tax_return_deadline` — **one item per VAT period** / per
  year and deadline), `TaxesAttentionService` (`GET /taxes/attention`), `TaxListsService`.
- **Routes:** `GET /taxes/attention`; `GET /taxes/vat` (`period=2026-Q3` or `clientId`; `search`, `open`, `responsibleUserId`, `state`, `stats`), `GET /taxes/vat/overview | export`, `GET|PATCH /taxes/vat/:id`,
  `PUT /taxes/vat/:id/steps/:code`, `POST /taxes/vat/bulk | generate | :id/active`; `GET|POST /taxes/vat-steps`, `PATCH /taxes/vat-steps/:id`, `PUT /taxes/vat-steps/order`; `GET|POST /taxes/returns`, `GET /taxes/returns/export`,
  `POST /taxes/returns/generate`, `GET|PATCH /taxes/returns/:id`, `PUT …/:id/extension`, `POST …/:id/active`; `GET /taxes/employers`, `GET /taxes/employers/export`; `GET|PUT /settings/taxes` (`vatDueMonthsAfter`,
  `vatYearDueMonthsAfter`, `createVatAutomatically`, `incomeTaxDueMonth`, `incomeTaxDueDay`, `incomeTaxExtensionMonths`, `corporateTaxDueMonths`, `corporateTaxExtensionMonths`, `createReturnsAutomatically`).
  Area `taxes` (view · create = make rows and returns · edit = tick, change returns · delete = switch off · export); the steps and the deadlines need `settings.edit`.
- Seed: the six VAT steps (`prisma/seed-data/taxes.ts`), the lists `tax_return_status`, `tax_extension_status`, `employer_registration_status`, the two reminder rules; the users' workload counts the open yearly returns assigned
  to a person (`openReturns`).

## Dashboard, reports, tasks, calendar and search (Phase 16)

- **Model** (migrations `20261012191626_tasks_calendar_reports` and `20261012195821_password_history`): `Task` (title, note, `status` / `priority` = codes of the lists `task_status` / `task_priority`, `dueDate`, assignee, one link `linkedType` / `linkedId` /
  `linkedLabel` + `clientId`, `tags`, `subtasks` JSON, `completedAt`, `searchText`, active), `CalendarEvent` (title, `type` `meeting | team | reminder`, first / last day, `startTime` / `endTime`, place, note, link, guests JSON, client,
  `reminderMinutes` + `reminderSentAt`, active), `ExportPreset` (name, `reportKey`, `format`, `period`, `params`, `columns`), `PasswordHistory` (user, hash).
- **Tasks** (`src/module/tasks`): `TasksService` (list with `mine` / `assigneeId` / `status` / `priority` / `open` / `due=overdue|today|week` / `clientId` / link / `tag` / `search` and `meta.stats`; create, update, toggle done, switch off / on, export),
  `TaskLinksService` (a link is accepted only for a record the person may open), `TaskRemindersService` (`task_due` → the assignee, through `ReminderItem.userIds`), `TaskSearchProvider`. Routes: `GET /tasks`, `GET /tasks/export`, `GET /tasks/:id`,
  `POST /tasks`, `PUT | PATCH /tasks/:id`, `POST /tasks/:id/toggle`, `POST /tasks/:id/active`, `DELETE /tasks/:id` (switches off). Area `tasks` (view · create · edit · delete · export); the staff role starts with view + create + edit.
- **Calendar** (`src/module/agenda`; the holidays stay in `src/module/calendar`): `AgendaEventsService` (appointments, guests — a colleague is found by e-mail and told in the app —, cancelling, the `@Cron('*/5 * * * *')` reminder job),
  `AgendaFeedService` (the stored appointments **plus** entries worked out from contracts, open tasks with a due date, inspections and the day an answer is due, and `TaxCalendarService.between` = one entry per VAT period / yearly-return
  deadline; at most 400 days per request). Routes: `GET /calendar/events?from&to&types&clientId`, `GET /calendar/people`, `GET | PUT | PATCH | DELETE /calendar/events/:id`, `POST /calendar/events`, `POST /calendar/events/:id/active`.
  Area `calendar` (view · create · edit · delete). The holidays take an optional `clientId` (a closing day for one client).
- **Dashboard** (`src/module/dashboard`): `GET /dashboard` (needs `dashboard.view`) — `DashboardService.overview` builds `contracts`, `documents`, `invoices`, `hours`, `taxes`, `inspections`, `tasks`, `agenda`, `activity`, `reminders` from the services
  that exist, each only when the person may open the area (`matrixAllows`) and each in its own `try` (a failing section is logged and left out), plus `attention: [{ key, count, tone }]` sorted red → yellow → blue; `GET /nav/badges` →
  `{ tasks, notifications }`. The reconciliation of last month is kept for ten minutes.
- **Search** (`src/module/search`): `SearchService.register({ key, area, order, find })` — every feature module registers a provider in `onModuleInit` (clients, employees, contracts, invoices, documents, official forms, inspections, tasks);
  `GET /search?q&limit` (two characters at least, five words at most, a group only for an area the person may open). `fuzzy.ts` (`fuzzyIds`) finds names spelled a little differently with `pg_trgm` word similarity when the exact words
  find too little; documents are found by name and by `DocumentText` with the matching snippet.
- **Reports** (`src/module/reports`): `ReportsCatalogService` holds the 17 `ReportDefinition`s (key, group, area, inputs, `run`) — each returns an `ExportTable` from the service that owns the list, so the screen and the file are the same table;
  `ReportsService` (the catalogue for a person, the screen with a summary / chart / first 2,000 rows, the file with the chosen columns, the presets), `report-period.ts` (the ready-made periods and `resolvePeriod`). Routes: `GET /reports`,
  `GET /reports/:key`, `GET /reports/:key/export?format&columns&preset`, `GET | POST /reports/presets`, `PATCH | DELETE /reports/presets/:id`. A report needs `reports.view` and the area it is about (the markup report also `salary_statements.view`);
  files and presets need `reports.export`. An export of more than 20,000 rows is refused (`export_too_large`).
- **Settings audit** (`docs/14` §12): new security settings with bounds — `uploadsPerHour` (300) and `aiRequestsPerHour` (500) in the rate group, `passwordHistoryCount` (3), `uploadAllowImages | Office | Email | Text` (kinds of file; PDF always), `auditRetentionMonths`
  (0 = for ever, otherwise at least 12). Enforced in `FilesService` (`kindAllowed`, `assertUploadRate`), `AiService` (the hour limit), `PasswordService` (`reused`, `PasswordHistory`) and `ActivityRetentionService` (`@Cron` at night, writes its own audit
  entry). Reminder `invoice_due` (`InvoiceRemindersService`: one item per due day for the outgoing invoices that were sent and are not paid; defaults 3 and 0 days, in-app, owner role).
- Seed: the lists `task_status`, `task_priority`, `calendar_event_type`, the notification type `event`, the reminder rules `task_due` and `invoice_due`, five export presets (`prisma/seed-data/export-presets.ts`, only when there are none) and the
  permission areas `tasks`, `calendar`, `reports`. `npm run db:seed` adds what is missing to an existing database and never overwrites what the office changed.

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
