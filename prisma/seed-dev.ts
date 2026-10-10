import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

/**
 * Synthetic demo data for a development database (made-up clients, workers, hours …) so screens have something to show.
 * Run it after `npm run db:seed`. Never copy real client data from Ahmad's files into here.
 */
interface DevSeeder {
  name: string;
  run: (prisma: PrismaClient) => Promise<void>;
}

const seeders: DevSeeder[] = [];

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('seed-dev must not run in production');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  try {
    if (seeders.length === 0) console.log('No demo data yet — it is added together with the features.');
    for (const seeder of seeders) {
      console.log(`Seeding demo ${seeder.name} …`);
      await seeder.run(prisma);
    }
  } finally {
    await prisma.$disconnect();
  }
}

await main();
