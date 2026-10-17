/**
 * The catalogue of everything a role can be allowed to do: areas (a page or a module) × actions. The backend owns it;
 * `GET /api/permissions/catalog` hands it to the Roles page, and the guards check `@RequirePermission('area.action')`
 * against it. New areas are added here when their module is built.
 */
export const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'delete', 'export', 'approve'] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/** `{ area: [actions] }` — an area is only present when its `view` action is. */
export type PermissionMatrix = Record<string, string[]>;

/** Per-user changes on top of the role: `{ area: { add?: [...], remove?: [...] } }`. */
export type PermissionOverrides = Record<string, { add?: string[]; remove?: string[] }>;

interface Named {
  nl: string;
  en: string;
}

export interface PermissionGroup {
  key: string;
  names: Named;
}

export interface PermissionArea {
  key: string;
  group: string;
  actions: readonly PermissionAction[];
  names: Named;
}

export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  { key: 'workspace', names: { nl: 'Werkruimte', en: 'Workspace' } },
  { key: 'clients', names: { nl: 'Klanten', en: 'Clients' } },
  { key: 'money', names: { nl: 'Uren & loon', en: 'Hours & pay' } },
  { key: 'taxes', names: { nl: 'Belastingen', en: 'Taxes' } },
  { key: 'google', names: { nl: 'Google Workspace', en: 'Google Workspace' } },
  { key: 'automation', names: { nl: 'Automatisering', en: 'Automation' } },
  { key: 'admin', names: { nl: 'Beheer', en: 'Administration' } },
];

const CRUD = ['view', 'create', 'edit', 'delete'] as const;
const CRUD_EXPORT = ['view', 'create', 'edit', 'delete', 'export'] as const;
const ALL = ['view', 'create', 'edit', 'delete', 'export', 'approve'] as const;

export const PERMISSION_AREAS: readonly PermissionArea[] = [
  { key: 'dashboard', group: 'workspace', actions: ['view'], names: { nl: 'Dashboard', en: 'Dashboard' } },
  { key: 'tasks', group: 'workspace', actions: CRUD_EXPORT, names: { nl: 'Taken', en: 'Tasks' } },
  { key: 'notifications', group: 'workspace', actions: ['view'], names: { nl: 'Meldingen', en: 'Notifications' } },
  /** The office calendar: appointments people make and the dates worked out from contracts, tasks, taxes and inspections. `create` = add an appointment, `edit` = change one, `delete` = cancel one. */
  { key: 'calendar', group: 'workspace', actions: CRUD, names: { nl: 'Agenda', en: 'Calendar' } },
  { key: 'clients', group: 'clients', actions: CRUD_EXPORT, names: { nl: 'Klanten', en: 'Clients' } },
  { key: 'employees', group: 'clients', actions: CRUD_EXPORT, names: { nl: 'Werknemers', en: 'Employees' } },
  { key: 'contracts', group: 'clients', actions: ALL, names: { nl: 'Contracten', en: 'Contracts' } },
  /** The Documents page. What a person sees of each document follows the area of the file (clients, employees, contracts, invoices …) — this is the right to open the page and work with documents. `create` = add documents, `edit` = change them, add versions and links, `delete` = remove and bring back, `export` = download lists. */
  { key: 'documents', group: 'clients', actions: CRUD_EXPORT, names: { nl: 'Documenten', en: 'Documents' } },
  { key: 'templates', group: 'automation', actions: CRUD, names: { nl: 'Sjablonen', en: 'Templates' } },
  /** Bulk imports: spreadsheets and the AI file queue. `create` = start an import, `edit` = change values in the review list and the saved column mappings, `delete` = cancel an import / remove a mapping, `approve` = save the results into the records (this also needs the right to create or change those records), `export` = download the report. */
  { key: 'imports', group: 'automation', actions: ALL, names: { nl: 'Importeren', en: 'Imports' } },
  /** Registering hours (the week grid). `approve` = close or reopen a period and change days that are closed (with a reason). */
  { key: 'hours', group: 'money', actions: ALL, names: { nl: 'Uren', en: 'Hours' } },
  /** What is paid: salary statements show amounts. `delete` = cancel a statement. */
  { key: 'salary_statements', group: 'money', actions: ['view', 'create', 'delete', 'export'], names: { nl: 'Loonstaten', en: 'Salary statements' } },
  /** Invoices about hours (incoming from staffing companies, outgoing to the companies that used the workers), their companies, the reconciliation and the markup report. `approve` = issue an invoice / mark an incoming one as checked; `delete` = cancel or credit. */
  { key: 'invoices', group: 'money', actions: ALL, names: { nl: 'Facturen', en: 'Invoices' } },
  /** The library of official PDF forms (Melding loonheffingen, G-account forms …), filling them in, the log of sent forms and the address book for envelope labels. `create` = fill a form in, file it and make its label, mark it sent or dealt with; `edit` = change the library (upload a new edition, the mapping) and the address book; `delete` = switch a form or an address off, take an entry out of the log; `export` = download lists. */
  { key: 'official_forms', group: 'taxes', actions: CRUD_EXPORT, names: { nl: 'Formulieren en post', en: 'Official forms and post' } },
  /** The VAT tracker, the yearly income-tax and corporate-tax returns and the employer registrations. `create` = make the rows of a period or a return by hand, `edit` = tick steps, change a return (status, extension, filed return) and the notes, `delete` = switch a row off or on, `export` = download the lists. The VAT steps themselves are edited in Settings. */
  { key: 'taxes', group: 'taxes', actions: CRUD_EXPORT, names: { nl: 'Belastingaangiften', en: 'Tax returns' } },
  /** Inspections (NEN 4400-1, the tax authority …): planning one, the checklist and what is ready for it, the folder, handing documents over and the follow-up. `create` = plan an inspection, `edit` = change it (lines of the checklist, notes, status, follow-up, hand-overs), `delete` = switch an inspection off or on, `export` = the checklist, the lists and the bundle for the inspector. The checklists themselves are edited in Settings. */
  { key: 'inspections', group: 'taxes', actions: CRUD_EXPORT, names: { nl: 'Controles', en: 'Inspections' } },
  { key: 'drive', group: 'google', actions: CRUD, names: { nl: 'Google Drive', en: 'Google Drive' } },
  { key: 'mail', group: 'google', actions: CRUD, names: { nl: 'Gmail', en: 'Gmail' } },
  { key: 'reports', group: 'automation', actions: ['view', 'export'], names: { nl: 'Rapporten', en: 'Reports' } },
  { key: 'activity', group: 'admin', actions: ['view', 'export'], names: { nl: 'Activiteitenlogboek', en: 'Activity log' } },
  { key: 'users', group: 'admin', actions: CRUD_EXPORT, names: { nl: 'Gebruikers & rollen', en: 'Users & roles' } },
  { key: 'settings', group: 'admin', actions: ['view', 'edit'], names: { nl: 'Instellingen', en: 'Settings' } },
  /** Restricted data: fields the form builder marks as sensitive (BSN, IBAN, wages …). Without this, those values are never shown, listed or exported. */
  { key: 'personal_data', group: 'admin', actions: ['view', 'edit'], names: { nl: 'Gevoelige gegevens (BSN, IBAN, loon)', en: 'Sensitive data (BSN, IBAN, wages)' } },
];

const AREA_BY_KEY = new Map(PERMISSION_AREAS.map(area => [area.key, area]));

export const isKnownCapability = (capability: string): boolean => {
  const [area, action = 'view'] = capability.split('.');
  return AREA_BY_KEY.get(area ?? '')?.actions.includes(action as PermissionAction) ?? false;
};

/** Every area with every action — the owner's role. */
export const fullAccess = (): PermissionMatrix => Object.fromEntries(PERMISSION_AREAS.map(area => [area.key, [...area.actions]]));

/** Keeps only known areas / actions, in catalogue order. No `view` means no access at all. */
export function sanitizeMatrix(input: unknown): PermissionMatrix {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const clean: PermissionMatrix = {};
  for (const area of PERMISSION_AREAS) {
    const requested = Array.isArray(source[area.key]) ? (source[area.key] as unknown[]) : [];
    const actions = area.actions.filter(action => requested.includes(action));
    if (actions.includes('view')) clean[area.key] = actions;
  }
  return clean;
}

/** Keeps only known areas / actions of a person's own additions / removals. */
export function sanitizeOverrides(input: unknown): PermissionOverrides {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, { add?: unknown; remove?: unknown } | undefined>;
  const clean: PermissionOverrides = {};
  for (const area of PERMISSION_AREAS) {
    const pick = (list: unknown) => area.actions.filter(action => Array.isArray(list) && list.includes(action));
    const add = pick(source[area.key]?.add);
    const remove = pick(source[area.key]?.remove).filter(action => !add.includes(action));
    if (add.length || remove.length) clean[area.key] = { ...(add.length && { add }), ...(remove.length && { remove }) };
  }
  return clean;
}

/** The role's matrix with a person's own additions / removals applied. */
export function applyOverrides(matrix: PermissionMatrix, overrides: unknown): PermissionMatrix {
  const changes = (overrides && typeof overrides === 'object' ? overrides : {}) as PermissionOverrides;
  const merged: Record<string, string[]> = {};
  for (const area of PERMISSION_AREAS) {
    const base = new Set(matrix[area.key] ?? []);
    const change = changes[area.key];
    for (const action of change?.add ?? []) base.add(action);
    for (const action of change?.remove ?? []) base.delete(action);
    merged[area.key] = [...base];
  }
  return sanitizeMatrix(merged);
}

/** The overrides that turn `base` into `wanted` (the inverse of applyOverrides) — what the user editor saves. */
export function diffOverrides(base: PermissionMatrix, wanted: PermissionMatrix): PermissionOverrides {
  const overrides: PermissionOverrides = {};
  for (const area of PERMISSION_AREAS) {
    const have = new Set(base[area.key] ?? []);
    const want = new Set(wanted[area.key] ?? []);
    const add = area.actions.filter(action => want.has(action) && !have.has(action));
    const remove = area.actions.filter(action => have.has(action) && !want.has(action));
    if (add.length || remove.length) overrides[area.key] = { ...(add.length && { add }), ...(remove.length && { remove }) };
  }
  return overrides;
}

export function matrixAllows(matrix: PermissionMatrix, capability: string): boolean {
  const [area, action = 'view'] = capability.split('.');
  return Boolean(matrix[area ?? '']?.includes(action));
}

/** The capabilities `after` grants on top of `before` that `actor` does not have himself — nobody can hand out more than they hold. */
export function escalations(actor: PermissionMatrix, before: PermissionMatrix, after: PermissionMatrix): string[] {
  const found: string[] = [];
  for (const area of PERMISSION_AREAS) {
    for (const action of after[area.key] ?? []) {
      if (!(before[area.key] ?? []).includes(action) && !(actor[area.key] ?? []).includes(action)) found.push(`${area.key}.${action}`);
    }
  }
  return found;
}

/** The built-in role of the office owner. It can never lose anything. */
export const OWNER_ROLE_KEY = 'owner';
export const MEDEWERKER_ROLE_KEY = 'medewerker';

/** A role's own matrix: the owner always has everything, whatever is stored. */
export const roleMatrix = (role: { key: string; permissions: unknown }): PermissionMatrix => (role.key === OWNER_ROLE_KEY ? fullAccess() : sanitizeMatrix(role.permissions));

/** What a person may do: their role plus their own additions / removals (the owner is never reduced). */
export const effectiveMatrix = (role: { key: string; permissions: unknown }, overrides: unknown): PermissionMatrix =>
  role.key === OWNER_ROLE_KEY ? fullAccess() : applyOverrides(roleMatrix(role), overrides);

/** Sensible defaults for the built-in staff role: read most things, work on tasks and the calendar. */
export const MEDEWERKER_PERMISSIONS: PermissionMatrix = sanitizeMatrix({
  dashboard: ['view'],
  tasks: ['view', 'create', 'edit'],
  notifications: ['view'],
  clients: ['view'],
  employees: ['view'],
  contracts: ['view'],
  documents: ['view'],
  hours: ['view', 'create', 'edit'],
  invoices: ['view'],
  official_forms: ['view', 'create'],
  taxes: ['view', 'edit'],
  inspections: ['view'],
  calendar: ['view', 'create', 'edit'],
  reports: ['view'],
});
