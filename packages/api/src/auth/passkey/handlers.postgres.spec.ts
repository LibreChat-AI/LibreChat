import { randomBytes } from 'node:crypto';
import {
  tenantStorage,
  createPostgresDatabase,
  migratePostgresAuthentication,
  createPostgresAuthenticationBackend,
} from '@librechat/data-schemas';
import type { PostgresDatabase, PostgresOptions } from '@librechat/data-schemas';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Response } from 'express';
import type { PasskeyHandlersDeps, AuthenticatedPasskeyRequest } from './handlers';
import { verifyPasskeyRegistration } from '~/auth/passkey';
import { createPasskeyHandlers } from './handlers';

jest.mock('~/auth/passkey', () => ({
  ...jest.requireActual('~/auth/passkey'),
  verifyPasskeyRegistration: jest.fn(),
}));

const postgres = process.env.PG_TEST_URL ? describe : describe.skip;
const user = '0123456789abcdef01234567';
const other = '1123456789abcdef01234567';
const credential = {
  user,
  credentialId: 'duplicate-credential',
  publicKey: Buffer.from([1, 2, 3]),
  counter: 0,
  transports: ['internal'],
  deviceType: 'singleDevice' as const,
  backedUp: false,
  name: 'Laptop',
};
const options: PostgresOptions = {
  connectionString: process.env.PG_TEST_URL ?? '',
  max: 4,
  maxWaiting: 20,
  acquireTimeoutMs: 1000,
  queryTimeoutMs: 5000,
  idleTimeoutMs: 1000,
};

postgres('native passkey registration conflicts', () => {
  let admin: PostgresDatabase;
  let db: PostgresDatabase;
  let backend: ReturnType<typeof createPostgresAuthenticationBackend>;
  let schema: string;
  const enabled = process.env.ALLOW_PASSKEY_LOGIN;
  beforeAll(async () => {
    admin = createPostgresDatabase(options);
    schema = `passkey_handler_${randomBytes(8).toString('hex')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(options.connectionString);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const scoped = { ...options, connectionString: url.toString() };
    db = createPostgresDatabase(scoped);
    await migratePostgresAuthentication(db);
    backend = createPostgresAuthenticationBackend(scoped);
    process.env.ALLOW_PASSKEY_LOGIN = 'true';
  });
  beforeEach(async () => {
    await db.query('TRUNCATE auth_passkeys,auth_sessions');
    jest.mocked(verifyPasskeyRegistration).mockResolvedValue(credential);
  });
  afterAll(async () => {
    if (enabled === undefined) delete process.env.ALLOW_PASSKEY_LOGIN;
    else process.env.ALLOW_PASSKEY_LOGIN = enabled;
    await backend?.close();
    await db?.close();
    if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.close();
  });

  it.each(['race', 'foreign tenant'])(
    'answers 409 for a %s duplicate without minting a session',
    async (kind) => {
      const ownerTenant = kind === 'race' ? 'b' : 'a';
      await tenantStorage.run({ tenantId: ownerTenant }, async () =>
        backend.methods.createPasskey({ ...credential, user: other }),
      );
      const account = {
        _id: user,
        id: user,
        email: 'user@example.com',
        provider: 'local',
        password: 'hash',
      };
      const deps: PasskeyHandlersDeps = {
        ...backend.methods,
        getUserById: async () => account,
        updateUser: async () => account,
        compare: async (password, hash) => password === 'password' && hash === 'hash',
        getChallengeCache: () => ({
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => true,
        }),
        checkBan: async () => undefined,
        ...(kind === 'race' ? { findPasskeyByCredentialId: async () => null } : {}),
      };
      const req = {
        user: account,
        body: {
          password: 'password',
          credential: { id: credential.credentialId } as RegistrationResponseJSON,
        },
      } as AuthenticatedPasskeyRequest<{
        password: string;
        credential: RegistrationResponseJSON;
      }>;
      const res = { status: jest.fn(), json: jest.fn() };
      res.status.mockReturnValue(res);
      res.json.mockReturnValue(res);
      await tenantStorage.run({ tenantId: 'b' }, async () => {
        const visible = await backend.methods.findPasskeyByCredentialId(credential.credentialId);
        if (kind === 'foreign tenant') expect(visible).toBeNull();
        else expect(visible).not.toBeNull();
        await createPasskeyHandlers(deps).registerPasskeyVerify(req, res as unknown as Response);
      });
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.status).not.toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: 'This passkey is already registered' });
      expect(
        (await db.query('SELECT count(*)::text AS count FROM auth_sessions')).rows[0].count,
      ).toBe('0');
      expect(
        (await db.query('SELECT count(*)::text AS count FROM auth_passkeys')).rows[0].count,
      ).toBe('1');
    },
  );
});
