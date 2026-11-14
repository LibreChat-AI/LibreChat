import mongoose from 'mongoose';
import { randomBytes } from 'node:crypto';
import {
  createMongoAuthenticationMethods,
  createPostgresAuthenticationBackend,
  createPostgresDatabase,
  migratePostgresAuthentication,
  importAuthentication,
} from '@librechat/data-schemas';
import type { PostgresDatabase, AuthenticationBackend } from '@librechat/data-schemas';
import { createAuthenticationRuntime } from './authentication';

const mongo = createMongoAuthenticationMethods(new mongoose.Mongoose());
const config = { authentication: 'postgres', postgres: { connectionStringEnv: 'AUTH_DSN' } };
describe('authentication authority lifecycle', () => {
  function backend(): AuthenticationBackend {
    return {
      methods: { ...mongo, findSession: jest.fn(async () => null) },
      initialize: jest.fn(async () => undefined),
      close: jest.fn(async () => undefined),
    };
  }
  it('never constructs PostgreSQL for the default Mongo authority', async () => {
    const create = jest.fn(backend);
    const runtime = createAuthenticationRuntime(mongo, {}, create);
    const captured = runtime.methods.findSession;
    await expect(captured({ userId: 'user' })).rejects.toThrow('not initialized');
    await runtime.initialize(undefined);
    expect(create).not.toHaveBeenCalled();
    await runtime.initialize(config);
    expect(create).not.toHaveBeenCalled();
    await runtime.close();
    await expect(captured({ userId: 'user' })).rejects.toThrow('not initialized');
  });
  it('constructs one injected authority, keeps captured references, and closes once', async () => {
    const selected = backend();
    const create = jest.fn(() => selected);
    const runtime = createAuthenticationRuntime(mongo, { AUTH_DSN: 'owned-connection' }, create);
    const captured = runtime.methods.findSession;
    await runtime.initialize(config);
    await runtime.initialize(undefined);
    expect(create).toHaveBeenCalledTimes(1);
    expect(selected.initialize).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ connectionString: 'owned-connection', max: 10 }),
    );
    await expect(captured({ userId: 'user' })).resolves.toBeNull();
    expect(selected.methods.findSession).toHaveBeenCalledWith({ userId: 'user' });
    expect(runtime.methods.findSession).toBe(captured);
    await runtime.close();
    await runtime.close();
    expect(selected.close).toHaveBeenCalledTimes(1);
  });
  it.each(['construct', 'initialize'] as const)(
    'fails closed after an injected %s failure',
    async (stage) => {
      const selected = backend();
      const create = jest.fn(() => {
        if (stage === 'construct') throw new Error('private DSN');
        return selected;
      });
      jest.mocked(selected.initialize).mockRejectedValue(new Error('private DSN'));
      const runtime = createAuthenticationRuntime(mongo, { AUTH_DSN: 'owned' }, create);
      await expect(runtime.initialize(config)).rejects.toThrow(
        'PostgreSQL authentication initialization failed',
      );
      await expect(runtime.methods.findSession({ userId: 'user' })).rejects.toThrow(
        'not initialized',
      );
      await runtime.close();
      expect(selected.close).toHaveBeenCalledTimes(stage === 'initialize' ? 1 : 0);
    },
  );
  it('waits for initialization during close without publishing methods', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const selected = backend();
    jest.mocked(selected.initialize).mockImplementation(() => gate);
    const runtime = createAuthenticationRuntime(mongo, { AUTH_DSN: 'owned' }, () => selected);
    const initializing = runtime.initialize(config).catch((error: Error) => error);
    const closing = runtime.close();
    expect(selected.close).not.toHaveBeenCalled();
    release();
    expect(await initializing).toEqual(
      new Error('PostgreSQL authentication initialization failed'),
    );
    await closing;
    expect(selected.close).toHaveBeenCalledTimes(1);
    await expect(runtime.methods.findSession({ userId: 'user' })).rejects.toThrow(
      'not initialized',
    );
  });
  it('rejects invalid selection or a missing DSN before creating a backend', async () => {
    const create = jest.fn(backend);
    await expect(
      createAuthenticationRuntime(mongo, {}, create).initialize({ authentication: 'invalid' }),
    ).rejects.toThrow('Invalid');
    await expect(createAuthenticationRuntime(mongo, {}, create).initialize(config)).rejects.toThrow(
      'missing',
    );
    expect(create).not.toHaveBeenCalled();
  });
});
const postgres = process.env.PG_TEST_URL ? describe : describe.skip;
postgres('native authentication authority', () => {
  let db: PostgresDatabase | undefined;
  let admin: PostgresDatabase | undefined;
  let env: { AUTH_DSN: string };
  const schema = `auth_runtime_${randomBytes(6).toString('hex')}`;
  beforeAll(async () => {
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
    await migratePostgresAuthentication(db);
  });
  afterAll(async () => {
    await db?.close();
    await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.close();
  });
  it('refuses schema-only state then serves passkeys only from the verified selected backend', async () => {
    const failed = createAuthenticationRuntime(mongo, env, createPostgresAuthenticationBackend);
    await expect(failed.initialize(config)).rejects.toThrow('initialization failed');
    await failed.close();
    await importAuthentication(db!, async function* () {}, { offline: true, verifiedEmpty: true });
    const runtime = createAuthenticationRuntime(mongo, env, createPostgresAuthenticationBackend);
    const create = runtime.methods.createPasskey;
    await runtime.initialize(config);
    const record = await create({
      user: '0123456789abcdef01234567',
      credentialId: 'native-credential',
      publicKey: Buffer.from([1, 2, 255]),
      counter: 0,
      deviceType: 'multiDevice',
      backedUp: true,
      name: 'native',
    });
    try {
      expect(record.publicKey).toEqual(Buffer.from([1, 2, 255]));
      expect(await runtime.methods.countPasskeysByUser(record.userId)).toBe(1);
      expect((await db!.query('SELECT credential_id FROM auth_passkeys')).rows).toEqual([
        { credential_id: 'native-credential' },
      ]);
      await runtime.methods.deletePasskeysByUser(record.userId);
      expect(await runtime.methods.countPasskeysByUser(record.userId)).toBe(0);
    } finally {
      await runtime.close();
    }
  });
});
