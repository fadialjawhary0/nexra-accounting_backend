import { Injectable } from '@nestjs/common';
import { PdfService } from '../../lib/pdf/pdf.service.js';
import type { PdfTextBlock } from '../../lib/pdf/pdf.types.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { OFFICE_NAMESPACE } from '../settings/settings.definitions.js';
import { cityLine, streetLine } from '../templates/merge-format.js';
import { LABEL_SIZES, LABEL_SIZE_KEYS, POST_DEFINITIONS, POST_NAMESPACE, RECIPIENT_POSITION, type LabelSize } from './address-book.constants.js';
import { addressLines, AddressBookService } from './address-book.service.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';

export interface LabelOptions {
  size?: LabelSize;
  /** Print the office's own address in the top left corner (default: the setting). */
  sender?: boolean;
  locale: AppLocale;
}

/**
 * Envelope labels: a page the size of the paper (A5, a DL or a C5 envelope) with the office's address small in the top left corner and the recipient where the
 * post office reads it. Printed on an envelope or on A5 paper that is put in a C5 envelope; the settings can move everything when a printer misses the spot.
 */
@Injectable()
export class AddressLabelsService {
  constructor(
    private readonly pdf: PdfService,
    private readonly settings: SettingsService,
    private readonly entries: AddressBookService,
  ) {
    settings.register(POST_NAMESPACE, POST_DEFINITIONS, { exposed: true });
  }

  private read<T extends string | number | boolean>(name: keyof typeof POST_DEFINITIONS): T {
    return this.settings.get<T>(`${POST_NAMESPACE}.${name}`);
  }

  /** What a label is made like unless the person chooses otherwise (for the screen that offers the choice). */
  defaults() {
    return { size: this.read<string>('defaultLabel'), sender: this.read<boolean>('printSender'), sizes: LABEL_SIZE_KEYS.map(code => ({ code, widthMm: LABEL_SIZES[code].widthMm, heightMm: LABEL_SIZES[code].heightMm })) };
  }

  /** The label of an address of the address book. */
  async forAddress(id: string, options: LabelOptions): Promise<{ bytes: Buffer; name: string }> {
    const row = await this.entries.rowOrThrow(id);
    return this.forLines(addressLines(row, options.locale), options);
  }

  /** The label of any address (the lines are written on it as they are). */
  async forLines(lines: string[], options: LabelOptions): Promise<{ bytes: Buffer; name: string }> {
    const wanted = options.size ?? (this.read<string>('defaultLabel') as LabelSize);
    const size: LabelSize = wanted in LABEL_SIZES ? wanted : 'a5';
    const paper = LABEL_SIZES[size];
    const where = RECIPIENT_POSITION[size];
    const textSize = this.read<number>('textSize');
    const blocks: PdfTextBlock[] = [{ lines: lines.filter(Boolean), xMm: where.xMm + this.read<number>('offsetX'), yMm: where.yMm + this.read<number>('offsetY'), sizePt: textSize, leading: 1.4 }];
    if (options.sender ?? this.read<boolean>('printSender')) {
      const sender = this.senderLines();
      if (sender.length) blocks.push({ lines: sender, xMm: 12 + this.read<number>('offsetX'), yMm: 12 + this.read<number>('offsetY'), sizePt: 8.5, leading: 1.3, color: '#4A4A4A' });
    }
    const bytes = await this.pdf.textPage({ widthMm: paper.widthMm, heightMm: paper.heightMm, blocks, title: lines[0] ?? 'Label' });
    return { bytes, name: `${(lines[0] ?? 'Label').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)} - ${paper[options.locale]}.pdf` };
  }

  /** The office's own name and address, as the return address. */
  private senderLines(): string[] {
    const office = this.settings.group(OFFICE_NAMESPACE) as Record<string, string>;
    const parts = { street: office.street, house_number: office.houseNumber, house_number_suffix: office.houseNumberSuffix, postal_code: office.postalCode, city: office.city };
    return [office.name, streetLine(parts), cityLine(parts)].map(line => (line ?? '').trim()).filter(Boolean);
  }
}
