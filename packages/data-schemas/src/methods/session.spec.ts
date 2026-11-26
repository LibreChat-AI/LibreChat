import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { SessionMethods } from './session';
import { resetTenantStrictCache } from '~/tenant/policy';
import { tenantStorage } from '~/config/tenantContext';
import { createSessionModel } from '~/models/session';
import { createSessionMethods } from './session';
import { hashToken } from '~/crypto';

jest.mock('~/config/winston', () => ({ error: jest.fn(), warn: jest.fn(), debug: jest.fn() }));

const user = '0123456789abcdef01234567';
describe('Mongo plain sessions', () => {
  let server: MongoMemoryServer;
  let methods: SessionMethods;
  beforeAll(async () => {
    server = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
    await mongoose.connect(server.getUri());
    createSessionModel(mongoose);
    methods = createSessionMethods(mongoose, { signPayload: async () => randomUUID() });
  });
  beforeEach(async () => {
    await mongoose.models.Session.deleteMany({});
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
    resetTenantStrictCache();
  });

  it('creates once and always returns string identifiers without document methods', async () => {
    const { session, refreshToken } = await methods.createSession(user);
    expect(session).toMatchObject({
      _id: expect.stringMatching(/^[a-f\d]{24}$/),
      user,
      refreshTokenHash: await hashToken(refreshToken),
      expiration: expect.any(Date),
    });
    expect(session).not.toHaveProperty('save');
    const found = await methods.findSession({ refreshToken }, { lean: false });
    expect(found).toEqual(session);
    expect(found).not.toHaveProperty('save');
    expect(await mongoose.models.Session.countDocuments()).toBe(1);
  });

  it('upserts external sessions as plain records', async () => {
    const expiration = new Date(Date.now() + 60_000);
    const session = await methods.upsertSession(user, 'external', { expiration });
    expect(session.user).toBe(user);
    expect(session).not.toHaveProperty('save');
    expect(await methods.upsertSession(user, 'external', { expiration })).toEqual(session);
  });

  it('atomically rotates only the observed hash and rejects the losing rotation', async () => {
    const { session } = await methods.createSession(user);
    const results = await Promise.allSettled([
      methods.generateRefreshToken({ ...session }),
      methods.generateRefreshToken({ ...session }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await methods.findSession({ sessionId: session._id })).not.toMatchObject({
      refreshTokenHash: session.refreshTokenHash,
    });
  });

  it('never resurrects a session deleted between lookup and rotation', async () => {
    const { session } = await methods.createSession(user);
    await methods.deleteSession({ sessionId: session._id });
    await expect(methods.generateRefreshToken(session)).rejects.toMatchObject({
      code: 'GENERATE_TOKEN_FAILED',
    });
    expect(await mongoose.models.Session.countDocuments()).toBe(0);
  });

  it('rejects no-op hash transitions rather than allowing repeated claims', async () => {
    const session = await methods.upsertSession(user, 'unchanged', {
      expiration: new Date(Date.now() + 60_000),
    });
    const rotating = createSessionMethods(mongoose, { signPayload: async () => 'unchanged' });
    await expect(rotating.generateRefreshToken(session)).rejects.toMatchObject({
      code: 'GENERATE_TOKEN_FAILED',
    });
    expect(await methods.findSession({ refreshToken: 'unchanged' })).toEqual(session);
  });

  it('does not rotate or revoke another tenant session', async () => {
    const session = await tenantStorage.run(
      { tenantId: 'a' },
      async () => (await methods.createSession(user)).session,
    );
    await tenantStorage.run({ tenantId: 'b' }, async () => {
      expect(await methods.findSession({ sessionId: session._id })).toBeNull();
      await expect(methods.generateRefreshToken(session)).rejects.toMatchObject({
        code: 'GENERATE_TOKEN_FAILED',
      });
      expect((await methods.deleteAllUserSessions(user)).deletedCount).toBe(0);
    });
  });
});
