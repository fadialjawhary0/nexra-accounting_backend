import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { fold } from '../src/common/text.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { folderNameOf } from '../src/module/clients/client-record.js';

/**
 * Synthetic demo data for a development database (made-up clients, people …) so screens have something to show.
 * Run it after `npm run db:seed`. Never copy real client data from Ahmad's files into here: every name, number and address below
 * is invented (e-mail addresses use the reserved `.example` domain, KvK numbers start with 99).
 */
interface DevSeeder {
  name: string;
  run: (prisma: PrismaClient) => Promise<void>;
}

interface DemoClient {
  name: string;
  form: string;
  sector: string;
  city: string;
  owner: [first: string, infix: string, last: string];
  stopped?: boolean;
  /** Leaves a few details out on purpose, so the "complete the details" view has work to show. */
  incomplete?: boolean;
}

const CLIENTS: DemoClient[] = [
  { name: 'Schoonmaak Helder', form: 'eenmanszaak', sector: 'cleaning', city: 'Utrecht', owner: ['Anouk', 'van', 'Dijk'] },
  { name: 'Taxi Rijnmond B.V.', form: 'bv', sector: 'taxi', city: 'Rotterdam', owner: ['Mehmet', '', 'Yilmaz'] },
  { name: 'Koerier Snel', form: 'eenmanszaak', sector: 'courier', city: 'Amsterdam', owner: ['Sanne', '', 'Bakker'], incomplete: true },
  { name: 'Bouwbedrijf De Vries & Zn.', form: 'vof', sector: 'construction', city: 'Zwolle', owner: ['Pieter', 'de', 'Vries'] },
  { name: 'Horeca Het Hoekje', form: 'eenmanszaak', sector: 'hospitality', city: 'Delft', owner: ['Fatima', 'El', 'Amrani'] },
  { name: 'Transport Noord B.V.', form: 'bv', sector: 'transport', city: 'Groningen', owner: ['Jan', '', 'Smit'] },
  { name: 'Beveiliging Veilig B.V.', form: 'bv', sector: 'security', city: 'Den Haag', owner: ['Rachid', '', 'Benali'] },
  { name: 'Zorgzaam Thuiszorg', form: 'eenmanszaak', sector: 'healthcare', city: 'Eindhoven', owner: ['Lotte', '', 'Peters'], incomplete: true },
  { name: 'Detailhandel Hoek', form: 'eenmanszaak', sector: 'retail', city: 'Haarlem', owner: ['Willem', '', 'Hoek'] },
  { name: 'Klus & Co V.O.F.', form: 'vof', sector: 'construction', city: 'Arnhem', owner: ['Daan', 'van der', 'Meer'] },
  { name: 'Beheer De Vries B.V.', form: 'bv', sector: 'business_services', city: 'Zwolle', owner: ['Pieter', 'de', 'Vries'] },
  { name: 'Uitzendbureau Vooruit B.V.', form: 'bv', sector: 'staffing', city: 'Tilburg', owner: ['Esther', '', 'Jansen'] },
  { name: 'Glazenwasserij Kristal', form: 'eenmanszaak', sector: 'cleaning', city: 'Leiden', owner: ['Kevin', '', 'Mulder'], incomplete: true },
  { name: 'Pizzeria Bella Italia', form: 'eenmanszaak', sector: 'hospitality', city: 'Breda', owner: ['Marco', '', 'Rossi'] },
  { name: 'ICT Dienst B.V.', form: 'bv', sector: 'it', city: 'Amersfoort', owner: ['Noor', '', 'Visser'] },
  { name: 'Tuincentrum Groen', form: 'eenmanszaak', sector: 'agriculture', city: 'Apeldoorn', owner: ['Henk', '', 'Groen'] },
  { name: 'Verhuisbedrijf Rolf', form: 'eenmanszaak', sector: 'transport', city: 'Nijmegen', owner: ['Rolf', '', 'Kuipers'] },
  { name: 'Stichting Buurthuis Oost', form: 'stichting', sector: 'other', city: 'Amsterdam', owner: ['Ingrid', 'van', 'Leeuwen'] },
  { name: 'Taxi Utrecht Centraal', form: 'eenmanszaak', sector: 'taxi', city: 'Utrecht', owner: ['Hassan', '', 'Idrissi'], incomplete: true },
  { name: 'Kapsalon Knip', form: 'eenmanszaak', sector: 'retail', city: 'Maastricht', owner: ['Britt', '', 'Hermans'] },
  { name: 'Montage Techniek B.V.', form: 'bv', sector: 'construction', city: 'Venlo', owner: ['Tim', '', 'Janssen'] },
  { name: 'Bezorgdienst Flink', form: 'eenmanszaak', sector: 'courier', city: 'Almere', owner: ['Yara', '', 'Postma'] },
  { name: 'Autobedrijf Wiel', form: 'vof', sector: 'retail', city: 'Enschede', owner: ['Bas', 'van', 'Wiel'] },
  { name: 'Fysio Beweeg', form: 'eenmanszaak', sector: 'healthcare', city: 'Alkmaar', owner: ['Sophie', '', 'Dekker'] },
  { name: 'Recycling Nederland B.V.', form: 'bv', sector: 'other', city: 'Dordrecht', owner: ['Thomas', '', 'Brouwer'] },
  { name: 'Oude Klant Bakkerij', form: 'eenmanszaak', sector: 'retail', city: 'Gouda', owner: ['Cor', '', 'Kok'], stopped: true },
  { name: 'Stoffeerderij Comfort', form: 'eenmanszaak', sector: 'retail', city: 'Hilversum', owner: ['Els', '', 'Maas'], stopped: true },
  { name: 'Wegtransport Zuid V.O.F.', form: 'vof', sector: 'transport', city: 'Roermond', owner: ['Jos', '', 'Peeters'] },
];

const STREETS = ['Industrieweg', 'Marktstraat', 'Kerklaan', 'Stationsplein', 'Havenstraat', 'Molenpad', 'Bosweg', 'Nieuwstraat'];
const POSTCODE_LETTERS = ['AB', 'CD', 'EF', 'GH', 'JK', 'LM', 'NP', 'RS'];
const ROLE_FOR_FORM: Record<string, string> = { eenmanszaak: 'owner', vof: 'partner', bv: 'director', stichting: 'director' };

const slug = (value: string) => fold(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const digits = (seed: number, length: number) => String((seed * 7_919_443 + 1_234_567) % 10 ** length).padStart(length, '0');

const seeders: DevSeeder[] = [
  {
    name: 'clients and people',
    run: async prisma => {
      if ((await prisma.client.count()) > 0) {
        console.log('  There are clients already — demo clients not added.');
        return;
      }
      const folderItems = await prisma.listItem.findMany({ where: { isActive: true, list: { key: 'client_folder' } }, orderBy: { sortOrder: 'asc' } });
      const created: Array<{ id: string; name: string }> = [];

      for (const [index, demo] of CLIENTS.entries()) {
        const number = String(index + 1).padStart(3, '0');
        const kvk = `99${digits(index + 3, 6)}`;
        const vat = `NL${digits(index + 11, 9)}B01`;
        const street = STREETS[index % STREETS.length]!;
        const postalCode = `${1000 + ((index * 337) % 8999)} ${POSTCODE_LETTERS[index % POSTCODE_LETTERS.length]}`;
        const phone = `+316${digits(index + 5, 8)}`;
        const email = `info@${slug(demo.name)}.example`;
        const data: Record<string, unknown> = {
          sector: demo.sector,
          city: demo.city,
          contact_person: `${demo.owner[0]} ${demo.owner[2]}`,
          ...(demo.incomplete ? {} : { street, house_number: String(1 + ((index * 7) % 90)), postal_code: postalCode, phone_1: phone, email_1: email }),
          ...(demo.form === 'eenmanszaak' ? { income_tax: true } : {}),
          ...(demo.form === 'bv' ? { corporate_tax: true, rsin: `99${digits(index + 20, 7)}` } : {}),
          ...(index % 3 === 0 ? { vat_frequency: 'quarter' } : {}),
        };
        const people = [{ first: demo.owner[0], infix: demo.owner[1], last: demo.owner[2], role: ROLE_FOR_FORM[demo.form] ?? 'contact' }];
        const searchText = fold(
          [number, demo.name, demo.city, kvk, vat, ...(demo.incomplete ? [] : [postalCode, email]), ...people.map(person => [person.first, person.infix, person.last].filter(Boolean).join(' '))].join(' '),
        );

        const client = await prisma.client.create({
          data: {
            number,
            name: demo.name,
            legalForm: demo.form,
            kvk,
            vatNumber: demo.incomplete ? null : vat,
            data: data as object,
            searchText,
            isActive: !demo.stopped,
            ...(demo.stopped && { stoppedOn: new Date('2026-06-30T00:00:00.000Z'), deactivatedAt: new Date(), deactivationReason: 'Bedrijf beëindigd (demo)' }),
          },
        });
        // The folder `<number>- <name>` and the standard sub-folders, like a client made in the app gets.
        const root = await prisma.folder.create({ data: { clientId: client.id, name: folderNameOf({ number, name: demo.name }), sortOrder: 0 } });
        await prisma.folder.createMany({ data: folderItems.map((item, order) => ({ clientId: client.id, parentId: root.id, name: item.nameNl, templateCode: item.code, sortOrder: (order + 1) * 10 })) });
        created.push({ id: client.id, name: demo.name });

        for (const person of people) {
          const row = await prisma.person.create({
            data: {
              firstName: person.first,
              lastName: person.last,
              data: { ...(person.infix ? { infix: person.infix } : {}), salutation: 'neutral', email: `${slug(person.first)}.${slug(person.last)}@${slug(demo.name)}.example`, phone },
              searchText: fold([person.first, person.infix, person.last].filter(Boolean).join(' ')),
            },
          });
          await prisma.clientPerson.create({ data: { clientId: client.id, personId: row.id, role: person.role, startedOn: new Date('2022-01-01T00:00:00.000Z') } });
        }
      }

      // The holding of "De Vries" and a group of two taxi companies.
      const byName = new Map(created.map(client => [client.name, client.id]));
      const link = (from: string, to: string, kind: string) => {
        const fromId = byName.get(from);
        const toId = byName.get(to);
        return fromId && toId ? prisma.clientRelation.create({ data: { fromId, toId, kind } }) : Promise.resolve(null);
      };
      await link('Beheer De Vries B.V.', 'Bouwbedrijf De Vries & Zn.', 'parent');
      const [taxiA, taxiB] = [byName.get('Taxi Rijnmond B.V.'), byName.get('Taxi Utrecht Centraal')].sort() as [string, string];
      if (taxiA && taxiB) await prisma.clientRelation.create({ data: { fromId: taxiA, toId: taxiB, kind: 'group' } });
      console.log(`  Added ${created.length} demo clients (the numbering continues after ${String(created.length).padStart(3, '0')}).`);
    },
  },
];

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('seed-dev must not run in production');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  try {
    for (const seeder of seeders) {
      console.log(`Seeding demo ${seeder.name} …`);
      await seeder.run(prisma);
    }
  } finally {
    await prisma.$disconnect();
  }
}

await main();
