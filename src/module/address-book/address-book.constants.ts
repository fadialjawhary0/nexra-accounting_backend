import type { SettingDefinitions } from '../../lib/settings/settings.service.js';

/** The permission area that guards the library of official forms, the log of sent forms and the address book. */
export const OFFICIAL_FORMS_AREA = 'official_forms';

export const ADDRESS_ENTITY = 'address_book_entry';

/** How a P.O. box or freepost number is written. */
export const BOX_KINDS = ['po_box', 'freepost'] as const;
export type BoxKind = (typeof BOX_KINDS)[number];

/** The sizes of paper an envelope label is printed on, in millimetres (landscape). A5 paper fits a C5 envelope. */
export const LABEL_SIZES = {
  a5: { widthMm: 210, heightMm: 148, nl: 'A5 liggend', en: 'A5 landscape' },
  dl: { widthMm: 220, heightMm: 110, nl: 'DL-envelop', en: 'DL envelope' },
  c5: { widthMm: 229, heightMm: 162, nl: 'C5-envelop', en: 'C5 envelope' },
} as const;
export type LabelSize = keyof typeof LABEL_SIZES;
export const LABEL_SIZE_KEYS = Object.keys(LABEL_SIZES) as LabelSize[];

/** Where on the label the recipient starts, per size: millimetres from the left and from the top (the sender is always in the top left corner). */
export const RECIPIENT_POSITION: Record<LabelSize, { xMm: number; yMm: number }> = {
  a5: { xMm: 95, yMm: 62 },
  dl: { xMm: 100, yMm: 48 },
  c5: { xMm: 105, yMm: 70 },
};

export const POST_NAMESPACE = 'post';

/** Settings → Post: which size a label is made in, whether the office's own address is printed in the corner, and how to move everything when a printer does not hit the paper in the right place. */
export const POST_DEFINITIONS = {
  defaultLabel: { type: 'enum', default: 'a5', options: LABEL_SIZE_KEYS, group: 'label' },
  printSender: { type: 'bool', default: true, group: 'label' },
  textSize: { type: 'int', default: 12, min: 9, max: 18, group: 'label' },
  /** Millimetres to the right (negative = left) and down (negative = up): for a printer that does not print where it should. */
  offsetX: { type: 'int', default: 0, min: -30, max: 30, group: 'printer' },
  offsetY: { type: 'int', default: 0, min: -30, max: 30, group: 'printer' },
} satisfies SettingDefinitions;
