/**
 * What ships with the document settings (Settings → Documents). Types and folders are only *created* by the seed — one that exists is left alone, so the
 * office's renames, rules and switched-off items survive a re-seed. The required documents are only made when there are none at all. Synthetic: no real
 * client data.
 */

export interface SeedFolder {
  code: string;
  nameNl: string;
  nameEn: string;
}

/** Ahmad's folders per client (his OneDrive layout), inside `<number>- <name>`. */
export const SEED_FOLDERS: SeedFolder[] = [
  { code: 'contracts', nameNl: 'Arbeidsovereenkomsten', nameEn: 'Employment contracts' },
  { code: 'inspections', nameNl: 'Controles', nameEn: 'Inspections' },
  { code: 'g_account', nameNl: 'Deblokkering G-rekening', nameEn: 'G-account releases' },
  { code: 'company_data', nameNl: 'Gegevens', nameEn: 'Company data' },
  { code: 'taxes', nameNl: 'Belastingen', nameEn: 'Taxes' },
  { code: 'forms', nameNl: 'Formulieren Belastingdienst', nameEn: 'Tax authority forms' },
  { code: 'hours_invoices', nameNl: 'Uren en facturen', nameEn: 'Hours and invoices' },
];

export interface SeedDocumentType {
  code: string;
  nameNl: string;
  nameEn: string;
  scope: 'client' | 'worker' | 'any';
  validity: 'none' | 'age' | 'date' | 'field';
  validityMonths?: number;
  validityField?: string;
  warnDays?: number;
  versioned?: boolean;
  personal?: boolean;
  folderCode?: string;
  namePattern?: string;
  /** Words in a file name that point to this type (comma separated), on top of the built-in recognition. */
  keywords?: string;
}

/**
 * The types the import and the generated documents know by code are the first fourteen (they can be renamed and configured, never switched off).
 * Valid-until rules: an ID and a residence permit follow the date in the worker's record; a KvK extract is good for three months (Ahmad: inspections want
 * one that is at most 3 months old), and so is a payment-behaviour declaration (docs/11).
 */
export const SEED_DOCUMENT_TYPES: SeedDocumentType[] = [
  { code: 'id_document', nameNl: 'Identiteitsbewijs', nameEn: 'ID document', scope: 'worker', validity: 'field', validityField: 'id_expiry', versioned: true, personal: true, namePattern: '{worker} - {type}' },
  { code: 'residence_permit', nameNl: 'Verblijfs- of werkvergunning', nameEn: 'Residence or work permit', scope: 'worker', validity: 'field', validityField: 'permit_expiry', versioned: true, personal: true, namePattern: '{worker} - {type}' },
  { code: 'kvk_extract', nameNl: 'KvK-uittreksel', nameEn: 'Chamber of Commerce extract', scope: 'client', validity: 'age', validityMonths: 3, warnDays: 14, versioned: true, folderCode: 'company_data', namePattern: '{number} - {type} {date}' },
  { code: 'contract', nameNl: 'Arbeidsovereenkomst', nameEn: 'Employment contract', scope: 'worker', validity: 'none', folderCode: 'contracts', namePattern: '{worker} - {type} {date}' },
  { code: 'staffing_invoice', nameNl: 'Factuur van een uitzendbureau', nameEn: 'Staffing agency invoice', scope: 'client', validity: 'none', folderCode: 'hours_invoices' },
  { code: 'invoice', nameNl: 'Factuur', nameEn: 'Invoice', scope: 'client', validity: 'none', folderCode: 'hours_invoices' },
  { code: 'timesheet', nameNl: 'Urenstaat', nameEn: 'Timesheet', scope: 'any', validity: 'none', folderCode: 'hours_invoices' },
  { code: 'payslip', nameNl: 'Loonstrook', nameEn: 'Payslip', scope: 'worker', validity: 'none', namePattern: '{worker} - {type} {date}' },
  { code: 'letter', nameNl: 'Brief', nameEn: 'Letter', scope: 'any', validity: 'none' },
  { code: 'tax_return', nameNl: 'Aangifte of beschikking', nameEn: 'Tax return or assessment', scope: 'client', validity: 'none', folderCode: 'taxes' },
  { code: 'inspection', nameNl: 'Controle', nameEn: 'Inspection', scope: 'client', validity: 'none', folderCode: 'inspections' },
  { code: 'g_account', nameNl: 'G-rekening', nameEn: 'G-account', scope: 'client', validity: 'none', folderCode: 'g_account', namePattern: '{number} - {type} {date}' },
  { code: 'form', nameNl: 'Formulier', nameEn: 'Form', scope: 'client', validity: 'none', folderCode: 'forms' },
  { code: 'payment_behaviour', nameNl: 'Verklaring betalingsgedrag', nameEn: 'Payment-behaviour declaration', scope: 'client', validity: 'age', validityMonths: 3, warnDays: 14, versioned: true, folderCode: 'forms', namePattern: '{number} - {type} {date}' },
  // A trial balance is of a period (the previous year and this year's to date are both asked for), so a new one does not replace the old.
  { code: 'trial_balance', nameNl: 'Kolommenbalans', nameEn: 'Trial balance', scope: 'client', validity: 'none', folderCode: 'taxes', namePattern: '{number} - {type} {date}', keywords: 'kolommenbalans,proef- en saldibalans,saldibalans' },
  { code: 'annual_accounts', nameNl: 'Jaarrekening', nameEn: 'Annual accounts', scope: 'client', validity: 'none', folderCode: 'taxes', namePattern: '{number} - {type} {year}', keywords: 'jaarrekening,jaarverslag' },
  { code: 'other', nameNl: 'Overig', nameEn: 'Other', scope: 'any', validity: 'none' },

  // What the checklist of an inspection asks for (Phase 14, docs/11). Most are of a period: the period they are about is typed on the document (Documents → details).
  { code: 'company_details', nameNl: 'Bedrijfsgegevens voor de controle', nameEn: 'Company details for the inspection', scope: 'client', validity: 'none', folderCode: 'inspections', keywords: 'bedrijfsgegevens' },
  { code: 'org_chart', nameNl: 'Organogram of groepsstructuur', nameEn: 'Organisation chart or group structure', scope: 'client', validity: 'none', folderCode: 'company_data', keywords: 'organogram,organisatieschema,groepsstructuur' },
  { code: 'cao_document', nameNl: 'Cao en toepassing van de cao-lonen', nameEn: 'Collective agreement and how its wages are applied', scope: 'client', validity: 'none', folderCode: 'company_data', keywords: 'cao,toepassing cao' },
  { code: 'pension_fund_proof', nameNl: 'Bewijs pensioenfonds (aansluiting of vrijstelling)', nameEn: 'Pension fund proof (membership or exemption)', scope: 'client', validity: 'none', folderCode: 'company_data', keywords: 'pensioenfonds,pensioen,vrijstelling pensioen' },
  { code: 'social_fund_proof', nameNl: 'Bewijs sociaal fonds (deelname of dispensatie)', nameEn: 'Social fund proof (participation or dispensation)', scope: 'client', validity: 'none', folderCode: 'company_data', keywords: 'sociaal fonds,sociale fondsen,dispensatie' },
  { code: 'g_account_agreement', nameNl: 'G-rekeningovereenkomst', nameEn: 'G-account agreement', scope: 'client', validity: 'none', folderCode: 'g_account', keywords: 'g-rekeningovereenkomst,g rekeningovereenkomst,overeenkomst g-rekening' },
  { code: 'g_account_statement', nameNl: 'Afschrift G-rekening', nameEn: 'G-account statement', scope: 'client', validity: 'none', folderCode: 'g_account', keywords: 'afschrift g-rekening,afschrift g rekening' },
  { code: 'payroll_parameters', nameNl: 'Parameteroverzicht loonprogramma', nameEn: 'Payroll software parameters', scope: 'client', validity: 'none', folderCode: 'taxes', keywords: 'parameters,parameteroverzicht,parameterlijst' },
  { code: 'sector_decision', nameNl: 'Beschikking sectorindeling en premiegroep', nameEn: 'Sector classification and risk-premium decision', scope: 'client', validity: 'none', folderCode: 'taxes', keywords: 'sectorindeling,sectorwijziging,premiegroep' },
  { code: 'whk_decision', nameNl: 'Beschikking premie Werkhervattingskas', nameEn: 'Werkhervattingskas premium decision', scope: 'client', validity: 'none', folderCode: 'taxes', keywords: 'werkhervattingskas,whk,gedifferentieerde premie' },
  { code: 'zw_decision', nameNl: 'Beschikking eigenrisicodrager ZW of polis', nameEn: 'Sickness-benefit self-insurer decision or policy', scope: 'client', validity: 'none', folderCode: 'taxes', keywords: 'eigenrisicodrager,ziektewet' },
  { code: 'payroll_cumulative', nameNl: 'Cumulatief loonoverzicht op naam', nameEn: 'Cumulative payroll statement by name', scope: 'client', validity: 'none', folderCode: 'taxes', keywords: 'cumulatief,cumulatief loonoverzicht,loonstaat' },
  { code: 'payroll_tax_return', nameNl: 'Aangifte loonheffingen', nameEn: 'Payroll tax return', scope: 'client', validity: 'none', folderCode: 'taxes', keywords: 'aangifte loonheffingen,loonaangifte' },
  { code: 'payroll_all_employees', nameNl: 'Loonoverzicht alle medewerkers (in en uit dienst)', nameEn: 'Payroll statement of all employees (joiners and leavers)', scope: 'client', validity: 'none', folderCode: 'taxes', keywords: 'loonoverzicht alle medewerkers,in- en uitdienst' },
  { code: 'sales_invoice', nameNl: 'Verkoopfactuur van de klant', nameEn: 'Sales invoice of the client', scope: 'client', validity: 'none', folderCode: 'hours_invoices', keywords: 'verkoopfactuur,verkoopfacturen' },
  { code: 'vat_return', nameNl: 'Aangifte omzetbelasting (btw)', nameEn: 'VAT return', scope: 'client', validity: 'none', folderCode: 'taxes', keywords: 'btw-aangifte,aangifte omzetbelasting,aangifte btw' },
  { code: 'vat_filing_proof', nameNl: 'Bewijs van indiening btw-aangifte', nameEn: 'Proof of filing a VAT return', scope: 'client', validity: 'none', folderCode: 'taxes', keywords: 'indiening,ontvangstbevestiging' },
  { code: 'payment_proof', nameNl: 'Betaalbewijs Belastingdienst', nameEn: 'Proof of payment to the tax authority', scope: 'client', validity: 'none', folderCode: 'taxes', keywords: 'betaalbewijs,betalingen belastingdienst' },
  { code: 'debtor_creditor_list', nameNl: 'Debiteuren- en crediteurenlijst', nameEn: 'Debtor and creditor list', scope: 'client', validity: 'none', folderCode: 'taxes', keywords: 'debiteuren,crediteuren' },
  { code: 'vat_reconciliation', nameNl: 'Aansluiting omzet en btw', nameEn: 'Turnover and VAT reconciliation', scope: 'client', validity: 'none', folderCode: 'taxes', keywords: 'aansluiting omzet,aansluiting btw' },
  { code: 'wage_reconciliation', nameNl: 'Aansluiting lonen', nameEn: 'Wage reconciliation', scope: 'client', validity: 'none', folderCode: 'taxes', keywords: 'aansluiting lonen,aansluiting loon' },
  { code: 'fiscal_unity_reconciliation', nameNl: 'Aansluiting fiscale eenheid', nameEn: 'Fiscal unity reconciliation', scope: 'client', validity: 'none', folderCode: 'taxes', keywords: 'fiscale eenheid' },
  { code: 'activity_split', nameNl: 'Kosten en omzet per activiteit', nameEn: 'Costs and turnover per activity', scope: 'client', validity: 'none', folderCode: 'taxes', keywords: 'per activiteit' },
  { code: 'arrangement', nameNl: 'Boete of afspraak met een instantie', nameEn: 'Fine or arrangement with an authority', scope: 'client', validity: 'none', folderCode: 'inspections', keywords: 'boete,betalingsregeling,afspraak' },
  // Added with the inspection body's own list (Cicero version 13): lines 7a, 7b-2, 7c, 7e and the procedures (16a – 16m).
  { code: 'payroll_journal', nameNl: 'Loonjournaalpost', nameEn: 'Payroll journal entry', scope: 'client', validity: 'none', folderCode: 'taxes', keywords: 'loonjournaal,loonjournaalpost,journaalpost' },
  { code: 'payroll_filing_proof', nameNl: 'Bewijs van indiening loonaangifte', nameEn: 'Proof of filing a payroll tax return', scope: 'client', validity: 'none', folderCode: 'taxes', keywords: 'indiening loonaangifte,verzendbevestiging loonaangifte' },
  { code: 'wkr_overview', nameNl: 'Overzicht werkkostenregeling', nameEn: 'Work-related costs scheme overview', scope: 'client', validity: 'none', folderCode: 'taxes', keywords: 'werkkostenregeling,wkr' },
  { code: 'procedure_manual', nameNl: 'Procedures of kwaliteitshandboek', nameEn: 'Procedures or quality handbook', scope: 'client', validity: 'none', folderCode: 'inspections', keywords: 'procedure,procedures,kwaliteitshandboek,handboek' },
];

/** The types the program itself knows by code (switching them off would break the import and the generated documents). */
export const SYSTEM_TYPE_CODES: ReadonlySet<string> = new Set(['id_document', 'residence_permit', 'kvk_extract', 'contract', 'staffing_invoice', 'invoice', 'timesheet', 'payslip', 'letter', 'tax_return', 'inspection', 'g_account', 'form', 'other']);

export interface SeedRequirement {
  typeCode: string;
  scope: 'client' | 'worker';
  condition?: Record<string, unknown>;
  note: string;
}

/** Every client has a KvK extract; every worker an ID, a signed contract (unless hired in through a staffing company) and — when a permit is filled in — the permit. */
export const SEED_REQUIRED_DOCUMENTS: SeedRequirement[] = [
  { typeCode: 'kvk_extract', scope: 'client', note: 'Een actueel uittreksel uit het handelsregister.' },
  { typeCode: 'id_document', scope: 'worker', note: 'Een kopie van een geldig identiteitsbewijs.' },
  { typeCode: 'residence_permit', scope: 'worker', condition: { field: 'person.permit_type', op: 'filled' }, note: 'Alleen als bij de persoon een vergunning is ingevuld.' },
  { typeCode: 'contract', scope: 'worker', condition: { field: 'employee.work_kind', op: 'ne', value: 'hired_in' }, note: 'Het getekende contract (niet voor uitzendkrachten die via een uitzendbureau werken).' },
];
