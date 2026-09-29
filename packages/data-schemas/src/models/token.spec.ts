import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type * as t from '~/types';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createAuthTokenModel, createTokenModel } from './token';
import { createTokenMethods } from '~/methods/token';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
}));

/**
 * Collection reach for the `tokens` -> `authtokens` split.
 *
 * Reach is observed from the driver's own command monitoring as well as from
 * stored documents, because a read leaves no residue: counting documents in
 * `tokens` cannot distinguish "never read `tokens`" from "read `tokens` and
 * found nothing", and only the former is what the split promises.
 *
 * **Validates: Requirements 8.10, 8.13, 8.14, 8.30**
 */
describe('`tokens` / `authtokens` model split', () => {
  const AUTH_FLOW_USER = new mongoose.Types.ObjectId();
  const OAUTH_USER = new mongoose.Types.ObjectId();

  /** The four types the split leaves behind in `tokens`. */
  const OAUTH_TYPES = [
    'mcp_oauth',
    'mcp_oauth_refresh',
    'mcp_oauth_client',
    'oauth_refresh',
  ] as const;

  let mongoServer: MongoMemoryServer;
  let Token: mongoose.Model<t.IToken>;
  let AuthToken: mongoose.Model<t.IToken>;
  let tokens: ReturnType<typeof createTokenMethods>;
  let authTokens: ReturnType<typeof createTokenMethods>;
  let commands: string[];

  const collectionsTouched = () => [...new Set(commands)];
  const collectionNames = async () =>
    (await mongoose.connection.db!.listCollections().toArray()).map(({ name }) => name);

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    /**
     * Mirrors the Auth_Surface connection: `MONGO_AUTO_CREATE=false` and
     * `MONGO_AUTO_INDEX=false` map onto these two driver options, so neither
     * model registration nor an index build materializes a collection.
     */
    await mongoose.connect(mongoServer.getUri(), {
      autoCreate: false,
      autoIndex: false,
      monitorCommands: true,
    });

    Token = createTokenModel(mongoose);
    AuthToken = createAuthTokenModel(mongoose);
    tokens = createTokenMethods(mongoose);
    authTokens = createTokenMethods(mongoose, 'AuthToken');

    commands = [];
    mongoose.connection.getClient().on('commandStarted', (event) => {
      const collection = event.command[event.commandName];
      if (typeof collection === 'string') {
        commands.push(collection);
      }
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    commands.length = 0;
  });

  const authFlowToken = (type: string | undefined, token: string) => ({
    token,
    userId: AUTH_FLOW_USER,
    email: 'split@example.com',
    ...(type === undefined ? {} : { type }),
    expiresIn: 3600,
  });

  const oauthToken = (type: string) => ({
    token: `encrypted-${type}`,
    userId: OAUTH_USER,
    type,
    identifier: `mcp:split-server:${type}`,
    expiresIn: 3600,
  });

  it('binds the two models to distinct collections without either shadowing the other', () => {
    expect(Token.modelName).toBe('Token');
    expect(AuthToken.modelName).toBe('AuthToken');
    expect(AuthToken).not.toBe(Token);
    expect(Token.collection.name).toBe('tokens');
    expect(AuthToken.collection.name).toBe('authtokens');
    expect(mongoose.models.Token).toBe(Token);
    expect(mongoose.models.AuthToken).toBe(AuthToken);
  });

  it('materializes `authtokens` on its first insert while `MONGO_AUTO_CREATE` is false', async () => {
    expect(mongoose.connection.config.autoCreate).toBe(false);
    expect(await collectionNames()).not.toContain('authtokens');

    await authTokens.createToken(authFlowToken('password_reset', 'first-insert-token'));

    expect(await collectionNames()).toContain('authtokens');
  });

  it.each([
    { label: 'password_reset', type: 'password_reset', tokenValue: 'reset-token' },
    { label: 'email_verification', type: 'email_verification', tokenValue: 'verify-token' },
    { label: 'invite (no `type` field)', type: undefined, tokenValue: 'invite-token' },
  ])(
    'writes and reads a $label document through `authtokens` only',
    async ({ type, tokenValue }) => {
      await authTokens.createToken(authFlowToken(type, tokenValue));

      const found = await authTokens.findToken({ token: tokenValue });
      const touched = collectionsTouched();

      expect(found).not.toBeNull();
      expect(found?.type).toBe(type);
      expect(touched).toContain('authtokens');
      expect(touched).not.toContain('tokens');

      await expect(tokens.findToken({ token: tokenValue })).resolves.toBeNull();
      await expect(AuthToken.countDocuments({ token: tokenValue })).resolves.toBe(1);
      await expect(Token.countDocuments({})).resolves.toBe(0);
    },
  );

  it.each(OAUTH_TYPES)('keeps a %s document in `tokens` only', async (type) => {
    await tokens.createToken(oauthToken(type));

    const found = await tokens.findToken({ type, identifier: `mcp:split-server:${type}` });
    const touched = collectionsTouched();

    expect(found).not.toBeNull();
    expect(found?.token).toBe(`encrypted-${type}`);
    expect(touched).toContain('tokens');
    expect(touched).not.toContain('authtokens');

    await expect(
      authTokens.findToken({ type, identifier: `mcp:split-server:${type}` }),
    ).resolves.toBeNull();
    await expect(Token.countDocuments({ type })).resolves.toBe(1);
    await expect(AuthToken.countDocuments({})).resolves.toBe(0);
  });

  it('partitions the seven token classes across the two collections', async () => {
    await Promise.all([
      authTokens.createToken(authFlowToken('password_reset', 'partition-reset')),
      authTokens.createToken(authFlowToken('email_verification', 'partition-verify')),
      authTokens.createToken(authFlowToken(undefined, 'partition-invite')),
      ...OAUTH_TYPES.map((type) => tokens.createToken(oauthToken(type))),
    ]);

    const classesIn = async (model: mongoose.Model<t.IToken>) =>
      (await model.find({}).lean()).map(({ type }) => type ?? '(no type field)').sort();

    await expect(classesIn(AuthToken)).resolves.toEqual([
      '(no type field)',
      'email_verification',
      'password_reset',
    ]);
    await expect(classesIn(Token)).resolves.toEqual([...OAUTH_TYPES].sort());
  });

  it('confines an update and a delete to the collection of the set that issued it', async () => {
    const shared = {
      token: 'shared-token-value',
      userId: AUTH_FLOW_USER,
      type: 'password_reset',
      expiresIn: 3600,
    };
    await tokens.createToken(shared);
    await authTokens.createToken(shared);

    const updated = await authTokens.updateToken(
      { token: 'shared-token-value' },
      { identifier: 'authtokens-only' },
    );
    expect(updated?.identifier).toBe('authtokens-only');
    const untouched = await Token.findOne({ token: 'shared-token-value' }).lean();
    expect(untouched?.identifier).toBeUndefined();

    const deleted = await authTokens.deleteTokens({ token: 'shared-token-value' });
    expect(deleted.deletedCount).toBe(1);
    await expect(AuthToken.countDocuments({})).resolves.toBe(0);
    await expect(Token.countDocuments({ token: 'shared-token-value' })).resolves.toBe(1);
  });

  it("returns only the active tenant's documents from a scoped `authtokens` query", async () => {
    await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
      await authTokens.createToken(authFlowToken('password_reset', 'tenant-a-token'));
    });
    await tenantStorage.run({ tenantId: 'tenant-b' }, async () => {
      await authTokens.createToken(authFlowToken('password_reset', 'tenant-b-token'));
    });

    const fromTenantA = await tenantStorage.run({ tenantId: 'tenant-a' }, async () => ({
      own: await authTokens.findToken({ type: 'password_reset' }),
      other: await authTokens.findToken({ token: 'tenant-b-token' }),
    }));

    expect(fromTenantA.own?.token).toBe('tenant-a-token');
    expect(fromTenantA.own?.tenantId).toBe('tenant-a');
    expect(fromTenantA.other).toBeNull();

    const everyTenant = await runAsSystem(async () => AuthToken.find({}).lean());
    expect(everyTenant.map(({ tenantId }) => tenantId).sort()).toEqual(['tenant-a', 'tenant-b']);
  });
});
