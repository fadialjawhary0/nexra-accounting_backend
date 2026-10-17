import { Injectable } from '@nestjs/common';
import type { Prisma, StoredFile } from '../../generated/prisma/client.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { DocumentTypesService } from '../document-settings/document-types.service.js';
import { DOCUMENT_PURPOSES } from '../files/files.constants.js';

/**
 * Versions instead of copies: a newer file of the same document is the next version, the older ones stay (history, inspections) but only the current
 * one shows in lists. The versions of a document share a `rootId` (the id of the first one). Which file is "the same document" is decided by the type:
 * a document of a *versioned* type (KvK extract, ID …) replaces the current one of the same client or worker; for the others a person says so.
 */
@Injectable()
export class DocumentVersionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly types: DocumentTypesService,
  ) {}

  /** Where the versions of a document are: the first one and every file that names it as its root. */
  static chain(root: string): Prisma.StoredFileWhereInput {
    return { OR: [{ id: root }, { rootId: root }] };
  }

  /** The current document of the same type that belongs to the same client or worker as `file`, when its type is versioned. */
  async current(file: Pick<StoredFile, 'id' | 'docType' | 'entityType' | 'entityId' | 'clientId'>): Promise<StoredFile | null> {
    const type = await this.types.byCode(file.docType);
    if (!type?.versioned || !file.entityId) return null;
    const subject: Prisma.StoredFileWhereInput | null =
      file.entityType === 'employee' || file.entityType === 'person' ? { entityType: file.entityType, entityId: file.entityId } : file.entityType === 'client' && file.clientId ? { entityType: 'client', clientId: file.clientId } : null;
    if (!subject) return null;
    return this.prisma.storedFile.findFirst({
      where: { ...subject, docType: file.docType, isActive: true, isCurrent: true, purpose: { in: [...DOCUMENT_PURPOSES] }, NOT: { id: file.id } },
      orderBy: [{ docDate: 'desc' }, { createdAt: 'desc' }],
    });
  }

  /** A file that has just been filed becomes the next version of the current document of its (versioned) type. */
  async supersede(file: StoredFile): Promise<StoredFile | null> {
    const previous = await this.current(file);
    if (!previous) return null;
    await this.chainTo(file, previous);
    return previous;
  }

  /**
   * Makes `file` the version after the newest of `previous`'s document. A file dated *before* the one that is current is kept as an older version and the
   * current one stays current (importing a 2019 extract must not hide the one of this year).
   */
  async chainTo(file: Pick<StoredFile, 'id' | 'docDate'>, previous: Pick<StoredFile, 'id' | 'rootId' | 'docDate' | 'version'>): Promise<void> {
    const root = previous.rootId ?? previous.id;
    const newest = await this.prisma.storedFile.aggregate({ where: DocumentVersionsService.chain(root), _max: { version: true } });
    const version = Math.max(newest._max.version ?? 1, previous.version) + 1;
    const newer = !file.docDate || !previous.docDate || file.docDate >= previous.docDate;
    await this.prisma.$transaction([
      ...(newer ? [this.prisma.storedFile.updateMany({ where: { ...DocumentVersionsService.chain(root), NOT: { id: file.id } }, data: { isCurrent: false } })] : []),
      this.prisma.storedFile.update({ where: { id: file.id }, data: { rootId: root, version, isCurrent: newer } }),
    ]);
  }
}
