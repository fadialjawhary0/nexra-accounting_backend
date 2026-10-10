import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { SEED_FORMS } from './seed-data/forms.js';
import { SEED_LISTS } from './seed-data/lists.js';
import { MEDEWERKER_PERMISSIONS, MEDEWERKER_ROLE_KEY, OWNER_ROLE_KEY, fullAccess } from '../src/module/roles/permission-catalog.js';

/**
 * Reference data every environment needs: roles and the owner account (Phase 4), settings, pick-lists and the status /
 * type lookup tables with their Dutch + English names, Dutch holidays, … (Phase 5 onwards).
 * Idempotent — running it twice changes nothing (use upsert on a natural key). Never put real client data here.
 * Each phase adds its seeder to the list.
 */
interface Seeder {
  name: string;
  run: (prisma: PrismaClient) => Promise<void>;
}

const seeders: Seeder[] = [
  {
    name: 'roles',
    run: async prisma => {
      // The owner keeps full access whatever is stored; the staff role is only created — Ahmad's later edits are never overwritten.
      await prisma.role.upsert({
        where: { key: OWNER_ROLE_KEY },
        create: { key: OWNER_ROLE_KEY, name: 'Owner', description: 'Full access to everything, including users, roles and security settings. Cannot be removed.', isSystem: true, permissions: fullAccess() },
        update: { isSystem: true, permissions: fullAccess() },
      });
      await prisma.role.upsert({
        where: { key: MEDEWERKER_ROLE_KEY },
        create: { key: MEDEWERKER_ROLE_KEY, name: 'Medewerker', description: 'Staff member: works with clients, tasks and the calendar. Cannot manage users or settings.', isSystem: true, permissions: MEDEWERKER_PERMISSIONS },
        update: {},
      });
    },
  },
  {
    name: 'lists',
    run: async prisma => {
      // Only creates what is missing: renames, reordering and switched-off items made by the office are never overwritten.
      for (const seed of SEED_LISTS) {
        const list = await prisma.list.upsert({
          where: { key: seed.key },
          create: {
            key: seed.key,
            nameNl: seed.nameNl,
            nameEn: seed.nameEn,
            descriptionNl: seed.descriptionNl ?? '',
            descriptionEn: seed.descriptionEn ?? '',
            kind: seed.kind ?? 'picklist',
            isSystem: true,
            allowNewItems: seed.allowNewItems ?? true,
          },
          update: {},
        });
        await prisma.listItem.createMany({
          data: seed.items.map(([code, nameNl, nameEn, meta], index) => ({ listId: list.id, code, nameNl, nameEn, sortOrder: (index + 1) * 10, isSystem: true, meta: meta ?? {} })),
          skipDuplicates: true,
        });
      }
    },
  },
  {
    name: 'forms',
    run: async prisma => {
      // Only creates the forms that do not exist yet: once the form builder has touched a form, the office owns it.
      for (const [entity, doc] of Object.entries(SEED_FORMS)) {
        if (await prisma.formDefinition.findUnique({ where: { entity } })) continue;
        const json = JSON.parse(JSON.stringify(doc)) as object;
        await prisma.formDefinition.create({ data: { entity, live: json, revision: 1, revisions: { create: { revision: 1, doc: json, note: 'First version' } } } });
      }
    },
  },
  {
    name: 'owner account',
    run: async prisma => {
      const email = process.env.SEED_OWNER_EMAIL?.trim().toLowerCase();
      const password = process.env.SEED_OWNER_PASSWORD;
      if (!email || !password) {
        console.warn('  SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD are not set — no owner account was created.');
        return;
      }
      if (await prisma.user.findUnique({ where: { email } })) {
        console.log('  The owner account already exists — left untouched.');
        return;
      }
      const role = await prisma.role.findUniqueOrThrow({ where: { key: OWNER_ROLE_KEY } });
      await prisma.user.create({
        data: {
          email,
          name: process.env.SEED_OWNER_NAME?.trim() || 'Owner',
          roleId: role.id,
          status: 'active',
          passwordHash: await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
          passwordChangedAt: new Date(),
          // The password from .env is temporary: the first thing the owner does after signing in is choose their own.
          mustChangePassword: true,
        },
      });
      console.log(`  Created the owner account ${email} (must choose a new password at the first sign-in).`);
    },
  },
];

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  try {
    for (const seeder of seeders) {
      console.log(`Seeding ${seeder.name} …`);
      await seeder.run(prisma);
    }
  } finally {
    await prisma.$disconnect();
  }
}

await main();
