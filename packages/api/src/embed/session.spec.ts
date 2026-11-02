import { Keyv } from 'keyv';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { EmbedSessionDependencies } from './session';
import { createEmbedSessionHandler, getEmbedAccountKeys } from './session';

const SECRET = 'e'.repeat(48);
const ORIGIN = 'https://portal.example.com';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
const originalJwtSecret = process.env.JWT_SECRET;

const appConfig = {
  embed: {
    enabled: true,
    apps: [{ id: 'portal', secret: SECRET, allowedOrigins: [ORIGIN], role: 'USER' }],
  },
} as unknown as AppConfig;

beforeAll(async () => {
  process.env.JWT_SECRET = 'jwt-secret-for-embed-tests';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  process.env.JWT_SECRET = originalJwtSecret;
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await mongoose.models.User.deleteMany({});
});

let jtiCounter = 0;
const hostToken = (claims: Record<string, unknown> = {}) =>
  jwt.sign({ sub: 'host-user-1', jti: `jti-${++jtiCounter}`, name: 'Ada', ...claims }, SECRET, {
    algorithm: 'HS256',
    audience: 'portal',
    expiresIn: 120,
  });

function createDeps(overrides: Partial<EmbedSessionDependencies> = {}): EmbedSessionDependencies {
  return {
    getAppConfig: async () => appConfig,
    findUser: (fields) => methods.findUser(fields),
    createUserIfAbsent: methods.createUserIfAbsent,
    getBalanceConfig: () => null,
    generateToken: (user, expiresIn) =>
      methods.generateToken(user as Parameters<typeof methods.generateToken>[0], expiresIn),
    replayStore: new Keyv(),
    ...overrides,
  };
}

async function post(deps: EmbedSessionDependencies, body: Record<string, unknown>) {
  const response: { status?: number; body?: Record<string, unknown> } = {};
  const res = {
    status(code: number) {
      response.status = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      response.body = payload;
      return this;
    },
  } as unknown as Response;
  await createEmbedSessionHandler(deps)({ body } as Request, res);
  return response;
}

describe('createEmbedSessionHandler', () => {
  it('creates one embed account per host user and returns a LibreChat token', async () => {
    const deps = createDeps();
    const first = await post(deps, { app: 'portal', origin: ORIGIN, token: hostToken() });
    expect(first.status).toBe(200);
    const payload = jwt.verify(first.body?.token as string, process.env.JWT_SECRET as string) as {
      id: string;
    };

    const second = await post(deps, { app: 'portal', origin: ORIGIN, token: hostToken() });
    expect(second.status).toBe(200);
    const again = jwt.verify(second.body?.token as string, process.env.JWT_SECRET as string) as {
      id: string;
    };
    expect(again.id).toBe(payload.id);

    const users = await mongoose.models.User.find({}).lean();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      provider: 'embed',
      idOnTheSource: 'portal:host-user-1',
      name: 'Ada',
      role: 'USER',
      email: getEmbedAccountKeys('portal', 'host-user-1').email,
    });
    expect(first.body?.user).not.toHaveProperty('password');
  });

  it('keeps different host users apart', async () => {
    const deps = createDeps();
    const one = await post(deps, { app: 'portal', origin: ORIGIN, token: hostToken() });
    const two = await post(deps, {
      app: 'portal',
      origin: ORIGIN,
      token: hostToken({ sub: 'host-user-2' }),
    });
    const idOf = (token: unknown) =>
      (jwt.verify(token as string, process.env.JWT_SECRET as string) as { id: string }).id;
    expect(idOf(one.body?.token)).not.toBe(idOf(two.body?.token));
  });

  it('refuses a token id it has already accepted', async () => {
    const deps = createDeps();
    const token = hostToken();
    expect((await post(deps, { app: 'portal', origin: ORIGIN, token })).status).toBe(200);
    expect(await post(deps, { app: 'portal', origin: ORIGIN, token })).toEqual({
      status: 401,
      body: { code: 'token_replayed' },
    });
  });

  it('refuses an origin the app does not allow', async () => {
    const result = await post(createDeps(), {
      app: 'portal',
      origin: 'https://evil.example',
      token: hostToken(),
    });
    expect(result).toEqual({ status: 403, body: { code: 'origin_not_allowed' } });
  });

  it('refuses an unknown app and a malformed request', async () => {
    const deps = createDeps();
    expect(await post(deps, { app: 'other', origin: ORIGIN, token: hostToken() })).toEqual({
      status: 403,
      body: { code: 'unknown_app' },
    });
    expect(await post(deps, { app: 'portal', origin: ORIGIN })).toEqual({
      status: 400,
      body: { code: 'invalid_request' },
    });
  });

  it('refuses a token signed with another secret without revealing why', async () => {
    const forged = jwt.sign({ sub: 'host-user-1', jti: 'forged' }, 'f'.repeat(48), {
      audience: 'portal',
      expiresIn: 60,
    });
    expect(await post(createDeps(), { app: 'portal', origin: ORIGIN, token: forged })).toEqual({
      status: 401,
      body: { code: 'invalid_token' },
    });
  });

  it('reports embedding as disabled when no app is configured', async () => {
    const deps = createDeps({ getAppConfig: async () => ({}) as AppConfig });
    expect(await post(deps, { app: 'portal', origin: ORIGIN, token: hostToken() })).toEqual({
      status: 404,
      body: { code: 'embed_disabled' },
    });
  });

  it('never signs in to an account that is not the embed identity', async () => {
    const { email } = getEmbedAccountKeys('portal', 'host-user-1');
    await methods.createUser({ email, provider: 'local', name: 'Squatter' });
    expect(await post(createDeps(), { app: 'portal', origin: ORIGIN, token: hostToken() })).toEqual(
      {
        status: 409,
        body: { code: 'identity_conflict' },
      },
    );
  });

  it('maps an unexpected failure to a generic code', async () => {
    const deps = createDeps({
      findUser: async () => {
        throw new Error('database is down: mongodb://secret@host');
      },
    });
    expect(await post(deps, { app: 'portal', origin: ORIGIN, token: hostToken() })).toEqual({
      status: 500,
      body: { code: 'embed_session_failed' },
    });
  });
});
