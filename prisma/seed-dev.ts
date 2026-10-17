import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { fold } from '../src/common/text.js';
import { PrismaClient, type Prisma } from '../src/generated/prisma/client.js';
import { folderNameOf } from '../src/module/clients/client-record.js';
import { hoursAmountCents, invoiceTotals } from '../src/module/invoices/invoice-calc.js';

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

const WORKER_FIRST_NAMES = ['Aylin', 'Bram', 'Chantal', 'Dennis', 'Elif', 'Femke', 'Giovanni', 'Hanna', 'Ibrahim', 'Jasper', 'Katarzyna', 'Lars', 'Mirela', 'Nadia', 'Omar', 'Piotr', 'Quinten', 'Roxanne', 'Stefan', 'Tamara', 'Umut', 'Vera', 'Wouter', 'Xander', 'Yasmin', 'Zoltan'];
const WORKER_LAST_NAMES: Array<[infix: string, last: string]> = [
  ['', 'Kowalski'],
  ['van', 'Rijn'],
  ['', 'Demir'],
  ['de', 'Haan'],
  ['', 'Nowak'],
  ['el', 'Idrissi'],
  ['', 'Popescu'],
  ['van den', 'Berg'],
  ['', 'Yildiz'],
  ['', 'Bos'],
  ['', 'Horvat'],
  ['de', 'Boer'],
  ['', 'Alves'],
  ['ter', 'Horst'],
  ['', 'Kaya'],
  ['', 'Wójcik'],
];
/** First names above that are women's names (for the salutation of the demo letters). */
const WOMEN = new Set(['Aylin', 'Chantal', 'Elif', 'Femke', 'Hanna', 'Katarzyna', 'Mirela', 'Nadia', 'Roxanne', 'Tamara', 'Vera', 'Yasmin']);
const WORKER_NATIONALITIES = ['NL', 'PL', 'RO', 'TR', 'MA', 'BG', 'PT', 'NL', 'HU', 'NL'];
/** What a worker at a client of this sector usually does (codes of the `employee_function` list). */
const FUNCTION_BY_SECTOR: Record<string, string[]> = {
  cleaning: ['cleaner'],
  taxi: ['driver'],
  courier: ['courier', 'driver'],
  hospitality: ['kitchen', 'service'],
  construction: ['construction'],
  transport: ['driver', 'warehouse'],
  security: ['security'],
  healthcare: ['care'],
  retail: ['warehouse', 'service'],
  business_services: ['administration'],
  it: ['administration'],
  staffing: ['warehouse', 'administration'],
  agriculture: ['other', 'warehouse'],
  other: ['other'],
};

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
/** `n` days from today as `YYYY-MM-DD` (demo dates stay "soon" whenever the seed runs). */
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const seeders: DevSeeder[] = [
  {
    name: 'clients and people',
    run: async prisma => {
      if ((await prisma.client.count()) > 0) {
        console.log('  There are clients already — demo clients not added.');
        return;
      }
      // The standard folders of the folder template (the demo clients only get the top level, which is all the standard template has).
      const folderItems = await prisma.folderTemplate.findMany({ where: { isActive: true, parentCode: null }, orderBy: { sortOrder: 'asc' } });
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
  {
    name: 'workers',
    run: async prisma => {
      if ((await prisma.employee.count()) > 0) {
        console.log('  There are workers already — demo workers not added.');
        return;
      }
      const clients = await prisma.client.findMany({ orderBy: { number: 'asc' } });
      const functionNames = new Map((await prisma.listItem.findMany({ where: { list: { key: 'employee_function' } } })).map(item => [item.code, item.nameNl]));
      let total = 0;
      let stoppedWorkers = 0;

      for (const [clientIndex, client] of clients.entries()) {
        const sector = String((client.data as Record<string, unknown>).sector ?? 'other');
        const functions = FUNCTION_BY_SECTOR[sector] ?? ['other'];
        const contracts = await prisma.folder.findFirst({ where: { clientId: client.id, templateCode: 'contracts' } });
        const fallback = contracts ?? (await prisma.folder.findFirstOrThrow({ where: { clientId: client.id, parentId: null } }));
        let leaversFolder: string | null = null;
        const count = client.isActive ? 2 + (clientIndex % 4) : 1 + (clientIndex % 2);

        for (let slot = 0; slot < count; slot += 1) {
          const seed = clientIndex * 11 + slot * 5;
          const first = WORKER_FIRST_NAMES[seed % WORKER_FIRST_NAMES.length]!;
          const [infix, last] = WORKER_LAST_NAMES[(seed * 3 + slot) % WORKER_LAST_NAMES.length]!;
          const city = clientIndex % 3 === 0 ? 'Utrecht' : ['Amsterdam', 'Rotterdam', 'Den Haag', 'Almere', 'Zwolle', 'Eindhoven'][seed % 6]!;
          const function_ = functions[(seed + slot) % functions.length]!;
          const startDate = inDays(-(90 + ((seed * 37) % 1100)));
          // Some leave: all of them at a client that stopped, otherwise about one in seven.
          const left = !client.isActive || seed % 7 === 3;
          const endDate = left ? (client.stoppedOn ? client.stoppedOn.toISOString().slice(0, 10) : inDays(-(5 + ((seed * 13) % 80)))) : null;
          const rate = 12.5 + ((seed * 3) % 28) * 0.25;
          const mobile = `+3166${digits(seed + 41, 8)}`;
          const street = STREETS[(seed + 3) % STREETS.length]!;
          const postalCode = `${1000 + ((seed * 211) % 8999)} ${POSTCODE_LETTERS[seed % POSTCODE_LETTERS.length]}`;
          const nationality = WORKER_NATIONALITIES[seed % WORKER_NATIONALITIES.length]!;
          const personData: Record<string, unknown> = {
            ...(infix ? { infix } : {}),
            salutation: WOMEN.has(first) ? 'mrs' : 'mr',
            initials: `${first[0]}.`,
            nationality,
            date_of_birth: `${1975 + (seed % 25)}-${String(1 + (seed % 12)).padStart(2, '0')}-${String(1 + ((seed * 3) % 27)).padStart(2, '0')}`,
            mobile,
            email: `${slug(first)}.${slug(last)}@werknemer.example`,
            street,
            house_number: String(1 + ((seed * 5) % 120)),
            postal_code: postalCode,
            city,
            id_type: seed % 3 === 0 ? 'passport' : 'id_card',
            // A few documents are about to expire (or already have), so the "documents expiring" counter has something to show.
            id_expiry: seed % 9 === 0 ? inDays(25 + (seed % 40)) : seed % 13 === 0 ? inDays(-20) : inDays(400 + ((seed * 29) % 1500)),
            ...(nationality === 'NL' ? {} : { permit_type: 'eu_registration', permit_expiry: seed % 10 === 0 ? inDays(40) : inDays(500 + ((seed * 17) % 900)) }),
          };
          const person = await prisma.person.create({
            data: {
              firstName: first,
              lastName: last,
              data: personData as object,
              searchText: fold([first, infix, last, personData.email, city, postalCode].filter(Boolean).join(' ')),
            },
          });
          const employee = await prisma.employee.create({
            data: {
              personId: person.id,
              clientId: client.id,
              functionCode: function_,
              startDate: day(startDate),
              endDate: endDate ? day(endDate) : null,
              isActive: !left,
              ...(left && { deactivatedAt: new Date(), deactivationReason: client.isActive ? 'Contract beëindigd (demo)' : 'Klant gestopt (demo)' }),
              data: slot === 0 ? { notes: 'Demo-werknemer' } : {},
              searchText: fold(`${functionNames.get(function_) ?? function_}`),
            },
          });
          // The hourly rate from the first day; every other worker got a raise at the start of this year.
          await prisma.rateHistory.create({ data: { employeeId: employee.id, rate, validFrom: day(startDate) } });
          if (slot % 2 === 1 && startDate < '2026-01-01') await prisma.rateHistory.create({ data: { employeeId: employee.id, rate: rate + 0.75, validFrom: day('2026-01-01'), note: 'Nieuwe CAO (demo)' } });

          // The worker's folder: inside the contracts folder, or in `0-GESTOPT` once the worker left.
          if (left && !leaversFolder) {
            leaversFolder = (await prisma.folder.create({ data: { clientId: client.id, parentId: fallback.id, name: '0-GESTOPT', sortOrder: 0 } })).id;
          }
          await prisma.folder.create({
            data: { clientId: client.id, parentId: left ? leaversFolder : fallback.id, employeeId: employee.id, name: [first, infix, last].filter(Boolean).join(' '), sortOrder: 1000 },
          });
          total += 1;
          if (left) stoppedWorkers += 1;
        }
      }
      console.log(`  Added ${total} demo workers (${stoppedWorkers} of them stopped).`);
    },
  },
  {
    name: 'contracts',
    run: async prisma => {
      if ((await prisma.contract.count()) > 0) {
        console.log('  There are contracts already — demo contracts not added.');
        return;
      }
      const employees = await prisma.employee.findMany({ include: { person: true, client: true }, orderBy: [{ client: { number: 'asc' } }, { createdAt: 'asc' }] });
      const typeNames = new Map((await prisma.listItem.findMany({ where: { list: { key: 'contract_type' } } })).map(item => [item.code, item.nameNl]));
      const rates = await prisma.rateHistory.findMany({ orderBy: { validFrom: 'desc' } });
      const rateOf = new Map<string, number>();
      for (const row of rates) if (!rateOf.has(row.employeeId)) rateOf.set(row.employeeId, row.rate.toNumber());
      const monthsAfter = (iso: string, months: number) => {
        const date = new Date(`${iso}T00:00:00.000Z`);
        date.setUTCMonth(date.getUTCMonth() + months);
        date.setUTCDate(date.getUTCDate() - 1);
        return date.toISOString().slice(0, 10);
      };
      let total = 0;

      for (const [index, employee] of employees.entries()) {
        const name = [employee.person.firstName, ((employee.person.data ?? {}) as Record<string, unknown>).infix, employee.person.lastName].filter(Boolean).join(' ');
        const start = employee.startDate ? employee.startDate.toISOString().slice(0, 10) : inDays(-200);
        const rate = rateOf.get(employee.id) ?? 14;
        const pattern = index % 10;
        // The mix a real office has: mostly on-call, some fixed-term (a few ending soon), a permanent one, an old one that ended, a draft.
        let type = 'on_call';
        let status = 'active';
        let from = start;
        let to: string | null = null;
        const data: Record<string, unknown> = { function: employee.functionCode ?? 'other', signing_place: 'Utrecht', signing_date: start };
        if (pattern === 4 || pattern === 5) {
          type = 'fixed_term';
          to = inDays(8 + ((index * 11) % 85));
          from = monthsAfter(to, -7).replace(/\d{2}$/, '01');
          data.monthly_salary = 2150 + ((index * 40) % 500);
          data.hours_per_week = 38;
          data.working_days = 'maandag t/m vrijdag';
          data.workplace = employee.client.name;
          data.probation_months = 1;
        } else if (pattern === 6) {
          type = 'permanent';
          data.monthly_salary = 2400 + ((index * 25) % 600);
          data.hours_per_week = 40;
        } else if (pattern === 7) {
          type = 'fixed_term';
          status = 'ended';
          from = inDays(-420);
          to = inDays(-40 - ((index * 3) % 60));
          data.monthly_salary = 2100;
        } else if (pattern === 8) {
          status = 'draft';
          from = inDays(5 + (index % 20));
          data.hourly_rate = rate;
        } else if (pattern === 9) {
          type = 'internship';
          to = inDays(60 + (index % 90));
          from = monthsAfter(to, -5).replace(/\d{2}$/, '01');
          data.monthly_salary = 450;
        } else {
          data.hourly_rate = rate;
        }
        let terminatedOn: Date | null = null;
        let reason: string | null = null;
        // A worker who left has no running contract: it ended with them.
        if (!employee.isActive && status === 'active') {
          status = 'terminated';
          terminatedOn = employee.endDate;
          reason = employee.client.isActive ? 'mutual' : 'client_ended';
        }
        const open = status === 'draft' || status === 'sent' || status === 'active';
        const durationMonths = to ? Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / (30.44 * 86_400_000))) : null;
        await prisma.contract.create({
          data: {
            clientId: employee.clientId,
            employeeId: employee.id,
            type,
            status,
            startDate: day(from),
            endDate: to ? day(to) : null,
            durationMonths,
            signedOn: status === 'draft' ? null : day(from),
            terminatedOn,
            terminationReason: reason,
            isActive: open,
            ...(!open && { deactivatedAt: new Date() }),
            data: data as object,
            searchText: fold([employee.client.number, employee.client.name, name, typeNames.get(type)].filter(Boolean).join(' ')),
          },
        });
        total += 1;
      }
      console.log(`  Added ${total} demo contracts (no Word documents: generate one from a contract's page).`);
    },
  },
  {
    name: 'hours',
    run: async prisma => {
      if ((await prisma.hourEntry.count()) > 0) {
        console.log('  There are hours already — demo hours not added.');
        return;
      }
      // Six weeks of work for most workers: full days Monday to Friday (some part-time), a Saturday now and then, a few evening shifts with clock times.
      const employees = await prisma.employee.findMany({ include: { rates: { orderBy: { validFrom: 'asc' } } }, orderBy: [{ clientId: 'asc' }, { createdAt: 'asc' }] });
      const workplaces = ['Hoofdlocatie', 'Magazijn', 'Locatie Utrecht', 'Locatie Rotterdam', 'Bij de klant'];
      const entries: Prisma.HourEntryCreateManyInput[] = [];
      for (const [index, employee] of employees.entries()) {
        if (index % 3 === 0) continue;
        const first = employee.startDate ? employee.startDate.toISOString().slice(0, 10) : inDays(-200);
        const last = employee.endDate ? employee.endDate.toISOString().slice(0, 10) : inDays(0);
        const fullTime = index % 4 !== 1;
        for (let offset = -42; offset <= -1; offset += 1) {
          const date = inDays(offset);
          if (date < first || date > last) continue;
          const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
          if (weekday === 0 || (weekday === 6 && index % 7 !== 0) || (!fullTime && (weekday === 3 || weekday === 5))) continue;
          const evening = index % 11 === 0 && weekday !== 6;
          const rate = [...employee.rates].reverse().find(entry => entry.validFrom.toISOString().slice(0, 10) <= date)?.rate ?? null;
          entries.push({
            employeeId: employee.id,
            clientId: employee.clientId,
            date: day(date),
            minutes: weekday === 6 ? 240 : fullTime ? 480 : 360,
            ...(evening && { startTime: '16:00', endTime: '24:00', breakMinutes: 0, minutes: 480 }),
            rate,
            source: 'manual',
            data: index % 5 === 0 ? { workplace: workplaces[index % workplaces.length] } : {},
          });
        }
      }
      await prisma.hourEntry.createMany({ data: entries });
      console.log(`  Added ${entries.length} demo hour entries (the last six weeks, no salary statements: make one from Salary statements).`);
    },
  },
  {
    name: 'invoices',
    run: async prisma => {
      if ((await prisma.invoice.count()) > 0) {
        console.log('  There are invoices already — demo invoices not added.');
        return;
      }
      const staffing = await prisma.client.findFirst({ where: { name: 'Uitzendbureau Vooruit B.V.' } });
      const security = await prisma.client.findFirst({ where: { name: 'Beveiliging Veilig B.V.' } });
      if (!staffing || !security) {
        console.log('  The demo clients are not there — demo invoices not added.');
        return;
      }
      // The month before this one: the hours of the last six weeks cover it.
      const start = new Date(`${inDays(0).slice(0, 7)}-01T00:00:00.000Z`);
      start.setUTCMonth(start.getUTCMonth() - 1);
      const from = start.toISOString().slice(0, 10);
      const to = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      const range = { gte: day(from), lte: day(to) };

      const workersOf = (clientId: string) =>
        prisma.employee.findMany({ where: { clientId, isActive: true, hourEntries: { some: { date: range } } }, include: { person: true }, orderBy: { createdAt: 'asc' }, take: 3 });
      const minutesOf = async (ids: string[]) => new Map((await prisma.hourEntry.groupBy({ by: ['employeeId'], where: { employeeId: { in: ids }, date: range }, _sum: { minutes: true } })).map(row => [row.employeeId, row._sum.minutes ?? 0]));
      const rateOf = async (ids: string[]) => {
        const rows = await prisma.rateHistory.findMany({ where: { employeeId: { in: ids } }, orderBy: { validFrom: 'desc' } });
        const map = new Map<string, number>();
        for (const row of rows) if (!map.has(row.employeeId)) map.set(row.employeeId, row.rate.toNumber());
        return map;
      };
      const mark = (employee: { id: string; data: unknown }, kind: string) => prisma.employee.update({ where: { id: employee.id }, data: { data: { ...((employee.data ?? {}) as Record<string, unknown>), work_kind: kind } } });
      const fullName = (employee: { person: { firstName: string; lastName: string; data: unknown } }) => [employee.person.firstName, ((employee.person.data ?? {}) as Record<string, unknown>).infix, employee.person.lastName].filter(Boolean).join(' ');
      const money = (cents: number) => cents / 100;

      const agency = await prisma.counterparty.create({
        data: {
          name: 'Flexwerk Voorbeeld B.V.',
          kvk: '99001001',
          vatNumber: 'NL999001001B01',
          data: { street: 'Industrieweg', house_number: '8', postal_code: '3542 AD', city: 'Utrecht', contact_person: 'A. Voorbeeld', email: 'administratie@flexwerk.example', iban: 'NL91ABNA0417164300' },
          searchText: fold('Flexwerk Voorbeeld B.V. 99001001 Utrecht A. Voorbeeld administratie@flexwerk.example'),
        },
      });
      const hirer = await prisma.counterparty.create({
        data: {
          name: 'Inlener Logistiek Voorbeeld B.V.',
          kvk: '99001002',
          vatNumber: 'NL999001002B01',
          data: { street: 'Havenkade', house_number: '21', postal_code: '3011 AB', city: 'Rotterdam', contact_person: 'B. Voorbeeld', email: 'facturen@inlener.example' },
          searchText: fold('Inlener Logistiek Voorbeeld B.V. 99001002 Rotterdam B. Voorbeeld facturen@inlener.example'),
        },
      });

      // Outgoing: the staffing client bills a hirer for three of its workers (a draft: it is issued from the screen).
      const hiredOut = await workersOf(staffing.id);
      if (hiredOut.length) {
        const ids = hiredOut.map(worker => worker.id);
        const [minutes, rates] = await Promise.all([minutesOf(ids), rateOf(ids)]);
        const lines = hiredOut.map(worker => {
          const billed = minutes.get(worker.id) ?? 0;
          const rateCents = Math.round((rates.get(worker.id) ?? 14) * 1.35 * 100);
          return { worker, minutes: billed, rateCents, amountCents: hoursAmountCents(billed, rateCents) };
        });
        const totals = invoiceTotals({ lines: lines.map(line => ({ kind: 'hours', minutes: line.minutes, amountCents: line.amountCents })), vatBasisPoints: 2100, vatShifted: false, gAccountBasisPoints: 0 });
        for (const worker of hiredOut) await mark(worker, 'hired_out');
        await prisma.invoice.create({
          data: {
            direction: 'outgoing',
            clientId: staffing.id,
            counterpartyId: hirer.id,
            periodFrom: day(from),
            periodTo: day(to),
            status: 'draft',
            vatPercent: 21,
            subtotal: money(totals.subtotalCents),
            vatAmount: money(totals.vatCents),
            total: money(totals.totalCents),
            gAccountAmount: 0,
            data: { reference: 'PO-DEMO-001', assignment: 'Orderpicking magazijn' },
            searchText: fold(`concept ${staffing.number} ${staffing.name} ${hirer.name} PO-DEMO-001`),
            lines: { create: lines.map((line, index) => ({ sortOrder: index, kind: 'hours', employeeId: line.worker.id, rawName: fullName(line.worker), fromDate: day(from), toDate: day(to), minutes: line.minutes, rate: money(line.rateCents), amount: money(line.amountCents) })) },
          },
        });
      }

      // Incoming: a staffing company bills the security client for two hired-in workers — one line bills four hours more than are registered.
      const hiredIn = (await workersOf(security.id)).slice(0, 2);
      if (hiredIn.length) {
        const ids = hiredIn.map(worker => worker.id);
        const [minutes, rates] = await Promise.all([minutesOf(ids), rateOf(ids)]);
        const lines = hiredIn.map((worker, index) => {
          const billed = (minutes.get(worker.id) ?? 0) + (index === 1 ? 240 : 0);
          const rateCents = Math.round((rates.get(worker.id) ?? 14) * 1.4 * 100);
          return { worker, minutes: billed, rateCents, amountCents: hoursAmountCents(billed, rateCents) };
        });
        const totals = invoiceTotals({ lines: lines.map(line => ({ kind: 'hours', minutes: line.minutes, amountCents: line.amountCents })), vatBasisPoints: 2100, vatShifted: false, gAccountBasisPoints: 2500 });
        for (const worker of hiredIn) await mark(worker, 'hired_in');
        await prisma.invoice.create({
          data: {
            direction: 'incoming',
            clientId: security.id,
            counterpartyId: agency.id,
            number: 'FW-0417',
            invoiceDate: day(inDays(-4)),
            dueDate: day(inDays(26)),
            periodFrom: day(from),
            periodTo: day(to),
            status: 'received',
            vatPercent: 21,
            subtotal: money(totals.subtotalCents),
            vatAmount: money(totals.vatCents),
            total: money(totals.totalCents),
            gAccountPercent: 25,
            gAccountAmount: money(totals.gAccountCents),
            data: { reference: 'Bewaking evenementen' },
            searchText: fold(`FW-0417 ${agency.name} ${security.number} ${security.name} Bewaking evenementen`),
            lines: { create: lines.map((line, index) => ({ sortOrder: index, kind: 'hours', employeeId: line.worker.id, rawName: fullName(line.worker), fromDate: day(from), toDate: day(to), minutes: line.minutes, rate: money(line.rateCents), amount: money(line.amountCents) })) },
          },
        });
      }
      console.log('  Added 2 demo companies, one outgoing draft (to issue from the screen) and one incoming invoice with an hour difference.');
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
