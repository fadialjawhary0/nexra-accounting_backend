import { AlignmentType, BorderStyle, Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';

/*
 * The starter Word templates, written for the system (synthetic text — no client's or office's real contract). They are examples that show how merge
 * fields work (`{employee.full_name}`, `{contract.start_date_long}`, blocks such as `{#contract.has_probation}…{/contract.has_probation}`); the office
 * replaces them with its own Word files by uploading a new version of each template (Templates → the template → "Upload a new version").
 */

type Block = { title: string } | { heading: string } | { text: string } | { lines: string[] } | { signatures: [string, string] } | { gap: true } | { table: { header: string[]; row: string[]; widths?: number[] } };

export interface StarterTemplate {
  code: string;
  name: string;
  /** Code of the `template_kind` list. */
  kind: 'contract' | 'termination_letter' | 'notice_letter' | 'salary_statement' | 'invoice';
  contractType: string | null;
  description: string;
  blocks: Block[];
}

const PARTIES: Block[] = [
  { text: 'Ondergetekenden:' },
  { text: '1. {client.name}, gevestigd te {client.address}, vertegenwoordigd door {client.representative_name}{#client.representative_role} ({client.representative_role}){/client.representative_role}, hierna te noemen: de werkgever;' },
  { text: '2. {employee.full_name}, geboren op {employee.date_of_birth}, wonende te {employee.address}, hierna te noemen: de werknemer;' },
  { text: 'verklaren het volgende te zijn overeengekomen:' },
];

const PROBATION: Block = { text: '{#contract.has_probation}Er geldt een proeftijd van {contract.probation_months} maand(en).{/contract.has_probation}{^contract.has_probation}Er is geen proeftijd overeengekomen.{/contract.has_probation}' };
// The collective agreement is the employer's (the client form's own field); the contract form does not ask for it (Ahmad, 17-10-2026).
const CAO: Block = { text: '{#client.cao}Op deze overeenkomst is de cao {client.cao} van toepassing.{/client.cao}{^client.cao}Op deze overeenkomst is geen cao van toepassing.{/client.cao}' };
const SIGNING: Block[] = [{ text: 'Aldus overeengekomen en in tweevoud ondertekend te {contract.signing_place} op {contract.signing_date}.' }, { gap: true }, { signatures: ['De werkgever', 'De werknemer'] }];

const letterHead: Block[] = [
  { lines: ['{client.name}', '{client.address}'] },
  { gap: true },
  { text: '{document.place}, {document.today_long}' },
  { gap: true },
  { lines: ['{employee.full_name}', '{employee.address}'] },
  { gap: true },
];

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    code: 'contract_on_call',
    name: 'Arbeidsovereenkomst oproepkracht',
    kind: 'contract',
    contractType: 'on_call',
    description: 'Voorbeeld voor een oproepovereenkomst. Vervang door het eigen sjabloon door een nieuwe versie te uploaden.',
    blocks: [
      { title: 'ARBEIDSOVEREENKOMST OPROEPKRACHT' },
      ...PARTIES,
      { heading: 'Artikel 1 – Aanvang en duur' },
      { text: 'De arbeidsovereenkomst gaat in op {contract.start_date_long}.{#contract.has_end_date} De overeenkomst is aangegaan voor bepaalde tijd, {contract.period_text} ({contract.duration_text}), en eindigt van rechtswege op {contract.end_date_long}, zonder dat opzegging is vereist.{/contract.has_end_date}{^contract.has_end_date} De overeenkomst is aangegaan voor onbepaalde tijd.{/contract.has_end_date}' },
      { heading: 'Artikel 2 – Functie' },
      { text: 'De werknemer treedt in dienst als {contract.function}, op afroep. Er is geen vaste arbeidsduur overeengekomen.' },
      { heading: 'Artikel 3 – Proeftijd' },
      PROBATION,
      { heading: 'Artikel 4 – Oproep' },
      { text: 'De werkgever roept de werknemer op wanneer er werk is, uiterlijk vier dagen voor aanvang van de werkzaamheden. Bij een latere oproep is de werknemer niet verplicht gehoor te geven. Een tijdige oproep volgt de werknemer op.' },
      { heading: 'Artikel 5 – Loon' },
      { text: 'Het bruto loon bedraagt {contract.hourly_rate} per uur. Voor elke oproep wordt het loon over ten minste drie uur betaald. Het loon wordt maandelijks achteraf uitbetaald; de werknemer ontvangt een loonstrook.' },
      { heading: 'Artikel 6 – Vakantie' },
      { text: 'De werknemer bouwt over de gewerkte uren betaalde vakantie-uren op, ten minste het wettelijke aantal.' },
      { heading: 'Artikel 7 – Arbeidsongeschiktheid' },
      { text: 'Bij arbeidsongeschiktheid heeft de werknemer recht op loon over de uren waarvoor hij of zij was opgeroepen of ingeroosterd, overeenkomstig de wet.' },
      { heading: 'Artikel 8 – Cao' },
      CAO,
      { heading: 'Slot' },
      ...SIGNING,
    ],
  },
  {
    code: 'contract_fixed_term',
    name: 'Arbeidsovereenkomst voor bepaalde tijd',
    kind: 'contract',
    contractType: 'fixed_term',
    description: 'Voorbeeld voor een contract voor bepaalde tijd. Vervang door het eigen sjabloon door een nieuwe versie te uploaden.',
    blocks: [
      { title: 'ARBEIDSOVEREENKOMST VOOR BEPAALDE TIJD' },
      ...PARTIES,
      { heading: 'Artikel 1 – Duur' },
      { text: 'De arbeidsovereenkomst is aangegaan voor bepaalde tijd, {contract.period_text} ({contract.duration_text}). De overeenkomst eindigt van rechtswege op {contract.end_date_long}, zonder dat opzegging is vereist.' },
      { heading: 'Artikel 2 – Functie' },
      { text: 'De werknemer treedt in dienst als {contract.function}.' },
      { heading: 'Artikel 3 – Proeftijd' },
      PROBATION,
      { heading: 'Artikel 4 – Arbeidsduur en werktijden' },
      { text: 'De arbeidsduur bedraagt {contract.hours_per_week} uur per week, verdeeld over {contract.working_days}. De gebruikelijke werktijden zijn {contract.working_hours}. De standplaats is {contract.workplace}.' },
      { heading: 'Artikel 5 – Loon' },
      { text: 'Het bruto maandloon bedraagt {contract.monthly_salary} bij een volledige werkweek. Het loon wordt maandelijks achteraf uitbetaald; de werknemer ontvangt een loonstrook.' },
      { heading: 'Artikel 6 – Vakantietoeslag' },
      { text: 'De werknemer ontvangt {contract.holiday_allowance_percent}% vakantietoeslag over het loon. De opbouwperiode is {contract.holiday_accrual_period}; de uitbetaling vindt plaats in {contract.holiday_payout_month}.' },
      { heading: 'Artikel 7 – Vakantie' },
      { text: 'De werknemer heeft per jaar recht op ten minste het wettelijke aantal vakantiedagen: vier keer de overeengekomen arbeidsduur per week.' },
      { heading: 'Artikel 8 – Arbeidsongeschiktheid' },
      { text: 'Bij arbeidsongeschiktheid heeft de werknemer recht op loondoorbetaling overeenkomstig de wet.' },
      { heading: 'Artikel 9 – Cao' },
      CAO,
      { heading: 'Slot' },
      ...SIGNING,
    ],
  },
  {
    code: 'contract_permanent',
    name: 'Arbeidsovereenkomst voor onbepaalde tijd',
    kind: 'contract',
    contractType: 'permanent',
    description: 'Voorbeeld voor een contract voor onbepaalde tijd. Vervang door het eigen sjabloon door een nieuwe versie te uploaden.',
    blocks: [
      { title: 'ARBEIDSOVEREENKOMST VOOR ONBEPAALDE TIJD' },
      ...PARTIES,
      { heading: 'Artikel 1 – Aanvang' },
      { text: 'De arbeidsovereenkomst is aangegaan voor onbepaalde tijd en gaat in op {contract.start_date_long}.' },
      { heading: 'Artikel 2 – Functie' },
      { text: 'De werknemer treedt in dienst als {contract.function}.' },
      { heading: 'Artikel 3 – Proeftijd' },
      PROBATION,
      { heading: 'Artikel 4 – Arbeidsduur en werktijden' },
      { text: 'De arbeidsduur bedraagt {contract.hours_per_week} uur per week, verdeeld over {contract.working_days}. De gebruikelijke werktijden zijn {contract.working_hours}. De standplaats is {contract.workplace}.' },
      { heading: 'Artikel 5 – Loon' },
      { text: 'Het bruto maandloon bedraagt {contract.monthly_salary} bij een volledige werkweek. Het loon wordt maandelijks achteraf uitbetaald; de werknemer ontvangt een loonstrook.' },
      { heading: 'Artikel 6 – Vakantietoeslag en vakantie' },
      { text: 'De werknemer ontvangt {contract.holiday_allowance_percent}% vakantietoeslag (opbouwperiode {contract.holiday_accrual_period}, uitbetaling in {contract.holiday_payout_month}) en heeft per jaar recht op ten minste het wettelijke aantal vakantiedagen: vier keer de overeengekomen arbeidsduur per week.' },
      { heading: 'Artikel 7 – Beëindiging' },
      { text: 'De overeenkomst kan worden beëindigd met inachtneming van de wettelijke opzegtermijnen en procedures.' },
      { heading: 'Artikel 8 – Cao' },
      CAO,
      { heading: 'Slot' },
      ...SIGNING,
    ],
  },
  {
    code: 'contract_internship',
    name: 'Stageovereenkomst',
    kind: 'contract',
    contractType: 'internship',
    description: 'Voorbeeld voor een stageovereenkomst. Vervang door het eigen sjabloon door een nieuwe versie te uploaden.',
    blocks: [
      { title: 'STAGEOVEREENKOMST' },
      { text: 'Ondergetekenden:' },
      { text: '1. {client.name}, gevestigd te {client.address}, vertegenwoordigd door {client.representative_name}, hierna te noemen: de stagebieder;' },
      { text: '2. {employee.full_name}, geboren op {employee.date_of_birth}, wonende te {employee.address}, hierna te noemen: de stagiair;' },
      { text: 'verklaren het volgende te zijn overeengekomen:' },
      { heading: 'Artikel 1 – Duur' },
      { text: 'De stage vindt plaats {contract.period_text} ({contract.duration_text}).' },
      { heading: 'Artikel 2 – Werkzaamheden en uren' },
      { text: 'De stagiair verricht werkzaamheden als {contract.function}, gemiddeld {contract.hours_per_week} uur per week op {contract.workplace}.' },
      { heading: 'Artikel 3 – Vergoeding' },
      { text: 'De stagiair ontvangt een stagevergoeding van {contract.monthly_salary} bruto per maand.' },
      { heading: 'Slot' },
      ...SIGNING.slice(0, 2),
      { signatures: ['De stagebieder', 'De stagiair'] },
    ],
  },
  {
    code: 'contract_freelance',
    name: 'Overeenkomst ZZP',
    kind: 'contract',
    contractType: 'freelance',
    description: 'Voorbeeld voor een overeenkomst met een zelfstandige (zzp’er). Vervang door het eigen sjabloon door een nieuwe versie te uploaden.',
    blocks: [
      { title: 'OVEREENKOMST ZZP' },
      { text: 'Ondergetekenden:' },
      { text: '1. {client.name}, gevestigd te {client.address}, vertegenwoordigd door {client.representative_name}, hierna te noemen: de opdrachtgever;' },
      { text: '2. {employee.full_name}, wonende te {employee.address}, hierna te noemen: de opdrachtnemer;' },
      { text: 'verklaren het volgende te zijn overeengekomen:' },
      { heading: 'Artikel 1 – Opdracht' },
      { text: 'De opdrachtnemer verricht werkzaamheden als {contract.function}, {contract.period_text}.' },
      { heading: 'Artikel 2 – Tarief' },
      { text: 'Het tarief bedraagt {contract.hourly_rate} per uur, exclusief btw. De opdrachtnemer factureert maandelijks achteraf.' },
      { heading: 'Artikel 3 – Zelfstandigheid' },
      { text: 'De opdrachtnemer werkt zelfstandig, bepaalt zelf de wijze waarop de werkzaamheden worden uitgevoerd en is zelf verantwoordelijk voor zijn of haar belastingen en verzekeringen.' },
      { heading: 'Slot' },
      ...SIGNING.slice(0, 2),
      { signatures: ['De opdrachtgever', 'De opdrachtnemer'] },
    ],
  },
  {
    code: 'contract_services',
    name: 'Overeenkomst van opdracht',
    kind: 'contract',
    contractType: 'services',
    description: 'Voorbeeld voor een overeenkomst van opdracht. Vervang door het eigen sjabloon door een nieuwe versie te uploaden.',
    blocks: [
      { title: 'OVEREENKOMST VAN OPDRACHT' },
      { text: 'Ondergetekenden:' },
      { text: '1. {client.name}, gevestigd te {client.address}, vertegenwoordigd door {client.representative_name}, hierna te noemen: de opdrachtgever;' },
      { text: '2. {employee.full_name}, wonende te {employee.address}, hierna te noemen: de opdrachtnemer;' },
      { text: 'verklaren het volgende te zijn overeengekomen:' },
      { heading: 'Artikel 1 – Opdracht en looptijd' },
      { text: 'De opdrachtnemer voert de opdracht “{contract.function}” uit, {contract.period_text}.' },
      { heading: 'Artikel 2 – Vergoeding' },
      { text: 'De vergoeding bedraagt {contract.hourly_rate} per uur, exclusief btw, te betalen na ontvangst van de factuur.' },
      { heading: 'Slot' },
      ...SIGNING.slice(0, 2),
      { signatures: ['De opdrachtgever', 'De opdrachtnemer'] },
    ],
  },
  {
    code: 'termination_on_call',
    name: 'Beëindiging arbeidsovereenkomst oproepkracht',
    kind: 'termination_letter',
    contractType: 'on_call',
    description: 'Brief bij het beëindigen van een oproepovereenkomst (zonder opzegtermijn). Voorbeeld — vervang door het eigen sjabloon.',
    blocks: [
      ...letterHead,
      { text: 'Betreft: beëindiging arbeidsovereenkomst oproepkracht' },
      { gap: true },
      { text: '{employee.salutation_line},' },
      { text: 'Hierbij bevestigen wij dat de arbeidsovereenkomst van {contract.start_date_long} tussen u en {client.name} eindigt per {contract.terminated_on_long}.' },
      { text: 'Reden: {contract.termination_reason}.{#contract.termination_note} {contract.termination_note}{/contract.termination_note}' },
      { text: 'Omdat het een oproepovereenkomst zonder vaste arbeidsduur betreft, geldt er geen opzegtermijn.' },
      { text: 'Wij bedanken u voor uw inzet en wensen u het beste.' },
      { gap: true },
      { text: 'Met vriendelijke groet,' },
      { gap: true },
      { lines: ['{client.representative_name}', '{client.representative_role}', '{client.name}'] },
    ],
  },
  {
    code: 'termination_letter',
    name: 'Beëindigingsbrief',
    kind: 'termination_letter',
    contractType: null,
    description: 'Algemene brief bij het beëindigen van een contract. Voorbeeld — vervang door het eigen sjabloon.',
    blocks: [
      ...letterHead,
      { text: 'Betreft: beëindiging arbeidsovereenkomst' },
      { gap: true },
      { text: '{employee.salutation_line},' },
      { text: 'Hierbij bevestigen wij dat uw arbeidsovereenkomst met {client.name} (ingegaan op {contract.start_date_long}) eindigt per {contract.terminated_on_long}.' },
      { text: 'Reden: {contract.termination_reason}.{#contract.termination_note} {contract.termination_note}{/contract.termination_note}' },
      { text: 'Wij bedanken u voor uw inzet en wensen u het beste.' },
      { gap: true },
      { text: 'Met vriendelijke groet,' },
      { gap: true },
      { lines: ['{client.representative_name}', '{client.representative_role}', '{client.name}'] },
    ],
  },
  {
    code: 'salary_statement_default',
    name: 'Loonstaat',
    kind: 'salary_statement',
    contractType: null,
    description: 'Voorbeeld van een loonstaat per werknemer en periode (dag, uren, tarief, bedrag, totalen). Vervang door het eigen sjabloon door een nieuwe versie te uploaden.',
    blocks: [
      { title: 'LOONSTAAT' },
      { lines: ['{client.name}', '{client.address}'] },
      { gap: true },
      { text: 'Werknemer: {employee.full_name}' },
      { text: 'Periode: {statement.period_text}' },
      { text: 'Opgemaakt op {statement.created_on} door {office.name}' },
      { gap: true },
      { table: { header: ['Datum', 'Omschrijving', 'Uren', 'Uurloon', 'Bedrag'], widths: [20, 38, 10, 16, 16], row: ['{#statement.lines}{weekday} {date}', '{description}', '{hours}', '{rate}', '{amount}{/statement.lines}'] } },
      { gap: true },
      { text: 'Totaal aantal uren: {statement.total_hours} ({statement.days_count} dagen)' },
      { text: 'Loon over de uren: {statement.base_amount}' },
      // A block that may be absent has its opening and closing tag in paragraphs of their own: without the block, those paragraphs disappear too.
      { text: '{#statement.has_surcharges}' },
      { text: 'Toeslagen: {statement.surcharge_amount}' },
      { text: '{/statement.has_surcharges}' },
      { text: 'Brutoloon: {statement.gross_amount}' },
      { text: '{#statement.has_allowance}' },
      { text: 'Vakantietoeslag ({statement.allowance_percent}%): {statement.allowance_amount}' },
      { text: 'Totaal bruto inclusief vakantietoeslag: {statement.total_amount}' },
      { text: '{/statement.has_allowance}' },
      { text: '{#statement.has_vacation}' },
      { text: 'Opgebouwde vakantie-uren: {statement.vacation_hours}' },
      { text: '{/statement.has_vacation}' },
      { text: '{#statement.has_note}' },
      { text: 'Opmerking: {statement.note}' },
      { text: '{/statement.has_note}' },
      { gap: true },
      { text: 'Dit is een bruto-overzicht van de gewerkte uren. Netto loon, loonheffing en loonstroken staan in de salarisadministratie.' },
    ],
  },
  {
    code: 'invoice_default',
    name: 'Factuur',
    kind: 'invoice',
    contractType: null,
    description: 'Voorbeeld van een factuur voor gewerkte uren (een regel per werknemer, btw, deel voor de G-rekening). Vervang door het eigen sjabloon door een nieuwe versie te uploaden.',
    blocks: [
      { title: '{#invoice.is_credit}CREDITNOTA{/invoice.is_credit}{^invoice.is_credit}FACTUUR{/invoice.is_credit}' },
      { lines: ['{client.name}', '{client.address}', 'KvK: {client.kvk} · BTW: {client.vat_number}'] },
      { gap: true },
      { heading: 'Factuur aan' },
      { lines: ['{recipient.name}', '{recipient.street_line}', '{recipient.city_line}'] },
      { gap: true },
      { text: 'Factuurnummer: {invoice.number}' },
      { text: 'Factuurdatum: {invoice.date}' },
      { text: '{^invoice.is_credit}' },
      { text: 'Vervaldatum: {invoice.due_date}' },
      { text: '{/invoice.is_credit}' },
      { text: 'Periode: {invoice.period_text}' },
      // A line that may be absent has its opening and closing tag in paragraphs of its own: without the block, those paragraphs disappear too.
      { text: '{#invoice.has_credit_of}' },
      { text: 'Deze creditnota heft factuur {invoice.credit_of_number} op.' },
      { text: '{/invoice.has_credit_of}' },
      { text: '{#invoice.reference}' },
      { text: 'Uw referentie: {invoice.reference}' },
      { text: '{/invoice.reference}' },
      { gap: true },
      { table: { header: ['Omschrijving', 'Periode', 'Uren', 'Tarief', 'Bedrag'], row: ['{#invoice.lines}{description}', '{period}', '{hours}', '{rate}', '{amount}{/invoice.lines}'], widths: [28, 32, 9, 14, 17] } },
      { gap: true },
      { text: 'Totaal van de regels: {invoice.subtotal}' },
      { text: '{#invoice.vat_shifted}' },
      { text: 'BTW verlegd naar de afnemer.' },
      { text: '{/invoice.vat_shifted}' },
      { text: '{^invoice.vat_shifted}' },
      { text: 'BTW ({invoice.vat_percent}%): {invoice.vat_amount}' },
      { text: '{/invoice.vat_shifted}' },
      { text: 'Totaal: {invoice.total}' },
      { text: '{#invoice.has_g_account}' },
      { text: 'Hiervan te betalen op de G-rekening ({invoice.g_account_percent}%): {invoice.g_account_amount}' },
      { text: 'Te betalen op de gewone rekening: {invoice.net_amount}' },
      { text: '{/invoice.has_g_account}' },
      { gap: true },
      { text: '{^invoice.is_credit}' },
      // The bank account is only named when the client has one on file.
      { text: '{#client.iban_1}' },
      { text: 'Wij verzoeken u het bedrag binnen {invoice.payment_days} dagen over te maken op IBAN {client.iban_1}, onder vermelding van het factuurnummer.' },
      { text: '{/client.iban_1}' },
      { text: '{^client.iban_1}' },
      { text: 'Wij verzoeken u het bedrag binnen {invoice.payment_days} dagen over te maken, onder vermelding van het factuurnummer.' },
      { text: '{/client.iban_1}' },
      { text: '{/invoice.is_credit}' },
      { text: '{#invoice.remarks}' },
      { text: '{invoice.remarks}' },
      { text: '{/invoice.remarks}' },
    ],
  },
  {
    code: 'notice_non_renewal',
    name: 'Aanzegbrief (voortzetting contract)',
    kind: 'notice_letter',
    contractType: 'fixed_term',
    description: 'Brief waarin de werkgever uiterlijk een maand voor het einde schriftelijk laat weten of een contract voor bepaalde tijd wordt voortgezet (aanzegverplichting). Voorbeeld — vervang door het eigen sjabloon.',
    blocks: [
      ...letterHead,
      { text: 'Betreft: aanzegging einde arbeidsovereenkomst voor bepaalde tijd' },
      { gap: true },
      { text: '{employee.salutation_line},' },
      { text: 'Uw arbeidsovereenkomst voor bepaalde tijd met {client.name}, {contract.period_text}, eindigt van rechtswege op {contract.end_date_long}.' },
      { text: 'Met deze brief laten wij u, voor de uiterste datum van {contract.notice_deadline_long}, schriftelijk weten:' },
      { text: '☐ dat de arbeidsovereenkomst na deze datum niet wordt voortgezet;' },
      { text: '☐ dat de arbeidsovereenkomst wordt voortgezet onder de volgende voorwaarden: ………………………………………………' },
      { gap: true },
      { text: 'Met vriendelijke groet,' },
      { gap: true },
      { lines: ['{client.representative_name}', '{client.representative_role}', '{client.name}'] },
    ],
  },
];

const BODY_SIZE = 22;

const paragraph = (text: string, options: { bold?: boolean; size?: number; center?: boolean; right?: boolean; after?: number } = {}): Paragraph =>
  new Paragraph({
    alignment: options.center ? AlignmentType.CENTER : options.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
    spacing: { after: options.after ?? 160 },
    children: [new TextRun({ text, bold: options.bold, size: options.size ?? BODY_SIZE, font: 'Calibri' })],
  });

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } as const;
const noBorders = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER } as const;

const signatureCell = (label: string): TableCell =>
  new TableCell({
    borders: noBorders,
    width: { size: 50, type: WidthType.PERCENTAGE },
    children: [paragraph(label, { bold: true }), paragraph(' ', { after: 600 }), paragraph('………………………………………'), paragraph('Naam:'), paragraph('Datum:')],
  });

/**
 * A table with a heading row and one row that repeats: its first cell holds the opening of the loop (`{#statement.lines}{date}`) and its last
 * cell the closing (`{amount}{/statement.lines}`) — the way Word tables are repeated by the merge engine. The last three columns are numbers.
 */
function loopTable(spec: { header: string[]; row: string[]; widths?: number[] }): Table {
  const numeric = (index: number) => index >= spec.header.length - 3;
  const cell = (text: string, index: number, header: boolean) =>
    new TableCell({
      width: spec.widths?.[index] ? { size: spec.widths[index]!, type: WidthType.PERCENTAGE } : undefined,
      shading: header ? { fill: 'F0E6C5' } : undefined,
      margins: { top: 40, bottom: 40, left: 80, right: 80 },
      children: [paragraph(text, { bold: header, right: numeric(index), after: 0 })],
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ tableHeader: true, children: spec.header.map((text, index) => cell(text, index, true)) }), new TableRow({ children: spec.row.map((text, index) => cell(text, index, false)) })],
  });
}

/** Turns a spec into a Word file. One run per paragraph, so a merge field is never split in two by the file's own formatting. */
export async function buildStarterDocx(spec: StarterTemplate): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];
  for (const block of spec.blocks) {
    if ('title' in block) children.push(paragraph(block.title, { bold: true, size: 30, center: true, after: 320 }));
    else if ('heading' in block) children.push(paragraph(block.heading, { bold: true, after: 80 }));
    else if ('text' in block) children.push(paragraph(block.text));
    else if ('lines' in block) block.lines.forEach((line, index) => children.push(paragraph(line, { after: index === block.lines.length - 1 ? 160 : 0 })));
    else if ('table' in block) children.push(loopTable(block.table));
    else if ('signatures' in block) children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: { ...noBorders, insideHorizontal: NO_BORDER, insideVertical: NO_BORDER }, rows: [new TableRow({ children: block.signatures.map(signatureCell) })] }));
    else children.push(paragraph(' ', { after: 120 }));
  }
  const document = new Document({ creator: 'Nexra B.V.', title: spec.name, sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1304, right: 1304 } } }, children }] });
  return Packer.toBuffer(document);
}
