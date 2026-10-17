/**
 * The steps of the VAT tracker as the office's own quarter sheet has them (docs/10): per client six checkboxes under three headings — Factuur: ontvangen, boeken · Bank: ontvangen,
 * boeken · Fiscaal: boeken (the return is prepared), sturen (the return is filed). They are only *created* by the seed: once a step exists the office owns it (renames, order,
 * new steps, switched-off steps are never overwritten). Synthetic: no real client data.
 */
export interface SeedVatStep {
  code: string;
  groupNl: string;
  groupEn: string;
  nameNl: string;
  nameEn: string;
  /** The step that means "the return has been filed". */
  isFiling?: boolean;
}

export const SEED_VAT_STEPS: SeedVatStep[] = [
  { code: 'invoices_received', groupNl: 'Factuur', groupEn: 'Invoices', nameNl: 'Ontvangen', nameEn: 'Received' },
  { code: 'invoices_booked', groupNl: 'Factuur', groupEn: 'Invoices', nameNl: 'Boeken', nameEn: 'Booked' },
  { code: 'bank_received', groupNl: 'Bank', groupEn: 'Bank', nameNl: 'Ontvangen', nameEn: 'Received' },
  { code: 'bank_booked', groupNl: 'Bank', groupEn: 'Bank', nameNl: 'Boeken', nameEn: 'Booked' },
  { code: 'return_prepared', groupNl: 'Fiscaal', groupEn: 'Tax', nameNl: 'Boeken', nameEn: 'Prepared' },
  { code: 'return_filed', groupNl: 'Fiscaal', groupEn: 'Tax', nameNl: 'Sturen', nameEn: 'Filed', isFiling: true },
];
