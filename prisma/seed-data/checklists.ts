import { EMPTY_ITEM, type ChecklistItem, type ChecklistSection } from '../../src/module/inspections/checklist-doc.js';

/**
 * The checklist that ships with the system: what a NEN 4400-1 inspector asks for (docs/11). It follows the inspection body's own list — "Checklist NEN 4400-1 voor
 * de te inspecteren onderneming; eerste inspectie", Cicero version 13 of 4 January 2023 — line by line: the same numbers, parts and "on site / digital copy"
 * columns, in our own words (NOT its wording). It is seed data like any other: the office edits it in Settings → Inspections (a change is a new edition), sets
 * per line how often it is asked, and switches lines on or off in each inspection.
 * Created once. An edition the system shipped earlier (`replaces`) gets the newer one on top, as long as the office has not made an edition of its own.
 */
export interface SeedChecklist {
  code: string;
  nameNl: string;
  nameEn: string;
  descriptionNl: string;
  descriptionEn: string;
  inspectionTypes: string[];
  version: { label: string; note: string; sections: ChecklistSection[]; items: ChecklistItem[] };
  /** Labels of editions the system shipped before: when one of those is still the newest, this edition is added on top. */
  replaces?: string[];
  /** The description the system shipped before: a checklist that still has it gets the current one (a description the office wrote is left alone). */
  replacesDescription?: { nl: string; en: string };
}

const SECTIONS: ChecklistSection[] = [
  { key: 'general', nameNl: 'Algemeen', nameEn: 'General', folder: true },
  { key: 'payroll', nameNl: 'Personeels- en loonadministratie', nameEn: 'Personnel and payroll administration', folder: true },
  { key: 'financial', nameNl: 'Financiële administratie', nameEn: 'Financial administration', folder: true },
  { key: 'other', nameNl: 'Overige documenten', nameEn: 'Other documents', folder: true },
  { key: 'procedures', nameNl: 'Procedures', nameEn: 'Procedures', folder: true },
];

type Line = Partial<Omit<ChecklistItem, 'code' | 'section' | 'labelNl' | 'labelEn'>>;

const line = (code: string, section: string, labelNl: string, labelEn: string, extra: Line = {}): ChecklistItem => ({ ...EMPTY_ITEM, code, section, labelNl, labelEn, ...extra });

/** "Ter inzage" and "Kopie digitaal" both ticked — most lines of the list. */
const BOTH: Line = { onSite: true, digital: true };
/** Only "Ter inzage": the inspector looks at it on site, no copy. */
const ON_SITE: Line = { onSite: true, digital: false };

/** The G-account lines only apply to a client that has a G-account (the client form's own field) — or when somebody switches them on. */
const HAS_G_ACCOUNT = { field: 'client.g_account', op: 'filled' } as const;

/** One written procedure covers several lines: a quality handbook with all of them satisfies every procedure line. */
const PROCEDURE: Line = { ...BOTH, docTypes: ['procedure_manual'] };

const ITEMS: ChecklistItem[] = [
  // ── Algemeen ──
  line('0', 'general', 'Excel-bestand “Bedrijfsgegevens” van het inspectiebureau, ingevuld teruggestuurd', 'The inspection body’s “Company details” workbook, filled in and sent back', {
    ...BOTH,
    docTypes: ['company_details'],
    helpNl: 'Het bureau stuurt een Excel-bestand met macro’s (.xlsm); vul het in en stuur het in hetzelfde formaat terug. Op een Apple-computer kan dat misgaan.',
    helpEn: 'The body sends an Excel workbook with macros (.xlsm); fill it in and send it back in the same format. On an Apple computer this can go wrong.',
  }),
  line('1a', 'general', 'Organogram of een beschrijving van het bedrijf, met een schema van de groepsverhoudingen', 'Organisation chart or a description of the company, with a diagram of the group relations', { ...BOTH, docTypes: ['org_chart'] }),
  line('1b', 'general', 'De cao die voor het bedrijf geldt, en hoe de cao-lonen worden toegepast', 'The collective labour agreement that applies, and how its wages are applied', { ...BOTH, docTypes: ['cao_document'] }),
  line('1c', 'general', 'Bewijs van aansluiting bij een pensioenfonds, of van vrijstelling', 'Proof of membership of a pension fund, or of exemption', {
    ...BOTH,
    docTypes: ['pension_fund_proof'],
    helpNl: 'Alleen als het van toepassing is; zet de regel anders uit.',
    helpEn: 'Only when it applies; otherwise switch the line off.',
  }),
  line('1d', 'general', 'Bewijs van deelname aan een sociaal fonds van de cao, of van dispensatie', 'Proof of participation in a social fund of the collective agreement, or of dispensation', {
    ...BOTH,
    docTypes: ['social_fund_proof'],
    helpNl: 'Alleen als de cao een sociaal fonds kent; zet de regel anders uit.',
    helpEn: 'Only when the agreement has a social fund; otherwise switch the line off.',
  }),
  line('1e', 'general', 'Hulpmiddelen om de echtheid van identiteitsbewijzen te controleren (blauwe of uv-lamp, naslagwerk)', 'Tools to check that ID documents are genuine (blue or UV lamp, reference book)', {
    ...BOTH,
    optional: true,
    helpNl: 'Naar keuze. De inspecteur kijkt of ze er zijn; vink de regel af wanneer ze aanwezig zijn.',
    helpEn: 'Optional. The inspector checks they are there; tick the line when they are.',
  }),
  line('2', 'general', 'Uittreksel van het bedrijf uit het handelsregister van de Kamer van Koophandel', 'Chamber of Commerce (KvK) trade register extract of the company', {
    ...BOTH,
    docTypes: ['kvk_extract'],
    maxAgeMonths: 3,
    helpNl: 'Op de dag van de controle hoogstens 3 maanden oud.',
    helpEn: 'At most 3 months old on the day of the inspection.',
  }),
  line('3', 'general', 'Wordt het bedrijf bestuurd door een rechtspersoon: ook van die rechtspersoon een KvK-uittreksel, en zo verder tot de natuurlijke bestuurder(s)', 'If the company is run by a legal entity: a KvK extract of that entity too, and so on up to the natural director(s)', {
    ...BOTH,
    scope: 'parents',
    docTypes: ['kvk_extract'],
    maxAgeMonths: 12,
    helpNl: 'Van elk bedrijf boven deze klant (via de koppelingen tussen klanten); elk uittreksel hoogstens 12 maanden oud.',
    helpEn: 'Of every company above this client (through the links between clients); each extract at most 12 months old.',
  }),
  line('4a', 'general', 'G-rekeningovereenkomst, mede ondertekend door de Belastingdienst en de bank', 'G-account agreement, co-signed by the tax authority and the bank', {
    ...BOTH,
    docTypes: ['g_account_agreement'],
    condition: HAS_G_ACCOUNT,
    helpNl: 'Staat aan voor een klant met een G-rekening; zet de regel aan als de inspecteur er toch om vraagt.',
    helpEn: 'On for a client with a G-account; switch the line on when the inspector asks for it anyway.',
  }),
  line('4b', 'general', 'Afschriften van de G-rekening van de afgelopen 24 maanden', 'G-account statements of the last 24 months', { ...ON_SITE, docTypes: ['g_account_statement'], period: 'months_24', condition: HAS_G_ACCOUNT }),

  // ── Personeels- en loonadministratie ──
  line('5', 'payroll', 'Uitdraai van de instellingen van het loonprogramma (premie- en reserveringspercentages, grondslagen) van vorig en dit jaar', 'Printout of the payroll software settings (premium and reservation percentages, bases) of last year and this year', {
    ...BOTH,
    docTypes: ['payroll_parameters'],
    period: 'years_prev_current',
  }),
  line('6a', 'payroll', 'Beschikking sectorindeling van de Belastingdienst (en zo nodig de risicopremiegroep)', 'Tax authority decision on the sector classification (and the risk-premium group, if any)', {
    ...BOTH,
    docTypes: ['sector_decision'],
    ask: 'months',
    askEveryMonths: 12,
    helpNl: 'Meestal eens per jaar gevraagd; zet de regel aan als de inspecteur er vaker om vraagt.',
    helpEn: 'Usually asked once a year; switch the line on when the inspector asks for it more often.',
  }),
  line('6b', 'payroll', 'Beschikking Werkhervattingskas (WHK)', 'Werkhervattingskas (WHK) decision', {
    ...BOTH,
    docTypes: ['whk_decision'],
    ask: 'months',
    askEveryMonths: 12,
    helpNl: 'Meestal eens per jaar gevraagd; zet de regel aan als de inspecteur er vaker om vraagt.',
    helpEn: 'Usually asked once a year; switch the line on when the inspector asks for it more often.',
  }),
  line('6c', 'payroll', 'Eigenrisicodrager voor de Ziektewet: de beschikking van de Belastingdienst (bij herverzekering ook de polis ter inzage)', 'Self-insurer for sickness benefit (ZW): the tax authority’s decision (if re-insured, the policy on site too)', {
    ...BOTH,
    docTypes: ['zw_decision'],
    helpNl: 'Alleen als de klant eigenrisicodrager is; zet de regel anders uit.',
    helpEn: 'Only when the client is a self-insurer; otherwise switch the line off.',
  }),
  line('7a', 'payroll', 'Cumulatieve verzamelloonstaat op naam (per premiegroep) van heel vorig jaar en dit jaar tot de laatst aangegeven periode, met de cumulatieve loonjournaalposten', 'Cumulative payroll summary by name (per premium group) of the whole of last year and this year up to the last period filed, with the cumulative payroll journal entries', {
    ...BOTH,
    docTypes: ['payroll_cumulative', 'payroll_journal'],
    period: 'years_prev_current',
  }),
  line('7b-1', 'payroll', 'Zijn bij de vorige controle nog niet alle loonaangiften van vorig jaar bekeken: ook de cumulatieve verzamelloonstaat op naam van dat hele jaar', 'If not all payroll tax returns of last year were reviewed at the previous inspection: the cumulative payroll summary by name of that whole year too', {
    ...BOTH,
    docTypes: ['payroll_cumulative'],
    period: 'year_previous',
    ask: 'manual',
    helpNl: 'Alleen in die situatie; zet de regel dan aan.',
    helpEn: 'Only in that situation; then switch the line on.',
  }),
  line('7b-2', 'payroll', 'In dezelfde situatie: de cumulatieve loonjournaalposten van dat hele jaar', 'In the same situation: the cumulative payroll journal entries of that whole year', {
    ...BOTH,
    docTypes: ['payroll_journal'],
    period: 'year_previous',
    ask: 'manual',
    helpNl: 'Alleen in die situatie; zet de regel dan aan.',
    helpEn: 'Only in that situation; then switch the line on.',
  }),
  line('7c', 'payroll', 'Uitdraai uit het aangifteprogramma waaruit blijkt wanneer de loonaangiften zijn ingediend', 'Printout from the filing software showing when the payroll tax returns were filed', {
    ...BOTH,
    docTypes: ['payroll_filing_proof'],
    optional: true,
    helpNl: 'Alleen als de datum niet op de aangifte zelf staat.',
    helpEn: 'Only when the date is not on the return itself.',
  }),
  line('7e', 'payroll', 'Overzicht van de bestedingen binnen de werkkostenregeling (WKR) en de specificatie van een eventuele afdracht', 'Overview of the spending under the work-related costs scheme (WKR) and the specification of any tax paid on it', { ...BOTH, docTypes: ['wkr_overview'] }),
  line('8a', 'payroll', 'Personeelsadministratie ter inzage: arbeidsovereenkomsten, loonbelastingverklaringen, kopieën van identiteits- of verblijfsdocumenten', 'Personnel files on site: employment contracts, payroll tax declarations, copies of ID or residence documents', {
    ...ON_SITE,
    bsnAllowed: true,
    helpNl:
      'Per werknemer: het contract, de loonbelastingverklaring, een kopie van het identiteits- of verblijfsdocument dat geldig was bij indiensttreding, en voor werknemers van buiten de EU/EER een kopie van een geldig document als het eerdere is verlopen. De inspecteur neemt van één gekozen werknemer kopieën mee van 8a, 8b en 8d.',
    helpEn:
      'Per employee: the contract, the payroll tax declaration, a copy of the ID or residence document that was valid at the start, and for employees from outside the EU/EEA a copy of a valid document when the earlier one has expired. The inspector takes copies of 8a, 8b and 8d for one selected employee.',
  }),
  line('8b', 'payroll', 'Ter inzage: inlenersbeloning, loonstroken en nettobetalingen, urenregistratie, verlofregistratie en de laatste reserveringen', 'On site: hirer’s pay arrangements, payslips and net payments, hours records, leave records and the latest reservations', {
    ...ON_SITE,
    helpNl:
      'De afspraken over de inlenersbeloning; de loonstroken van alle werknemers over de gecontroleerde periode met de nettobetalingen; de urenregistratie (werkbonnen, urenbriefjes); de verlofregistratie (als die niet uit de loonstroken blijkt); de loonstrook waaruit blijkt dat de laatste reserveringen zijn berekend en uitbetaald, met het betaalbewijs.',
    helpEn:
      'The arrangements on the hirer’s pay; the payslips of all employees over the period inspected with the net payments; the hours records (job sheets, time slips); the leave records (when the payslips do not show them); the payslip showing the latest reservations calculated and paid, with the proof of payment.',
  }),
  line('8c', 'payroll', 'Verzamelloonstaat van alle werknemers, met wie sinds de vorige controle in en uit dienst is gegaan en in welke periodes is gewerkt (voor de steekproef)', 'Payroll summary of all employees, showing who joined and left since the previous inspection and the periods worked (for the sample)', {
    ...BOTH,
    docTypes: ['payroll_all_employees'],
    helpNl: 'Het tabblad Steekproef van de controle toont wie er sinds de vorige controle in en uit dienst is gegaan.',
    helpEn: 'The Sample tab of the inspection shows who joined and left since the previous inspection.',
  }),
  line('8d', 'payroll', 'Verkoopfacturen van vorig en dit jaar (voor de steekproef)', 'Sales invoices of last year and this year (for the sample)', { ...ON_SITE, docTypes: ['sales_invoice'], period: 'years_prev_current' }),
  line('8e', 'payroll', 'De 3 laatste uitdiensttreders: loonstroken met de uitbetaling van de reserveringen bij uitdiensttreding', 'The 3 most recent leavers: payslips with the reservations paid out on leaving', {
    ...BOTH,
    scope: 'sample',
    docTypes: ['payslip'],
    helpNl: 'Alleen als er uitdiensttreders zijn; per werknemer de laatste loonstrook.',
    helpEn: 'Only when there are leavers; the last payslip of each.',
  }),
  line('8f', 'payroll', 'Dezelfde uitdiensttreders: loonstroken met de uitbetaling van de vakantiebijslag', 'The same leavers: payslips with the holiday allowance paid out', { ...BOTH, scope: 'sample', docTypes: ['payslip'] }),
  line('8g', 'payroll', 'Dezelfde uitdiensttreders: loonstroken met de uitbetaling van feestdagen', 'The same leavers: payslips with public holidays paid out', { ...BOTH, scope: 'sample', docTypes: ['payslip'] }),

  // ── Financiële administratie ──
  line('9a', 'financial', 'Ingediende btw-aangiften van vorig en dit jaar', 'Filed VAT returns of last year and this year', { ...BOTH, docTypes: ['vat_return'], period: 'quarters_prev_current' }),
  line('9b', 'financial', 'Uitdraai uit het aangifteprogramma waaruit blijkt wanneer de btw-aangiften zijn ingediend', 'Printout from the filing software showing when the VAT returns were filed', {
    ...BOTH,
    docTypes: ['vat_filing_proof'],
    optional: true,
    helpNl: 'Alleen als de datum niet op de aangifte zelf staat.',
    helpEn: 'Only when the date is not on the return itself.',
  }),
  line('9c', 'financial', 'Betaalbewijzen van de btw-aangiften (9a) en van de loonaangiften, bijvoorbeeld een selectie uit internetbankieren', 'Proof of payment of the VAT returns (9a) and of the payroll tax returns, for example a selection from online banking', {
    ...BOTH,
    docTypes: ['payment_proof'],
    period: 'years_prev_current',
    helpNl: 'De inspecteur neemt in elk geval een kopie van de laatste betaling mee.',
    helpEn: 'The inspector takes a copy of the latest payment in any case.',
  }),
  line('9d', 'financial', 'Kolommenbalans van vorig jaar en van dit jaar tot en met de laatste btw-aangifte', 'Trial balance of last year and of this year up to the last VAT return', {
    ...BOTH,
    docTypes: ['trial_balance'],
    period: 'years_prev_current',
    cutoff: 'vat_quarter',
    helpNl: 'Meestal een export uit SnelStart. Zet de periode (van – tot) bij het document, dan ziet het systeem tot waar de balans reikt.',
    helpEn: 'Usually an export from SnelStart. Give the document its period (from – to), so the system sees how far the balance reaches.',
  }),
  line('9e', 'financial', 'Kolommenbalans van dit jaar tot en met de laatst ingediende loonaangifte', 'Trial balance of this year up to the last payroll tax return filed', { ...BOTH, docTypes: ['trial_balance'], period: 'year_current', cutoff: 'month' }),
  line('9f', 'financial', 'Saldilijsten van debiteuren en crediteuren die aansluiten op de laatste kolommenbalans (9d en 9e)', 'Debtor and creditor balance lists that agree with the latest trial balance (9d and 9e)', { ...BOTH, docTypes: ['debtor_creditor_list'] }),
  line('9g', 'financial', 'Aansluiting van omzet en btw volgens de aangiften met het grootboek, vorig en dit jaar', 'Reconciliation of turnover and VAT per the returns with the ledger, last year and this year', { ...BOTH, docTypes: ['vat_reconciliation'], period: 'years_prev_current' }),
  line('9h', 'financial', 'Aansluiting van de lonen voor SV en loonheffing volgens de aangiften met de verzamelloonstaat en de betaalde loonheffingen in het grootboek, vorig en dit jaar', 'Reconciliation of the wages for social insurance and payroll tax per the returns with the payroll summary and the payroll tax paid in the ledger, last year and this year', {
    ...BOTH,
    docTypes: ['wage_reconciliation'],
    period: 'years_prev_current',
  }),
  line('9i', 'financial', 'Btw-fiscale eenheid: aansluiting tussen de aangifte van de eenheid en de cijfers van dit bedrijf, vorig en dit jaar', 'VAT fiscal unity: reconciliation between the unity’s return and this company’s figures, last year and this year', {
    ...BOTH,
    docTypes: ['fiscal_unity_reconciliation'],
    helpNl: 'Alleen bij een fiscale eenheid; zet de regel anders uit.',
    helpEn: 'Only with a fiscal unity; otherwise switch the line off.',
  }),
  line('9j', 'financial', 'Meerdere activiteiten: kosten en omzet per activiteit, aansluitend op een van de kolommenbalansen', 'Several activities: costs and turnover per activity, agreeing with one of the trial balances', {
    ...BOTH,
    docTypes: ['activity_split'],
    helpNl: 'Alleen bij meerdere activiteiten; zet de regel anders uit.',
    helpEn: 'Only with several activities; otherwise switch the line off.',
  }),

  // ── Overige documenten ──
  line('10', 'other', 'Verklaringen betalingsgedrag voor loonheffingen en btw (en voor de fiscale eenheid, als die er is)', 'Payment-behaviour declarations for payroll tax and VAT (and for the fiscal unity, if any)', {
    ...BOTH,
    docTypes: ['payment_behaviour'],
    maxAgeMonths: 3,
    helpNl: 'Hoogstens 3 maanden oud op de dag van de controle. Vraag ze aan voor inlenersaansprakelijkheid, niet voor ketenaansprakelijkheid.',
    helpEn: 'At most 3 months old on the day of the inspection. Request them for hirer’s liability, not for chain liability.',
  }),
  line('11', 'other', 'De laatste twee jaarrekeningen', 'The last two annual accounts', { ...BOTH, docTypes: ['annual_accounts'], period: 'two_latest' }),
  line('12', 'other', 'Controlerapporten, boetes, afspraken of regelingen met de Belastingdienst, de Arbeidsinspectie en brancheorganisaties (bijvoorbeeld SNCU)', 'Inspection reports, fines, agreements or arrangements with the tax authority, the labour inspectorate and sector bodies (for example SNCU)', {
    ...BOTH,
    docTypes: ['inspection', 'arrangement'],
    optional: true,
    helpNl: 'Alleen als die er zijn.',
    helpEn: 'Only if there are any.',
  }),
  line('13a', 'other', 'Werk uitbesteed aan zzp’ers: hun dossiers en een uitdraai van de grootboekrekening met hun facturen', 'Work outsourced to self-employed people: their files and a ledger printout with their invoices', {
    ...ON_SITE,
    helpNl:
      'Per zzp’er: identiteitsgegevens, de maatregel rond de uitvoering, de overeenkomst met de opdrachtgever en met de zzp’er, de facturen en het KvK-uittreksel bij de start van de opdracht; plus de grootboekrekening van dit en vorig jaar. Zet de regel uit als het niet van toepassing is.',
    helpEn:
      'Per self-employed person: ID details, the control measure for the work, the agreement with the principal and with the self-employed person, the invoices and the KvK extract at the start of the assignment; plus the ledger account of this and last year. Switch the line off when it does not apply.',
  }),
  line('13b', 'other', 'Zzp’ers bemiddeld: de bemiddelingsovereenkomst en de facturen aan de opdrachtgever namens de zzp’er', 'Self-employed people placed through the company: the placement agreement and the invoices to the principal on their behalf', {
    ...ON_SITE,
    helpNl: 'Zet de regel uit als het niet van toepassing is.',
    helpEn: 'Switch the line off when it does not apply.',
  }),
  line('13c', 'other', 'Werk uitbesteed aan of personeel ingeleend van andere bedrijven: grootboekrekening van de inkoopfacturen en de stukken per uitlener of aannemer', 'Work outsourced to, or staff hired from, other companies: the ledger account of the purchase invoices and the papers per lender or contractor', {
    ...ON_SITE,
    helpNl:
      'Bij NEN 4400-gecertificeerde bedrijven: kopieën van de identiteitsbewijzen van de ingeleende werknemers (in elk geval van buiten de EU/EER). Bij niet-gecertificeerde: de grootboekrekening van dit en vorig jaar, de schriftelijke overeenkomst, een recent KvK-uittreksel, de identiteitsbewijzen, wat er op hun G-rekening is gestort en per bedrijf het deel van de eigen omzet van de laatste 12 maanden (hoogstens 5 %). Zet de regel uit als het niet van toepassing is.',
    helpEn:
      'With NEN 4400-certified companies: copies of the hired workers’ ID documents (at least for those from outside the EU/EEA). With non-certified ones: the ledger account of this and last year, the written agreement, a recent KvK extract, the ID documents, what was paid into their G-account and per company the share of the own turnover of the last 12 months (at most 5 %). Switch the line off when it does not apply.',
  }),
  line('14', 'other', 'De NEN 4400-1-rapportages van de laatste 2 controles, als die door een ander inspectiebureau zijn gedaan', 'The NEN 4400-1 reports of the last 2 inspections, when another inspection body did them', {
    ...BOTH,
    docTypes: ['inspection'],
    period: 'two_latest',
    optional: true,
    helpNl: 'Alleen als het vorige bureau een ander was.',
    helpEn: 'Only when the previous body was another one.',
  }),
  line('15', 'other', 'De kasregistratie', 'The cash register records', {
    ...ON_SITE,
    optional: true,
    helpNl: 'Alleen als het bedrijf een kas heeft.',
    helpEn: 'Only when the company has a cash register.',
  }),

  // ── Procedures (op schrift, bijvoorbeeld in een kwaliteitshandboek, of geautomatiseerd) ──
  line('16a', 'procedures', 'Personeelsadministratie: vaststellen van de identiteit (door een derde) en opbouw van het personeelsdossier', 'Personnel administration: establishing identity (by a third party) and building the personnel file', {
    ...PROCEDURE,
    helpNl: 'De procedures staan op papier (bijvoorbeeld in een kwaliteitshandboek) of zijn geautomatiseerd; de inspecteur neemt een kopie op in het dossier. Eén handboek met alle procedures geldt voor alle regels hieronder.',
    helpEn: 'The procedures are written down (for example in a quality handbook) or automated; the inspector keeps a copy in the file. One handbook with all procedures counts for all lines below.',
  }),
  line('16b', 'procedures', 'Personeelsadministratie: inhoudingen en verrekeningen, zoals huisvesting en zorgverzekering', 'Personnel administration: deductions and settlements, such as housing and health insurance', PROCEDURE),
  line('16c', 'procedures', 'Personeelsadministratie: (digitaal) ondertekenen van de stukken in het personeelsdossier', 'Personnel administration: (digital) signing of the documents in the personnel file', PROCEDURE),
  line('16d', 'procedures', 'Loonadministratie: vaststellen van het brutoloon', 'Payroll: setting the gross wage', PROCEDURE),
  line('16e', 'procedures', 'Loonadministratie: vaststellen van vakantie- en verlofrechten', 'Payroll: setting holiday and leave entitlements', PROCEDURE),
  line('16f', 'procedures', 'Loonadministratie: doorvoeren van loonsverhogingen', 'Payroll: applying pay rises', PROCEDURE),
  line('16g', 'procedures', 'Loonadministratie: verwerking en registratie van de uren', 'Payroll: processing and recording the hours', PROCEDURE),
  line('16h', 'procedures', 'Financiële administratie: scheiding van de activiteiten van het bedrijf, bij inkoop en verkoop', 'Financial administration: keeping the company’s activities apart, in purchases and sales', PROCEDURE),
  line('16i', 'procedures', 'Financiële administratie: tijdige verwerking (hoogstens drie maanden)', 'Financial administration: processing on time (at most three months)', PROCEDURE),
  line('16j', 'procedures', 'Financiële administratie: btw- en loonaangiften', 'Financial administration: VAT and payroll tax returns', PROCEDURE),
  line('16k', 'procedures', 'Werk derden: inhuur van of uitbesteden aan bedrijven met het SNA-keurmerk', 'Third-party work: hiring from or outsourcing to companies with the SNA quality mark', PROCEDURE),
  line('16l', 'procedures', 'Werk derden: inhuur van of uitbesteden aan bedrijven zonder het SNA-keurmerk', 'Third-party work: hiring from or outsourcing to companies without the SNA quality mark', PROCEDURE),
  line('16m', 'procedures', 'Werk derden: werk uitbesteden aan of opdrachten geven aan zzp’ers', 'Third-party work: outsourcing work or giving assignments to self-employed people', PROCEDURE),
];

export const SEED_CHECKLISTS: SeedChecklist[] = [
  {
    code: 'nen4400_1',
    nameNl: 'NEN 4400-1 controle',
    nameEn: 'NEN 4400-1 inspection',
    descriptionNl: 'Wat de inspecteur van een NEN 4400-1 / SNA-controle vraagt, volgens de lijst van het inspectiebureau voor de eerste controle. Bij een vervolgcontrole zet je de regels die niet gevraagd worden uit; per regel staat ingesteld hoe vaak hij gevraagd wordt.',
    descriptionEn: 'What the inspector of a NEN 4400-1 / SNA inspection asks for, following the inspection body’s list for the first inspection. At a follow-up inspection, switch off the lines that are not asked for; each line says how often it is asked.',
    inspectionTypes: ['nen4400_periodic', 'nen4400_initial'],
    version: {
      label: 'Cicero versie 13 (4 januari 2023), volgens de pdf',
      note: 'Volgt de pdf van het inspectiebureau (eerste controle) regel voor regel, met dezelfde nummers en kolommen; in eigen woorden, geen letterlijke tekst. 6a en 6b staan op “eens per 12 maanden”, 7b-1 en 7b-2 op “alleen als je hem aanzet”.',
      sections: SECTIONS,
      items: ITEMS,
    },
    replaces: ['Cicero versie 13 (4 januari 2023)'],
    replacesDescription: {
      nl: 'Wat de inspecteur van een NEN 4400-1 / SNA-controle vraagt. Bedoeld voor de periodieke en de eerste controle; maak voor de eerste controle een eigen lijst zodra het inspectiebureau die stuurt.',
      en: 'What the inspector of a NEN 4400-1 / SNA inspection asks for. Meant for the periodic and the initial inspection; make a list of its own for the initial one when the inspection body sends it.',
    },
  },
];
