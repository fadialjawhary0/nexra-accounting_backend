import { fold } from '../../common/text.js';
import type { FieldType, Named } from '../forms/form-doc.js';
import type { SheetTarget } from './imports.constants.js';

/** One field a spreadsheet column can be read into: `field` is `<record>.<form field key>` (`client.name`, `person.first_name`) or a composite (`client.@address`). */
export interface TargetField {
  field: string;
  /** The record it belongs to (`client`, `person`, `employee`, `hours`). */
  section: string;
  labels: Named;
  type: FieldType | 'composite';
  required: boolean;
  /** Not a field of a form: a composite (an address line) or a fixed field of the hours import — the screen names it in its own words. */
  special?: boolean;
}

/** A column of the sheet and the field it is read into (`null` = left out). */
export interface MappingColumn {
  index: number;
  header: string;
  field: string | null;
}

/** What a saved mapping remembers of a column: the heading (so the order of the columns may change) and the field. */
export interface SavedColumn {
  header: string;
  field: string | null;
}

/** How a heading is compared: no capitals, accents, spaces or punctuation ("Huisnr." = "huisnr"). */
export const normalizeHeader = (header: string): string => fold(header).replace(/[^a-z0-9]/g, '');

/** Words people use as column headings for each field (compared normalised). Saved mappings cover whatever the office calls its own columns. */
const SYNONYMS: Record<string, string[]> = {
  'client.number': ['nr', 'nummer', 'klantnr', 'klantnummer', 'relatienummer', 'relatienr', 'debiteurnummer', 'debiteurnr', 'klnr', 'no', 'kl nr'],
  'client.name': ['bedrijf', 'bedrijfsnaam', 'naam', 'naambedrijf', 'klant', 'klantnaam', 'firma', 'onderneming', 'statutairenaam', 'tenaamstelling', 'naamklant', 'naam onderneming'],
  'client.trade_name': ['handelsnaam'],
  'client.legal_form': ['rechtsvorm', 'vorm', 'bedrijfsvorm', 'type', 'soort'],
  'client.contact_person': ['contactpersoon', 'contact', 'tav', 'ta v'],
  'client.street': ['straat', 'straatnaam'],
  'client.house_number': ['huisnummer', 'huisnr', 'nr', 'hnr'],
  'client.house_number_suffix': ['toevoeging', 'huisnummertoevoeging', 'toev', 'huisnrtoevoeging'],
  'client.postal_code': ['postcode', 'pc', 'postcd'],
  'client.city': ['plaats', 'woonplaats', 'stad', 'vestigingsplaats', 'plaatsnaam'],
  'client.phone_1': ['telefoon', 'tel', 'telefoonnummer', 'telnr', 'tel1', 'telefoon1', 'telefoonnr'],
  'client.phone_2': ['telefoon2', 'tel2', 'telefoonnummer2'],
  'client.email_1': ['email', 'emailadres', 'mail', 'email1', 'mailadres'],
  'client.email_2': ['email2', 'emailadres2'],
  'client.iban_1': ['iban', 'bankrekening', 'rekeningnummer', 'rekening', 'iban1', 'bankrekeningnummer'],
  'client.iban_2': ['iban2'],
  'client.g_account': ['grekening', 'gaccount', 'g rekening', 'grekeningnummer'],
  'client.kvk': ['kvk', 'kvknummer', 'kvknr', 'kamervankoophandel', 'kvk nummer'],
  'client.vat_number': ['btw', 'btwnummer', 'btwnr', 'omzetbelastingnummer', 'btw nummer', 'vat', 'vatnumber'],
  'client.vat_id_number': ['btwid', 'btwidentificatienummer', 'btwidnummer'],
  'client.rsin': ['rsin'],
  'client.payroll_tax_number': ['loonheffingennummer', 'loonheffingsnummer', 'lhnummer', 'lhnr', 'loonheffingen', 'loonheffingennr'],
  'client.notes': ['opmerking', 'opmerkingen', 'notitie', 'notities', 'memo', 'toelichting'],
  'client.sector': ['branche', 'sector'],
  'client.@address': ['adres', 'adresregel', 'bezoekadres', 'vestigingsadres', 'straatennummer', 'straatenhuisnummer'],
  'client.@postcode_city': ['postcodeplaats', 'postcodeenplaats', 'postcodewoonplaats'],
  'person.first_name': ['voornaam', 'voornamen', 'roepnaam'],
  'person.last_name': ['achternaam', 'familienaam'],
  'person.infix': ['tussenvoegsel', 'tussenvoegsels', 'voorvoegsel'],
  'person.initials': ['voorletters', 'initialen'],
  'person.date_of_birth': ['geboortedatum', 'gebdatum', 'geb datum', 'geboren', 'geboortedatumeigenaar', 'dob'],
  'person.bsn': ['bsn', 'burgerservicenummer', 'sofinummer', 'sofi'],
  'person.nationality': ['nationaliteit', 'nat'],
  'person.mobile': ['mobiel', 'mobielnummer', 'gsm', 'mobieltelefoon', 'mobiel nummer'],
  'person.@full_name': ['eigenaar', 'naameigenaar', 'eigenaarnaam', 'directeur', 'bestuurder', 'naamdirecteur', 'ondernemer', 'volledigenaam', 'werknemer', 'medewerker', 'naamwerknemer', 'naammedewerker', 'werknemersnaam'],
  'person.phone': ['telefoon', 'tel', 'telefoonnummer', 'telnr'],
  'person.email': ['email', 'emailadres', 'mail', 'emailwerknemer'],
  'person.iban': ['iban', 'rekeningnummer', 'bankrekening'],
  'person.street': ['straat', 'straatnaam'],
  'person.house_number': ['huisnummer', 'huisnr', 'nr'],
  'person.house_number_suffix': ['toevoeging', 'toev'],
  'person.postal_code': ['postcode', 'pc'],
  'person.city': ['plaats', 'woonplaats', 'stad'],
  'person.@address': ['adres', 'adresregel', 'woonadres'],
  'person.id_number': ['documentnummer', 'idnummer', 'paspoortnummer', 'idkaartnummer', 'legitimatiebewijs', 'legitimatienummer'],
  'person.id_expiry': ['geldigtot', 'geldigheid', 'verloopdatum', 'idgeldigtot', 'vervaldatum'],
  'employee.client': ['klant', 'klantnummer', 'klantnr', 'werkgever', 'bedrijf', 'bedrijfsnaam', 'inlener'],
  'employee.function': ['functie', 'beroep', 'functieomschrijving'],
  'employee.start_date': ['indienst', 'indienstdatum', 'startdatum', 'begindatum', 'datumindienst', 'ingangsdatum', 'indienstvanaf', 'indienstreding'],
  'employee.end_date': ['uitdienst', 'uitdienstdatum', 'einddatum', 'datumuitdienst', 'uitdienstper'],
  'employee.hourly_rate': ['uurloon', 'uurtarief', 'loonperuur', 'brutouurloon', 'tarief', 'uurloonbruto'],
  'employee.notes': ['opmerking', 'opmerkingen', 'notitie', 'notities'],
  'hours.worker': ['werknemer', 'medewerker', 'naam', 'werknemersnaam', 'naamwerknemer', 'naammedewerker', 'persoon', 'achternaam'],
  'hours.client': ['klant', 'bedrijf', 'werkgever', 'klantnummer', 'klantnr', 'inlener'],
  'hours.date': ['datum', 'dag', 'werkdatum'],
  'hours.hours': ['uren', 'aantaluren', 'gewerkt', 'totaaluren', 'urentotaal', 'urengewerkt', 'totaal'],
  'hours.start': ['begin', 'van', 'starttijd', 'aanvang', 'begintijd'],
  'hours.end': ['eind', 'tot', 'eindtijd', 'einde'],
  'hours.break': ['pauze', 'pauzetijd'],
  'hours.workplace': ['locatie', 'werkplek', 'project', 'werkplekofproject', 'standplaats'],
  'hours.note': ['opmerking', 'opmerkingen', 'notitie', 'toelichting'],
};

/** For an ambiguous heading ("Telefoon" is a field of the client and of the person) the record listed first wins. */
const PREFERRED_SECTIONS: Record<SheetTarget, string[]> = { client: ['client', 'person'], employee: ['employee', 'person'], hours: ['hours'] };

/** A score of 0–100 for how well a heading fits a field; 0 = not at all. */
function scoreOf(header: string, field: TargetField): number {
  const heading = normalizeHeader(header);
  if (!heading) return 0;
  const key = normalizeHeader(field.field.split('.')[1] ?? '');
  const labels = [field.labels.nl, field.labels.en].map(normalizeHeader).filter(Boolean);
  if (heading === key || labels.includes(heading)) return 100;
  const synonyms = (SYNONYMS[field.field] ?? []).map(normalizeHeader);
  if (synonyms.includes(heading)) return 90;
  if (heading.length >= 4) {
    if (labels.some(label => label.length >= 4 && (heading.startsWith(label) || label.startsWith(heading)))) return 60;
    if (synonyms.some(word => word.length >= 4 && heading.startsWith(word))) return 55;
  }
  return 0;
}

/**
 * Suggests the field for each heading: the best fit of every heading, each field used once (the better heading wins), nothing below 55.
 * Where two records have the same field (a client's and a person's phone number) the record the target prefers wins a tie.
 */
export function autoMap(headers: readonly string[], fields: readonly TargetField[], target: SheetTarget): Array<string | null> {
  const preferred = PREFERRED_SECTIONS[target];
  const candidates: Array<{ column: number; field: string; score: number }> = [];
  headers.forEach((header, column) => {
    for (const field of fields) {
      const base = scoreOf(header, field);
      if (base < 55) continue;
      const rank = preferred.indexOf(field.section);
      candidates.push({ column, field: field.field, score: base * 10 - (rank < 0 ? 9 : rank) });
    }
  });
  candidates.sort((a, b) => b.score - a.score);
  const result: Array<string | null> = headers.map(() => null);
  const usedColumns = new Set<number>();
  const usedFields = new Set<string>();
  for (const candidate of candidates) {
    if (usedColumns.has(candidate.column) || usedFields.has(candidate.field)) continue;
    result[candidate.column] = candidate.field;
    usedColumns.add(candidate.column);
    usedFields.add(candidate.field);
  }
  return result;
}

/** How alike two sets of headings are (0–1): the share of the headings they have in common. */
export function headerOverlap(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left.map(normalizeHeader).filter(Boolean));
  const b = new Set(right.map(normalizeHeader).filter(Boolean));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const heading of a) if (b.has(heading)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Applies a saved mapping to the headings of a sheet: the same heading gets the same field, in whatever column it is now; `undefined` for a heading the mapping does not know. */
export function applySaved(headers: readonly string[], saved: readonly SavedColumn[]): Array<string | null | undefined> {
  const byHeader = new Map(saved.map(column => [normalizeHeader(column.header), column.field]));
  return headers.map(header => byHeader.get(normalizeHeader(header)));
}
