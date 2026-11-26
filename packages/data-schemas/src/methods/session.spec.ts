import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ISession } from '~/types';
import { createSessionMethods, REFRESH_TOKEN_ROTATED } from './session';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let methods: ReturnType<typeof createSessionMethods>;

const userId = new mongoose.Types.ObjectId().toString();

beforeAll(async () => {
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'refresh-secret';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  Object.assign(mongoose.models, createModels(mongoose));
  methods = createSessionMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await mongoose.models.Session.deleteMany({});
});

/** Reads the session the way the refresh handler does, then rotates it. */
async function rotate(refreshToken: string): Promise<string> {
  const session = await methods.findSession({ userId, refreshToken }, { lean: false });
  return methods.generateRefreshToken(session as ISession);
}

describe('session rotation', () => {
  it('matches a replaced token only for callers that ask for the grace window', async () => {
    const { refreshToken: initial } = await methods.createSession(userId);
    const current = await rotate(initial);

    expect(await methods.findSession({ userId, refreshToken: initial })).toBeNull();
    expect(
      await methods.findSession({ userId, refreshToken: initial }, { graceMs: 60_000 }),
    ).toMatchObject({ user: new mongoose.Types.ObjectId(userId) });
    expect(
      await methods.findSession({ userId, refreshToken: current }, { graceMs: 60_000 }),
    ).not.toBeNull();
  });

  it('stops matching a replaced token after the window or a further rotation', async () => {
    const { refreshToken: initial } = await methods.createSession(userId);
    const second = await rotate(initial);
    await mongoose.models.Session.updateOne(
      { user: userId },
      { $set: { rotatedAt: new Date(Date.now() - 61_000) } },
    );
    expect(
      await methods.findSession({ userId, refreshToken: initial }, { graceMs: 60_000 }),
    ).toBeNull();

    await rotate(second);
    expect(
      await methods.findSession({ userId, refreshToken: initial }, { graceMs: 60_000 }),
    ).toBeNull();
    expect(
      await methods.findSession({ userId, refreshToken: second }, { graceMs: 60_000 }),
    ).not.toBeNull();
  });

  it('lets only the first of two rotations from the same read replace the token', async () => {
    const { refreshToken: initial } = await methods.createSession(userId);
    const [a, b] = await Promise.all([
      methods.findSession({ userId, refreshToken: initial }, { lean: false }),
      methods.findSession({ userId, refreshToken: initial }, { lean: false }),
    ]);

    const winner = await methods.generateRefreshToken(a as ISession);
    await expect(methods.generateRefreshToken(b as ISession)).rejects.toMatchObject({
      code: REFRESH_TOKEN_ROTATED,
    });

    expect(await methods.findSession({ userId, refreshToken: winner })).not.toBeNull();
    expect(await mongoose.models.Session.countDocuments({ user: userId })).toBe(1);
  });
});
