import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { ISession, IUser } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import { createLocalRefreshHandler } from './localRefresh';

type Methods = ReturnType<typeof createMethods>;
type Deps = Parameters<typeof createLocalRefreshHandler>[0];

/** What one refresh response carried back to the browser. */
type Sent = { status?: number; body?: unknown; cookies: Record<string, string | null> };

let mongoServer: MongoMemoryServer;
let methods: Methods;

/** CI exports `NODE_ENV=CI`, which sends the handler down its sessionless shortcut. */
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'access-secret';
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'refresh-secret';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  await mongoose.models.User.deleteMany({});
  await mongoose.models.Session.deleteMany({});
});

async function createUser(): Promise<string> {
  const user = (await methods.createUser(
    { email: `user-${Date.now()}-${Math.random()}@example.com`, provider: 'local' },
    undefined,
    true,
    true,
  )) as Partial<IUser>;
  return String(user._id);
}

/** `AuthService.setAuthTokens` as production wires it: a session it is handed gets rotated. */
async function setAuthTokens(_userId: string, res: Response, session: ISession | null) {
  if (session) {
    res.cookie('refreshToken', await methods.generateRefreshToken(session));
  }
  return 'set-auth-tokens-access-token';
}

function createDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    userProjection: '-password -__v -totpSecret -backupCodes -federatedTokens',
    getUserById: (userId, projection) => methods.getUserById(userId, projection),
    findSession: (query, options) => methods.findSession(query, options),
    generateRefreshToken: (session) => methods.generateRefreshToken(session as ISession),
    generateToken: (user, expiresIn) => methods.generateToken(user as IUser, expiresIn),
    setAuthTokens,
    setCloudFrontAuthCookies: jest.fn(),
    deleteSession: (query) => methods.deleteSession(query),
    deleteAllUserSessions: (query) => methods.deleteAllUserSessions(query),
    clearCloudFrontCookies: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    ...overrides,
  };
}

/** One tab's refresh, sent with whatever refresh cookie the browser held when the tab sent it. */
async function refresh(deps: Deps, refreshToken: string): Promise<Sent> {
  const sent: Sent = { cookies: {} };
  const res = {
    status: (code: number) => ((sent.status = code), res),
    send: (body: unknown) => ((sent.body = body), res),
    redirect: () => res,
    cookie: (name: string, value: string) => ((sent.cookies[name] = value), res),
    clearCookie: (name: string) => ((sent.cookies[name] = null), res),
  };
  await createLocalRefreshHandler(deps)(
    { query: {} } as unknown as Request,
    res as unknown as Response,
    refreshToken,
  );
  return sent;
}

/** The browser keeps one refresh cookie for every tab; each response that sets it replaces it. */
const land = (cookie: string, ...responses: Sent[]) =>
  responses.reduce((current, sent) => sent.cookies.refreshToken ?? current, cookie);

const accessToken = (sent: Sent) => (sent.body as { token?: unknown } | undefined)?.token;

describe('local refresh shared by several tabs', () => {
  it('serves a tab whose refresh carries the token another tab just rotated', async () => {
    const userId = await createUser();
    const { refreshToken: initial } = await methods.createSession(userId);
    const deps = createDeps();

    const first = await refresh(deps, initial);
    const second = await refresh(deps, initial);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const token = accessToken(second);
    expect(jwt.verify(String(token), process.env.JWT_SECRET as string)).toMatchObject({
      id: userId,
    });
    /** Rotating again would leave the browser with whichever of two new tokens landed last. */
    expect(second.cookies).not.toHaveProperty('refreshToken');
    expect(second.cookies).not.toHaveProperty('session_hint');

    const later = await refresh(deps, land(initial, first, second));
    expect(later.status).toBe(200);
    expect(later.cookies.refreshToken).toEqual(expect.any(String));
  });

  it('lets one of two simultaneous refreshes rotate, so the stored token matches the cookie', async () => {
    const userId = await createUser();
    const { refreshToken: initial } = await methods.createSession(userId);
    /** Both refreshes read the session before either rotates it. */
    let reads = 0;
    let release: () => void = () => undefined;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    const deps = createDeps({
      findSession: async (query, options) => {
        const session = await methods.findSession(query, options);
        if (++reads === 2) {
          release();
        }
        await bothRead;
        return session;
      },
    });

    const [a, b] = await Promise.all([refresh(deps, initial), refresh(deps, initial)]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(typeof accessToken(a)).toBe('string');
    expect(typeof accessToken(b)).toBe('string');
    const rotations = [a, b].filter((sent) => sent.cookies.refreshToken != null);
    expect(rotations).toHaveLength(1);
    expect(deps.setCloudFrontAuthCookies).toHaveBeenCalledTimes(1);
    /** Losing the race is expected, so nothing reports it as a failure. */
    expect(deps.error).not.toHaveBeenCalled();

    /** Whichever response the browser applies last, the cookie it keeps still refreshes. */
    for (const cookie of [land(initial, a, b), land(initial, b, a)]) {
      const stored = await methods.findSession({ userId, refreshToken: cookie }, { lean: true });
      expect(stored).not.toBeNull();
    }
    const later = await refresh(createDeps(), land(initial, b, a));
    expect(later.status).toBe(200);
  });

  it('serves a slow refresh whose token two later refreshes have replaced since', async () => {
    const userId = await createUser();
    const { refreshToken: initial } = await methods.createSession(userId);
    const deps = createDeps();
    const first = await refresh(deps, initial);
    const second = await refresh(deps, land(initial, first));

    const slow = await refresh(deps, initial);

    expect(slow.status).toBe(200);
    expect(slow.cookies).not.toHaveProperty('refreshToken');
    expect((await refresh(deps, land(initial, first, second, slow))).status).toBe(200);
  });

  it('refuses the replaced token once the grace window has passed', async () => {
    const userId = await createUser();
    const { refreshToken: initial } = await methods.createSession(userId);
    const deps = createDeps();
    const first = await refresh(deps, initial);
    await mongoose.models.Session.updateOne(
      { user: userId },
      { $set: { 'previousRefreshTokens.$[].rotatedAt': new Date(Date.now() - 61_000) } },
    );

    const stale = await refresh(deps, initial);

    expect(stale.status).toBe(401);
    expect(stale.cookies.session_hint).toBeNull();
    expect((await refresh(deps, land(initial, first))).status).toBe(200);
  });

  it('refuses the replaced token at once when REFRESH_TOKEN_GRACE_MS is 0', async () => {
    const original = process.env.REFRESH_TOKEN_GRACE_MS;
    process.env.REFRESH_TOKEN_GRACE_MS = '0';
    try {
      const userId = await createUser();
      const { refreshToken: initial } = await methods.createSession(userId);
      const deps = createDeps();
      const first = await refresh(deps, initial);

      expect((await refresh(deps, initial)).status).toBe(401);
      expect((await refresh(deps, land(initial, first))).status).toBe(200);
    } finally {
      if (original === undefined) {
        delete process.env.REFRESH_TOKEN_GRACE_MS;
      } else {
        process.env.REFRESH_TOKEN_GRACE_MS = original;
      }
    }
  });

  it('refuses the replaced token after the session was revoked', async () => {
    const userId = await createUser();
    const { refreshToken: initial } = await methods.createSession(userId);
    const deps = createDeps();
    await refresh(deps, initial);
    await methods.deleteAllUserSessions({ userId });

    expect((await refresh(deps, initial)).status).toBe(401);
  });

  it('refuses a replaced token whose session is revoked after the lookup', async () => {
    const userId = await createUser();
    const { refreshToken: initial } = await methods.createSession(userId);
    await refresh(createDeps(), initial);
    let reads = 0;
    const deps = createDeps({
      findSession: async (query, options) => {
        const session = await methods.findSession(query, options);
        if (++reads === 1) {
          await methods.deleteAllUserSessions({ userId });
        }
        return session;
      },
    });

    const sent = await refresh(deps, initial);

    expect(sent.status).toBe(401);
    expect(accessToken(sent)).toBeUndefined();
  });

  it('refuses a refresh that lost the rotation to a revocation', async () => {
    const userId = await createUser();
    const { refreshToken: initial } = await methods.createSession(userId);
    const deps = createDeps({
      generateRefreshToken: async (session) => {
        await methods.deleteAllUserSessions({ userId });
        return methods.generateRefreshToken(session as ISession);
      },
    });

    const sent = await refresh(deps, initial);

    expect(sent.status).toBe(401);
    expect(sent.cookies).not.toHaveProperty('refreshToken');
    expect(await mongoose.models.Session.countDocuments({ user: userId })).toBe(0);
  });
});
