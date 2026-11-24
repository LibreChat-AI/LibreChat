import mongoose from 'mongoose';
import { randomBytes } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createMCPAuthorityBootRevision,
  createMCPAuthorityConfigSourceRevision,
  createMCPAuthorityCredentialRevision,
  createMongoAuthenticationMethods,
  createPostgresAuthenticationBackend,
  createPostgresDatabase,
  migratePostgresAuthentication,
  importAuthentication,
} from '@librechat/data-schemas';
import type {
  PostgresDatabase,
  AuthenticationBackend,
  MCPAuthorityResolveInput,
} from '@librechat/data-schemas';
import { createPostgresTestDatabase } from '../../../data-schemas/src/postgres/postgres.helper';
import { createAuthenticationRuntime } from './authentication';

const mongo = createMongoAuthenticationMethods(new mongoose.Mongoose());
const config = { authentication: 'postgres', postgres: { connectionStringEnv: 'AUTH_DSN' } };
describe('authentication authority lifecycle', () => {
  function backend(): AuthenticationBackend {
    return {
      methods: {
        ...mongo,
        findSession: jest.fn(async () => null),
        getMCPAuthorityTokens: jest.fn(async () => ({ tokens: [], count: 0 })),
      },
      initialize: jest.fn(async () => undefined),
      close: jest.fn(async () => undefined),
    };
  }
  it('never constructs PostgreSQL for the default Mongo authority', async () => {
    const create = jest.fn(backend);
    const runtime = createAuthenticationRuntime(mongo, {}, create);
    const captured = runtime.methods.findSession;
    const select = runtime.selectMCPAuthorityTokenReader;
    expect(select).toThrow('not initialized');
    await expect(captured({ userId: 'user' })).rejects.toThrow('not initialized');
    await runtime.initialize(undefined);
    expect(select()).toBeNull();
    expect(create).not.toHaveBeenCalled();
    await runtime.initialize(config);
    expect(create).not.toHaveBeenCalled();
    await runtime.close();
    expect(select).toThrow('not initialized');
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
    const reader = runtime.selectMCPAuthorityTokenReader()!;
    const input = { userId: 'user', serverNames: ['server'], limit: 3 };
    await expect(reader.getMCPAuthorityTokens(input)).resolves.toEqual({ tokens: [], count: 0 });
    expect(selected.methods.getMCPAuthorityTokens).toHaveBeenCalledWith(input);
    await runtime.close();
    expect(runtime.selectMCPAuthorityTokenReader).toThrow('not initialized');
    await expect(reader.getMCPAuthorityTokens(input)).rejects.toThrow('not initialized');
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
      expect(runtime.selectMCPAuthorityTokenReader).toThrow('not initialized');
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
    expect(runtime.selectMCPAuthorityTokenReader).toThrow('not initialized');
    const closing = runtime.close();
    expect(selected.close).not.toHaveBeenCalled();
    release();
    expect(await initializing).toEqual(
      new Error('PostgreSQL authentication initialization failed'),
    );
    await closing;
    expect(runtime.selectMCPAuthorityTokenReader).toThrow('not initialized');
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
describe('MCP proof routing through composed authentication', () => {
  const serverName = 'proof-server';
  const resolvedConfig = { type: 'sse', url: 'https://example.com/mcp' } as const;
  const boot = createMCPAuthorityBootRevision('proof-routing', {
    mcpServers: { [serverName]: resolvedConfig },
  });
  const unavailable = { name: 'MCPAuthorityProofError', reason: 'proof_unavailable' };
  let replset: MongoMemoryReplSet;
  let models: ReturnType<typeof createModels>;
  let userId: string;

  const input = (generation: string): MCPAuthorityResolveInput => ({
    userId,
    boot,
    targets: [
      {
        serverName,
        source: 'config',
        sourceRevision: createMCPAuthorityConfigSourceRevision(boot.digest, []),
        expectedCredentialRevision: createMCPAuthorityCredentialRevision([], []),
        expectedOAuthGrantGeneration: generation,
        resolvedConfig,
        requiresOAuth: true,
      },
    ],
  });
  const grant = (generation: string) => ({
    userId,
    type: 'mcp_oauth',
    identifier: `mcp:${serverName}`,
    token: 'A',
    metadata: { credential_set_id: generation },
  });

  beforeAll(async () => {
    replset = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
      instanceOpts: [{ args: ['--nounixsocket'] }],
    });
    // The proof creates its namespaces; background index builds can abort its transaction.
    await mongoose.connect(replset.getUri(), { autoIndex: false, autoCreate: false });
    models = createModels(mongoose);
    const role = 'MCP_PROOF_USER';
    const [user] = await Promise.all([
      models.User.create({ email: 'proof@example.com', provider: 'local', role }),
      models.Role.create({
        name: role,
        permissions: { [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true } },
      }),
    ]);
    userId = user._id.toString();
    await models.Token.create({ ...grant('mongo'), expiresAt: new Date(Date.now() + 3_600_000) });
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await replset?.stop();
  });

  it('reads Mongo tokens once per proof in the same session, only after default selection', async () => {
    const mongo = createMongoAuthenticationMethods(mongoose);
    const external = jest.spyOn(mongo, 'getMCPAuthorityTokens');
    const count = jest.spyOn(models.Token, 'countDocuments');
    const rows = jest.spyOn(models.Token, 'find');
    const create = jest.fn(createPostgresAuthenticationBackend);
    const runtime = createAuthenticationRuntime(mongo, {}, create);
    const { resolveMCPAuthorityProof: resolve, assertMCPAuthorityProofsCurrent: assert } =
      createMethods(mongoose, { authentication: runtime });
    const session = await mongoose.startSession();
    const resolveInput = { ...input('mongo'), session };
    try {
      await expect(resolve(resolveInput)).rejects.toMatchObject(unavailable);
      expect(count).not.toHaveBeenCalled();
      expect(rows).not.toHaveBeenCalled();

      await runtime.initialize(undefined);
      const proof = await resolve(resolveInput);
      expect(proof.servers[0].oauthGrantGeneration).toBe('mongo');
      expect(count).toHaveBeenCalledTimes(1);
      expect(rows).toHaveBeenCalledTimes(1);
      expect(count.mock.results[0].value.getOptions().session).toBe(session);
      expect(rows.mock.results[0].value.getOptions().session).toBe(session);
      expect(external).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();

      const assertion = { proofs: proof, boot, session };
      await expect(assert(assertion)).resolves.toBeUndefined();
      await runtime.close();
      await expect(assert(assertion)).rejects.toMatchObject(unavailable);
      expect(count).toHaveBeenCalledTimes(2);
      expect(rows).toHaveBeenCalledTimes(2);
    } finally {
      await session.endSession();
      await runtime.close();
    }
  });

  it('does not fall back to the seeded Mongo grant when PostgreSQL initialization fails', async () => {
    const runtime = createAuthenticationRuntime(
      createMongoAuthenticationMethods(mongoose),
      {},
      createPostgresAuthenticationBackend,
    );
    const { resolveMCPAuthorityProof: resolve } = createMethods(mongoose, {
      authentication: runtime,
    });
    try {
      await expect(runtime.initialize(config)).rejects.toThrow('missing');
      await expect(resolve(input('mongo'))).rejects.toMatchObject(unavailable);
    } finally {
      await runtime.close();
    }
  });

  postgres('SQL proof reader', () => {
    it('brackets the Mongo commit with SQL reads and rejects SQL ABA', async () => {
      const { db, options } = await createPostgresTestDatabase();
      const backend = createPostgresAuthenticationBackend(options);
      const runtime = createAuthenticationRuntime(
        createMongoAuthenticationMethods(mongoose),
        { AUTH_DSN: options.connectionString },
        () => backend,
      );
      const methods = createMethods(mongoose, { authentication: runtime });
      const count = jest.spyOn(models.Token, 'countDocuments');
      const rows = jest.spyOn(models.Token, 'find');
      const session = await mongoose.startSession();
      const commitsAtRead: number[] = [];
      let commits = 0;
      const commitTransaction = session.commitTransaction.bind(session);
      const commit = async () => {
        await commitTransaction();
        commits++;
      };
      const committed = jest.spyOn(session, 'commitTransaction').mockImplementation(commit);
      const getTokens = backend.methods.getMCPAuthorityTokens;
      const reads = jest
        .spyOn(backend.methods, 'getMCPAuthorityTokens')
        .mockImplementation((input) => {
          expect(session.inTransaction()).toBe(false);
          commitsAtRead.push(commits);
          return getTokens(input);
        });
      const resolveInput = { ...input('postgres'), session };
      try {
        await migratePostgresAuthentication(db);
        await importAuthentication(db, async function* () {}, {
          offline: true,
          verifiedEmpty: true,
        });
        await runtime.initialize(config);
        await methods.createToken({ ...grant('postgres'), expiresIn: 3600 });

        const proof = await methods.resolveMCPAuthorityProof(resolveInput);
        expect(proof.servers[0].oauthGrantGeneration).toBe('postgres');
        expect(commitsAtRead).toEqual([0, 1]);

        const direct = createMethods(mongoose, { authentication: backend.methods });
        await expect(direct.resolveMCPAuthorityProof(resolveInput)).resolves.toEqual(proof);
        expect(commitsAtRead).toEqual([0, 1, 1, 2]);

        committed.mockImplementationOnce(async () => {
          await commit();
          await methods.updateToken({ userId, token: 'A' }, { token: 'B' });
          await methods.updateToken({ userId, token: 'B' }, { token: 'A' });
        });
        await expect(methods.resolveMCPAuthorityProof(resolveInput)).rejects.toMatchObject({
          ...unavailable,
          message: 'MCP OAuth grants changed during the authority snapshot',
        });
        expect(commitsAtRead).toEqual([0, 1, 1, 2, 2, 3]);

        reads.mockRejectedValueOnce(new Error('SQL tokens unavailable'));
        await expect(methods.resolveMCPAuthorityProof(input('mongo'))).rejects.toMatchObject(
          unavailable,
        );
        expect(count).not.toHaveBeenCalled();
        expect(rows).not.toHaveBeenCalled();
      } finally {
        await session.endSession();
        try {
          await runtime.close();
        } finally {
          await db.close();
        }
      }
    });
  });
});

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
