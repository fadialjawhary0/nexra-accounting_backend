import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { AppClsStore } from '../../lib/audit/cls-store.js';
import { effectiveMatrix } from '../roles/permission-catalog.js';

/**
 * The person an import works for. A file is read and a spreadsheet is saved in the background, long after the request that started it: this
 * rebuilds that person (with the permissions they have *now*) so the same services that handle a click can do the work, and runs the work in a
 * request-like context so the audit trail says who it was.
 */
@Injectable()
export class ImportActorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  /** The person with their permissions; `null` when the account is gone or switched off. */
  async principal(userId: string): Promise<AuthenticatedUser | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
    if (!user || user.status !== 'active') return null;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roleKey: user.role.key,
      roleName: user.role.name,
      actualRoleKey: user.role.key,
      matrix: effectiveMatrix(user.role, user.permissionOverrides),
      previewing: false,
      sessionId: 'import',
      restriction: null,
    };
  }

  /** Runs `work` as this person: audit entries carry their name. */
  runAs<T>(user: AuthenticatedUser, work: () => Promise<T>): Promise<T> {
    return this.cls.run(async () => {
      this.cls.set('actor', { id: user.id, label: user.name });
      return work();
    });
  }
}
