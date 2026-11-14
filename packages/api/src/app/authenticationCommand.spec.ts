import mongoose from 'mongoose';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createPostgresDatabase, createMongoAuthenticationSource } from '@librechat/data-schemas';
import type { PostgresDatabase } from '@librechat/data-schemas';
import { runAuthenticationCommand } from './authenticationCommand';

describe('authentication command arguments', () => {
  it.each([
    [],
    ['migrate', '--dry-run'],
    ['migrate', '--offline'],
    ['verify', '--dry-run'],
    ['unknown'],
    ['__proto__'],
    ['import'],
    ['verify'],
    ['import', '--offline', '--offline'],
  ])('refuses %j before config or database construction', async (...args) => {
    const loadCustomConfig = jest.fn();
    const connectDb = jest.fn();
    const createDatabase = jest.fn();
    const disconnectDb = jest.fn(async () => undefined);
    await expect(
      runAuthenticationCommand({
        args,
        env: {},
        source: async function* () {},
        loadCustomConfig,
        connectDb,
        createDatabase,
        disconnectDb,
      }),
    ).rejects.toThrow();
    expect(loadCustomConfig).not.toHaveBeenCalled();
    expect(createDatabase).not.toHaveBeenCalled();
    expect(connectDb).not.toHaveBeenCalled();
    expect(disconnectDb).toHaveBeenCalledTimes(1);
  });
});
const postgres = process.env.PG_TEST_URL ? describe : describe.skip;
postgres('real authentication migration commands', () => {
  let mongo: MongoMemoryServer | undefined;
  let admin: PostgresDatabase | undefined;
  let db: PostgresDatabase | undefined;
  let env: { AUTH_DSN: string };
  const schema = `auth_cli_${randomBytes(6).toString('hex')}`;
  const config = {
    persistence: { authentication: 'postgres', postgres: { connectionStringEnv: 'AUTH_DSN' } },
  };
  const loadCustomConfig = async () => config;
  const source = createMongoAuthenticationSource(mongoose);
  const connectDb = () =>
    mongoose.connect(mongo!.getUri(), { autoCreate: false, autoIndex: false });
  const run = (args: string[]) =>
    runAuthenticationCommand({
      args,
      env,
      source,
      loadCustomConfig,
      connectDb,
      disconnectDb: () => mongoose.disconnect(),
      createDatabase: createPostgresDatabase,
    });
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
    const options = {
      connectionString: process.env.PG_TEST_URL!,
      max: 2,
      maxWaiting: 10,
      acquireTimeoutMs: 1000,
      queryTimeoutMs: 5000,
      idleTimeoutMs: 1000,
    };
    admin = createPostgresDatabase(options);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(options.connectionString);
    url.searchParams.set('options', `-c search_path=${schema}`);
    env = { AUTH_DSN: url.toString() };
    db = createPostgresDatabase({ ...options, connectionString: env.AUTH_DSN });
  }, 90000);
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
    await db?.close();
    await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.close();
  });
  it('runs the actual native migration entrypoint without Mongo configuration and rejects migration dry runs', async () => {
    const root = resolve(__dirname, '../../../../.verification/identity');
    mkdirSync(root, { recursive: true });
    const scratch = mkdtempSync(resolve(root, 'command-'));
    const configPath = resolve(scratch, 'config.yaml');
    writeFileSync(
      configPath,
      'version: 1.3.1\npersistence:\n  authentication: postgres\n  postgres:\n    connectionStringEnv: AUTH_DSN\n',
    );
    try {
      const entry = resolve(__dirname, '../../../../config/postgres-auth.js');
      const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, CONFIG_PATH: configPath };
      delete childEnv.MONGO_URI;
      const child = await promisify(execFile)(process.execPath, [entry, 'migrate'], {
        env: childEnv,
        cwd: scratch,
        timeout: 15000,
        killSignal: 'SIGKILL',
      });
      expect(child.stdout).toContain('Authentication schema migrated');
      expect(child.stderr).toBe('');
      const before = (await db!.query('SELECT * FROM librechat_auth_migrations')).rows;
      await expect(
        promisify(execFile)(process.execPath, [entry, 'migrate', '--dry-run'], {
          env: childEnv,
          cwd: scratch,
          timeout: 15000,
          killSignal: 'SIGKILL',
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect((await db!.query('SELECT * FROM librechat_auth_migrations')).rows).toEqual(before);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  it('imports a raw model-free snapshot and verifies all selected collections without changing authority', async () => {
    await run(['migrate']);
    await connectDb();
    const now = new Date();
    const future = new Date(Date.now() + 3600000);
    const user = new mongoose.Types.ObjectId('0123456789abcdef01234567');
    await mongoose.connection.collection('sessions').insertOne({
      _id: new mongoose.Types.ObjectId(),
      user,
      refreshTokenHash: 'hashed-session',
      expiration: future,
    });
    await mongoose.connection.collection('passkeys').insertOne({
      _id: new mongoose.Types.ObjectId(),
      user,
      credentialId: 'migrated',
      publicKey: Buffer.from([0, 255, 3]),
      counter: 0,
      transports: ['usb'],
      deviceType: 'singleDevice',
      backedUp: false,
      name: 'migrated',
      createdAt: now,
      updatedAt: now,
    });
    const before = await mongoose.connection.db!.listCollections().toArray();
    await mongoose.disconnect();
    await run(['import', '--offline', '--dry-run']);
    expect((await db!.query('SELECT count(*) FROM auth_sessions')).rows).toEqual([{ count: '0' }]);
    await run(['import', '--offline']);
    await run(['verify', '--offline']);
    expect(
      (await db!.query('SELECT verified,activated,imported FROM auth_readiness')).rows,
    ).toEqual([{ verified: true, activated: false, imported: '2' }]);
    expect((await db!.query('SELECT public_key FROM auth_passkeys')).rows[0].public_key).toEqual(
      Buffer.from([0, 255, 3]),
    );
    await connectDb();
    expect(await mongoose.connection.db!.listCollections().toArray()).toEqual(before);
    await mongoose.disconnect();
  });
});
