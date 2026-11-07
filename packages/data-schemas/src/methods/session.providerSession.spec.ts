import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ISession } from '~/types';
import { createSessionMethods } from './session';
import sessionSchema from '~/schema/session';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createSessionMethods>;

const providerSession = {
  issuer: 'https://idp.example.com',
  clientId: 'librechat',
  sid: 'sid-session-association',
};

beforeAll(async () => {
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  if (!mongoose.models.Session) {
    mongoose.model<ISession>('Session', sessionSchema);
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  methods = createSessionMethods(mongoose);
});

describe('Session providerSession association', () => {
  it('persists providerSession and authMethod through createSession', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const { session } = await methods.createSession(userId, {
      providerSession,
      authMethod: 'openid',
    });

    const stored = await mongoose.models.Session.findById(session._id).lean<ISession>();
    expect(stored?.providerSession).toEqual(providerSession);
    expect(stored?.authMethod).toBe('openid');
  });

  it('omits providerSession and authMethod from createSession when not supplied', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const { session } = await methods.createSession(userId);

    const stored = await mongoose.models.Session.findById(session._id).lean<ISession>();
    expect(stored?.providerSession).toBeUndefined();
    expect(stored?.authMethod).toBeUndefined();
  });

  it('persists providerSession and authMethod through upsertSession', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const stored = await methods.upsertSession(userId, 'external-refresh-token', {
      expiration: new Date(Date.now() + 60_000),
      providerSession,
      authMethod: 'openid',
    });

    expect(stored.providerSession?.issuer).toBe(providerSession.issuer);
    expect(stored.providerSession?.clientId).toBe(providerSession.clientId);
    expect(stored.providerSession?.sid).toBe(providerSession.sid);
    expect(stored.authMethod).toBe('openid');
  });
});
