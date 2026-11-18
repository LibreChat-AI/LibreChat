import mongoose from 'mongoose';
import { ObjectId } from 'mongodb';
import { expect } from '@playwright/test';
import { createHash, randomBytes, randomInt, randomUUID } from 'crypto';
import {
  createMethods,
  createModels,
  tenantStorage,
  supportsTransactions,
  createDiscordInstallationStorage,
} from '@librechat/data-schemas';
import type { DiscordStorageError, DiscordStorageResult } from '@librechat/data-schemas';
import type { Db, Document } from 'mongodb';
import type { Account } from './channels.helpers';
import { closeAccount, openAccount } from './channels.helpers';
import { getMongoUri, withMongo } from './db';

/**
 * No Discord route is enabled in this slice, so the callers under test are the exported storage and
 * admission fence. They run against the harness database with real accounts, real transactions and
 * the real account fences, and every document is read back raw. Credentials are disposable random
 * strings that no assertion prints. Enabled with E2E_CHANNELS=true against a MongoDB that supports
 * transactions.
 */

type Row = Document | null;
export const APPS = 'discordapplications';
const FENCES = 'responsescopes';
export const snowflake = (): string => `1${randomInt(1e8, 1e9)}${randomInt(1e8, 1e9)}`;
export const secret = (kind: string): string => `e2e-${kind}-${randomUUID()}`;
const refusal = (code: DiscordStorageError) => ({ ok: false, error: { code } });
const digest = (value: unknown): string =>
  createHash('sha256').update(String(value)).digest('hex').slice(0, 12);

/** The id of an actor's account fence row, which erasure closes and admission increments. */
const scopeKey = (userId: string, tenantId?: string): string =>
  createHash('sha256')
    .update(JSON.stringify([tenantId || null, userId, null]))
    .digest('hex');

/**
 * What a refusal must leave alone. The fence counter and `updatedAt` are left out because a refused
 * install still advances the counter that serializes writers. Credentials compare by digest, so a
 * failure never prints one.
 */
export const facts = (row: Row) =>
  row &&
  Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => key !== 'authorityWrites' && key !== 'updatedAt')
      .map(([key, value]) => [key, key.startsWith('encrypted') ? digest(value) : value]),
  );

const fenceRows = (db: Db) => db.collection<{ _id: string }>(FENCES);
export const fenceCount = (userId: string): Promise<number> =>
  withMongo((db) => fenceRows(db).countDocuments({ _id: scopeKey(userId) }));

export const rowOf = (collection: string, filter: Document) => (): Promise<Row> =>
  withMongo((db) => db.collection(collection).findOne(filter, { projection: { _id: 0 } }));

/** Runs `action` and requires the stored facts of every row read to be the same afterwards. */
export async function keeps(reads: Array<() => Promise<Row>>, action: () => Promise<unknown>) {
  const before = await Promise.all(reads.map((read) => read()));
  await action();
  expect((await Promise.all(reads.map((read) => read()))).map(facts)).toEqual(before.map(facts));
}

export const refuses = (
  code: DiscordStorageError,
  attempt: () => Promise<unknown>,
  reads: Array<() => Promise<Row>>,
) => keeps(reads, async () => expect(await attempt()).toEqual(refusal(code)));

export function ok<T>(result: DiscordStorageResult<T>): T {
  if (!result.ok) throw new Error(`Discord storage refused: ${result.error.code}`);
  return result.value;
}

export const inOrg = <T>(tenantId: string, work: () => Promise<T>): Promise<T> =>
  tenantStorage.run({ tenantId }, work);

/** The storage under test on its own connection, plus exact-id cleanup of everything it creates. */
async function open() {
  const mongo = new mongoose.Mongoose();
  await mongo.connect(getMongoUri(), { autoIndex: false });
  createModels(mongo);
  if (!(await supportsTransactions(mongo))) {
    throw new Error('Discord scenarios need a MongoDB that supports transactions (a replica set)');
  }
  const made = {
    apps: [] as string[],
    actors: [] as string[],
    users: [] as string[],
    orgs: [] as string[],
  };
  return {
    store: createDiscordInstallationStorage(mongo),
    methods: createMethods(mongo),
    app() {
      const id = { applicationId: snowflake(), botUserId: snowflake() };
      made.apps.push(id.applicationId);
      return {
        ...id,
        publicKey: randomBytes(32).toString('hex'),
        encryptedBotToken: secret('bot'),
        encryptedClientSecret: secret('client'),
      };
    },
    org(): string {
      const tenantId = `discord-e2e-${randomUUID()}`;
      made.orgs.push(tenantId);
      return tenantId;
    },
    /** A user of an organization, which the harness cannot sign in as. */
    async member(tenantId: string): Promise<string> {
      const email = `discord-${randomUUID()}@example.com`;
      const user = await inOrg(tenantId, async () =>
        mongo.models.User.create({ email, provider: 'local', tenantId }),
      );
      made.users.push(String(user._id));
      return String(user._id);
    },
    track: (...accounts: Account[]) => made.actors.push(...accounts.map(({ userId }) => userId)),
    async close() {
      const tenants = [undefined, ...made.orgs];
      const fences = [...made.actors, ...made.users].flatMap((id) =>
        tenants.map((tenantId) => scopeKey(id, tenantId)),
      );
      await withMongo(async (db) => {
        await db.collection(APPS).deleteMany({ applicationId: { $in: made.apps } });
        const ids = made.users.map((id) => new ObjectId(id));
        await db.collection('users').deleteMany({ _id: { $in: ids } });
        await fenceRows(db).deleteMany({ _id: { $in: fences } });
      });
      await mongo.disconnect();
    },
  };
}
type World = Awaited<ReturnType<typeof open>>;

/** Real accounts and the storage for one scenario, all removed by exact id when it ends. */
export async function within(
  baseURL: string | undefined,
  labels: string[],
  body: (world: World, accounts: Account[]) => Promise<void>,
): Promise<void> {
  const accounts: Account[] = [];
  let world: World | undefined;
  try {
    for (const label of labels) accounts.push(await openAccount(baseURL, label));
    world = await open();
    world.track(...accounts);
    await body(world, accounts);
  } finally {
    try {
      await world?.close();
    } finally {
      for (const account of accounts) await closeAccount(account);
    }
  }
}
