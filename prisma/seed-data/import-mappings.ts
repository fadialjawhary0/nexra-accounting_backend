/**
 * The column layouts of the spreadsheets Ahmad works with, so the first import suggests them at once (Phase 11). `header` is what the column is called
 * in his sheet, `field` what it is read into (`client.name`, `person.first_name`, `client.@address` …; `null` = left out). Only *created* by the seed: the
 * office edits or switches them off in Settings → Import. Headings only — no data of his is in here.
 */
export interface SeedMapping {
  name: string;
  target: 'client' | 'employee' | 'hours';
  columns: Array<{ header: string; field: string | null }>;
  options: Record<string, unknown>;
}

const KLANTEN: SeedMapping['columns'] = [
  { header: 'nr.', field: 'client.number' },
  { header: 'Bedrijf', field: 'client.name' },
  { header: 'Rechtsvorm', field: 'client.legal_form' },
  // The owner as initial and surname: the next two columns hold the same person in pieces.
  { header: 'Werkgever', field: null },
  { header: 'Voornaam', field: 'person.first_name' },
  { header: 'Achternaam', field: 'person.last_name' },
  { header: 'Adres', field: 'client.@address' },
  { header: 'Postcode', field: 'client.postal_code' },
  { header: 'Stad', field: 'client.city' },
  { header: 'Telefoonnummer', field: 'client.phone_1' },
  { header: 'Email', field: 'client.email_1' },
  { header: 'KvK', field: 'client.kvk' },
  { header: 'BTW-Nummer', field: 'client.vat_number' },
];

export const SEED_MAPPINGS: SeedMapping[] = [
  { name: 'KLANTEN (Ahmad)', target: 'client', columns: KLANTEN, options: { duplicates: 'fill', stopped: false } },
  { name: 'KLANTEN GESTOPT (Ahmad)', target: 'client', columns: KLANTEN, options: { duplicates: 'fill', stopped: true } },
  {
    name: 'Bedrijfsgegevens — veldnamen van Ahmad',
    target: 'client',
    columns: [
      { header: 'Bedrijfsnaam', field: 'client.name' },
      { header: 'Contactpersoon', field: 'client.contact_person' },
      { header: 'Straatnaam', field: 'client.street' },
      { header: 'Huisnummer', field: 'client.house_number' },
      { header: 'Toevoeging', field: 'client.house_number_suffix' },
      { header: 'Postcode', field: 'client.postal_code' },
      { header: 'Plaats', field: 'client.city' },
      { header: 'Telefoon 1', field: 'client.phone_1' },
      { header: 'Telefoon 2', field: 'client.phone_2' },
      { header: 'IBAN 1', field: 'client.iban_1' },
      { header: 'IBAN 2', field: 'client.iban_2' },
      { header: 'G-rekening', field: 'client.g_account' },
      { header: 'Rechtsvorm', field: 'client.legal_form' },
      { header: 'BTW-nummer', field: 'client.vat_number' },
      { header: 'Btw-identificatienummer', field: 'client.vat_id_number' },
      { header: 'KvK-nummer', field: 'client.kvk' },
      { header: 'E-mail 1', field: 'client.email_1' },
      { header: 'E-mail 2', field: 'client.email_2' },
    ],
    options: { duplicates: 'fill', stopped: false },
  },
  {
    name: 'Werknemers — veldnamen van Ahmad',
    target: 'employee',
    columns: [
      { header: 'Achternaam', field: 'person.last_name' },
      { header: 'Voorletters', field: 'person.initials' },
      { header: 'Voornaam', field: 'person.first_name' },
      { header: 'Straatnaam', field: 'person.street' },
      { header: 'Huisnummer', field: 'person.house_number' },
      { header: 'Toevoeging', field: 'person.house_number_suffix' },
      { header: 'Postcode', field: 'person.postal_code' },
      { header: 'Plaats', field: 'person.city' },
      { header: 'Geboortedatum', field: 'person.date_of_birth' },
      { header: 'BSN', field: 'person.bsn' },
      { header: 'IBAN', field: 'person.iban' },
    ],
    options: { duplicates: 'fill', stopped: false },
  },
  {
    name: 'Urenstaat per week (Ma–Zo)',
    target: 'hours',
    columns: [
      { header: 'Naam', field: 'hours.worker' },
      { header: 'Ma', field: 'hours.weekday:0' },
      { header: 'Di', field: 'hours.weekday:1' },
      { header: 'Wo', field: 'hours.weekday:2' },
      { header: 'Do', field: 'hours.weekday:3' },
      { header: 'Vr', field: 'hours.weekday:4' },
      { header: 'Za', field: 'hours.weekday:5' },
      { header: 'Zo', field: 'hours.weekday:6' },
      { header: 'Totaal', field: null },
    ],
    options: { duplicates: 'fill', layout: 'grid' },
  },
];
