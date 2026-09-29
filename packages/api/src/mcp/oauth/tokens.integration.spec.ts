import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { OAuthClientInformation } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { TokenMethods } from '@librechat/data-schemas';

/**
 * `@librechat/data-schemas` derives its AES key from `CREDS_KEY` at module load,
 * so both variables must be set before the module is first imported. Every
 * import that reaches it is therefore deferred into `beforeAll`.
 */
process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.CREDS_IV = process.env.CREDS_IV ?? '0123456789abcdef0123456789abcdef';

type DataSchemas = typeof import('@librechat/data-schemas');
type MCPTokenStorageClass = typeof import('~/mcp/oauth').MCPTokenStorage;

/**
 * The `tokens` side of the `tokens` -> `authtokens` split, exercised against a
 * real MongoDB through the real token methods and the real `CREDS_KEY`
 * encryption rather than an in-memory store — the assertion is about which
 * collection the MCP OAuth material resolves from, which a fake store cannot
 * observe.
 *
 * **Validates: Requirements 8.10, 8.18, 8.31**
 */
describe('MCP OAuth material resolves from `tokens` after the auth token split', () => {
  const USER_ID = new mongoose.Types.ObjectId().toString();
  const SERVER_NAME = 'split-server';
  const IDENTIFIER = `mcp:${SERVER_NAME}`;

  const CLIENT_INFO: OAuthClientInformation = {
    client_id: 'client-abc',
    client_secret: 'client-secret-xyz',
  };
  const CLIENT_METADATA = {
    token_endpoint: 'https://idp.example.com/oauth/token',
    token_endpoint_auth_methods_supported: ['client_secret_post'],
  };

  let mongoServer: MongoMemoryServer;
  let MCPTokenStorage: MCPTokenStorageClass;
  let decryptV2: DataSchemas['decryptV2'];
  let tokenMethods: TokenMethods;
  let authTokenMethods: TokenMethods;
  let commands: string[];

  const collectionsTouched = () => [...new Set(commands)];
  const rawTokens = () => mongoose.connection.db!.collection('tokens');
  const rawAuthTokens = () => mongoose.connection.db!.collection('authtokens');

  beforeAll(async () => {
    const dataSchemas = await import('@librechat/data-schemas');
    ({ decryptV2 } = dataSchemas);
    ({ MCPTokenStorage } = await import('~/mcp/oauth'));

    mongoServer = await MongoMemoryServer.create();
    /**
     * Registration issues no `createCollection` and no index build, so every
     * command the monitor records is one the code under test asked for.
     */
    await mongoose.connect(mongoServer.getUri(), {
      autoCreate: false,
      autoIndex: false,
      monitorCommands: true,
    });
    dataSchemas.createModels(mongoose);

    const methods = dataSchemas.createMethods(mongoose);
    const { createToken, findToken, updateToken, deleteTokens } = methods;
    tokenMethods = { createToken, findToken, updateToken, deleteTokens };
    authTokenMethods = methods.authTokens;

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

  const storeRoundTrip = () =>
    MCPTokenStorage.storeTokens({
      userId: USER_ID,
      serverName: SERVER_NAME,
      tokens: {
        access_token: 'access-token-plaintext',
        refresh_token: 'refresh-token-plaintext',
        token_type: 'Bearer',
        expires_in: 3600,
      },
      createToken: tokenMethods.createToken,
      updateToken: tokenMethods.updateToken,
      findToken: tokenMethods.findToken,
      clientInfo: CLIENT_INFO,
      metadata: CLIENT_METADATA,
    });

  it('stores and retrieves an `mcp_oauth` token against `tokens` and never `authtokens`', async () => {
    await storeRoundTrip();
    const retrieved = await MCPTokenStorage.getTokens({
      userId: USER_ID,
      serverName: SERVER_NAME,
      findToken: tokenMethods.findToken,
    });
    const touched = collectionsTouched();

    expect(retrieved?.access_token).toBe('access-token-plaintext');
    expect(retrieved?.refresh_token).toBe('refresh-token-plaintext');
    expect(touched).toContain('tokens');
    expect(touched).not.toContain('authtokens');

    await expect(
      rawTokens().countDocuments({ userId: new mongoose.Types.ObjectId(USER_ID) }),
    ).resolves.toBe(3);
    await expect(rawAuthTokens().countDocuments({})).resolves.toBe(0);
  });

  it('writes each of the three MCP OAuth types to `tokens` as ciphertext', async () => {
    await storeRoundTrip();

    const stored = await rawTokens().find({}).toArray();
    const byType = new Map(stored.map((doc) => [doc.type, doc]));

    expect([...byType.keys()].sort()).toEqual([
      'mcp_oauth',
      'mcp_oauth_client',
      'mcp_oauth_refresh',
    ]);
    expect(byType.get('mcp_oauth')?.identifier).toBe(IDENTIFIER);
    expect(byType.get('mcp_oauth_refresh')?.identifier).toBe(`${IDENTIFIER}:refresh`);
    expect(byType.get('mcp_oauth_client')?.identifier).toBe(`${IDENTIFIER}:client`);

    expect(byType.get('mcp_oauth')?.token).not.toBe('access-token-plaintext');
    expect(byType.get('mcp_oauth_refresh')?.token).not.toBe('refresh-token-plaintext');
    expect(byType.get('mcp_oauth_client')?.token).not.toContain(CLIENT_INFO.client_secret);
  });

  it('resolves a stored `mcp_oauth_client` registration from `tokens` and decrypts it under `CREDS_KEY`', async () => {
    await storeRoundTrip();

    commands.length = 0;
    const resolved = await MCPTokenStorage.getClientInfoAndMetadata({
      userId: USER_ID,
      serverName: SERVER_NAME,
      findToken: tokenMethods.findToken,
    });
    const touched = collectionsTouched();

    expect(resolved?.clientInfo).toEqual(CLIENT_INFO);
    expect(resolved?.clientMetadata).toMatchObject(CLIENT_METADATA);
    expect(touched).toEqual(['tokens']);

    const stored = await rawTokens().findOne({ type: 'mcp_oauth_client' });
    expect(JSON.parse(await decryptV2(stored!.token))).toEqual(CLIENT_INFO);
    await expect(rawAuthTokens().countDocuments({})).resolves.toBe(0);
  });

  it('leaves the MCP OAuth material unreachable through the `authtokens` method set', async () => {
    await storeRoundTrip();

    for (const type of ['mcp_oauth', 'mcp_oauth_refresh', 'mcp_oauth_client']) {
      await expect(authTokenMethods.findToken({ userId: USER_ID, type })).resolves.toBeNull();
    }

    await expect(
      tokenMethods.findToken({ userId: USER_ID, type: 'mcp_oauth', identifier: IDENTIFIER }),
    ).resolves.not.toBeNull();
  });
});
