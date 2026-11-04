import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Connection } from 'mongoose';
import { createOpenIDAuthorizationMethods, isOpenIDSessionDenied } from './openidAuthorization';
import { resolveAuthorizationQueryOptions } from '~/utils/mongoEngine';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const issuer = 'https://issuer.example';
const clientId = 'client-1';
const subject = 'subject-1';

let mongoServer: MongoMemoryServer;
let connection: Connection;
let methods: ReturnType<typeof createOpenIDAuthorizationMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(mongoServer.getUri()).asPromise();
});

afterAll(async () => {
  await connection.close();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await connection.dropDatabase();
  methods = createOpenIDAuthorizationMethods(
    connection,
    resolveAuthorizationQueryOptions('standalone', { maxTimeMS: 2000 }),
  );
});

describe('OpenID authorization methods', () => {
  it('creates the unique keys before the first write to each collection', async () => {
    await methods.upsertOpenIDSubjectBoundary({ issuer, clientId, subject, boundaryIat: 100 });
    await methods.recordOpenIDLogin({ issuer, clientId, subject, sid: 'sid-index', loginIat: 100 });
    await methods.recordOpenIDLogoutEvent({
      issuer,
      clientId,
      subject,
      boundaryIat: 100,
      jti: 'jti-index',
      receivedAt: new Date(),
    });

    await expect(connection.models.OpenIDSubject.listIndexes()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { issuer: 1, clientId: 1, subject: 1 }, unique: true }),
      ]),
    );
    await expect(connection.models.OpenIDSession.listIndexes()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { issuer: 1, clientId: 1, sid: 1 }, unique: true }),
      ]),
    );
    await expect(connection.models.OpenIDLogout.listIndexes()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { issuer: 1, clientId: 1, jti: 1 }, unique: true }),
      ]),
    );
  });

  it('raises the boundary but never lowers it', async () => {
    await methods.upsertOpenIDSubjectBoundary({ issuer, clientId, subject, boundaryIat: 100 });
    await methods.upsertOpenIDSubjectBoundary({ issuer, clientId, subject, boundaryIat: 50 });

    const unchanged = await methods.findOpenIDSubject({ issuer, clientId, subject });
    expect(unchanged?.boundaryIat).toBe(100);

    await methods.upsertOpenIDSubjectBoundary({ issuer, clientId, subject, boundaryIat: 150 });
    const raised = await methods.findOpenIDSubject({ issuer, clientId, subject });
    expect(raised?.boundaryIat).toBe(150);
  });

  it('keeps the earliest firstLoginIat across repeated logins for the same session', async () => {
    const base = { issuer, clientId, subject, sid: 'sid-login' };
    await methods.recordOpenIDLogin({ ...base, loginIat: 200 });
    await methods.recordOpenIDLogin({ ...base, loginIat: 100 });
    const result = await methods.recordOpenIDLogin({ ...base, loginIat: 300 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.firstLoginIat).toBe(100);
    }
  });

  it('rejects a login for an existing sid under a different subject', async () => {
    const sid = 'sid-shared';
    await methods.recordOpenIDLogin({ issuer, clientId, subject: 'subject-a', sid, loginIat: 100 });
    const result = await methods.recordOpenIDLogin({
      issuer,
      clientId,
      subject: 'subject-b',
      sid,
      loginIat: 100,
    });

    expect(result).toEqual({ ok: false, error: { code: 'subject_mismatch' } });
  });

  it('revokes a session on logout and never clears revokedAt afterward', async () => {
    const base = { issuer, clientId, subject, sid: 'sid-logout' };
    await methods.recordOpenIDLogin({ ...base, loginIat: 100 });
    const revokedAt = new Date();
    await methods.recordOpenIDLogout({ ...base, revokedAt });

    const afterLogout = await methods.findOpenIDSession({ issuer, clientId, sid: base.sid });
    expect(afterLogout?.revokedAt?.getTime()).toBe(revokedAt.getTime());

    await methods.recordOpenIDLogin({ ...base, loginIat: 50 });
    const stillRevoked = await methods.findOpenIDSession({ issuer, clientId, sid: base.sid });
    expect(stillRevoked?.revokedAt?.getTime()).toBe(revokedAt.getTime());
  });

  it('does not move revokedAt forward on a repeated logout for the same sid', async () => {
    const base = { issuer, clientId, subject, sid: 'sid-repeat-logout' };
    const firstRevokedAt = new Date();
    const first = await methods.recordOpenIDLogout({ ...base, revokedAt: firstRevokedAt });
    expect(first.revokedAt?.getTime()).toBe(firstRevokedAt.getTime());

    const second = await methods.recordOpenIDLogout({
      ...base,
      revokedAt: new Date(firstRevokedAt.getTime() + 60000),
    });
    expect(second.revokedAt?.getTime()).toBe(firstRevokedAt.getTime());
  });

  it('upserts a revoked record on logout-with-sid when no session was recorded', async () => {
    const sid = 'sid-never-logged-in';
    const revokedAt = new Date();
    await methods.recordOpenIDLogout({ issuer, clientId, subject, sid, revokedAt });

    const session = await methods.findOpenIDSession({ issuer, clientId, sid });
    expect(session?.revokedAt?.getTime()).toBe(revokedAt.getTime());
    expect(session?.firstLoginIat).toBeUndefined();
  });

  it('enforces the unique binding key, finds the binding by its compound key, and denormalizes the session identity onto it', async () => {
    const login = await methods.recordOpenIDLogin({
      issuer,
      clientId,
      subject,
      sid: 'sid-binding',
      loginIat: 100,
    });
    if (!login.ok) throw new Error('expected login to succeed');
    const user = new mongoose.Types.ObjectId();

    await methods.upsertOpenIDBinding({ sessionId: login.session._id, user, tenantId: 'tenant-1' });
    await methods.upsertOpenIDBinding({ sessionId: login.session._id, user, tenantId: 'tenant-1' });

    const binding = await methods.findOpenIDBinding({
      sessionId: login.session._id,
      user,
      tenantId: 'tenant-1',
    });
    expect(binding).not.toBeNull();
    expect(binding?.issuer).toBe(issuer);
    expect(binding?.clientId).toBe(clientId);
    expect(binding?.sid).toBe('sid-binding');
    const indexes = await connection.models.OpenIDBinding.listIndexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { sessionId: 1, user: 1, tenantId: 1 }, unique: true }),
      ]),
    );
  });

  it('resolves a binding directly by sid, in parallel with the session read', async () => {
    const login = await methods.recordOpenIDLogin({
      issuer,
      clientId,
      subject,
      sid: 'sid-by-sid',
      loginIat: 100,
    });
    if (!login.ok) throw new Error('expected login to succeed');
    const user = new mongoose.Types.ObjectId();
    await methods.upsertOpenIDBinding({ sessionId: login.session._id, user, tenantId: 'tenant-1' });

    const binding = await methods.findOpenIDBindingBySid({
      issuer,
      clientId,
      sid: 'sid-by-sid',
      user,
      tenantId: 'tenant-1',
    });
    expect(binding).not.toBeNull();
    expect(binding?.sessionId.toString()).toBe(login.session._id.toString());

    const missing = await methods.findOpenIDBindingBySid({
      issuer,
      clientId,
      sid: 'sid-by-sid',
      user,
      tenantId: 'other-tenant',
    });
    expect(missing).toBeNull();
  });

  it('treats an absent, null and empty tenantId as the same stored binding', async () => {
    const login = await methods.recordOpenIDLogin({
      issuer,
      clientId,
      subject,
      sid: 'sid-tenant-sentinel',
      loginIat: 100,
    });
    if (!login.ok) throw new Error('expected login to succeed');
    const user = new mongoose.Types.ObjectId();

    await methods.upsertOpenIDBinding({ sessionId: login.session._id, user });
    await methods.upsertOpenIDBinding({ sessionId: login.session._id, user, tenantId: null });
    await methods.upsertOpenIDBinding({ sessionId: login.session._id, user, tenantId: '' });

    const byUndefined = await methods.findOpenIDBinding({ sessionId: login.session._id, user });
    const byNull = await methods.findOpenIDBinding({
      sessionId: login.session._id,
      user,
      tenantId: null,
    });
    const byEmpty = await methods.findOpenIDBinding({
      sessionId: login.session._id,
      user,
      tenantId: '',
    });
    expect(byUndefined?._id.toString()).toBe(byNull?._id.toString());
    expect(byNull?._id.toString()).toBe(byEmpty?._id.toString());
    expect(byUndefined?.tenantId).toBeNull();

    const count = await connection.models.OpenIDBinding.countDocuments({
      sessionId: login.session._id,
      user,
    });
    expect(count).toBe(1);
  });

  it('normalizes an issuer with a trailing slash to the same record as the bare issuer', async () => {
    const trailingSlashIssuer = `${issuer}/`;
    await methods.upsertOpenIDSubjectBoundary({
      issuer: trailingSlashIssuer,
      clientId,
      subject,
      boundaryIat: 100,
    });
    const bare = await methods.findOpenIDSubject({ issuer, clientId, subject });
    const slashed = await methods.findOpenIDSubject({
      issuer: trailingSlashIssuer,
      clientId,
      subject,
    });
    expect(bare?.boundaryIat).toBe(100);
    expect(slashed?.boundaryIat).toBe(100);

    const count = await connection.models.OpenIDSubject.countDocuments({
      issuer,
      clientId,
      subject,
    });
    expect(count).toBe(1);

    const login = await methods.recordOpenIDLogin({
      issuer: trailingSlashIssuer,
      clientId,
      subject,
      sid: 'sid-trailing-slash',
      loginIat: 100,
    });
    expect(login.ok).toBe(true);
    const session = await methods.findOpenIDSession({
      issuer,
      clientId,
      sid: 'sid-trailing-slash',
    });
    expect(session?.issuer).toBe(issuer);
  });

  it('dedupes a repeated logout event by jti and keeps the first boundaryIat', async () => {
    const first = await methods.recordOpenIDLogoutEvent({
      issuer,
      clientId,
      subject,
      sid: 'sid-event',
      boundaryIat: 100,
      jti: 'jti-dedupe',
      receivedAt: new Date(),
    });
    expect(first.created).toBe(true);

    const duplicate = await methods.recordOpenIDLogoutEvent({
      issuer,
      clientId,
      subject,
      sid: 'sid-event',
      boundaryIat: 999,
      jti: 'jti-dedupe',
      receivedAt: new Date(),
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.event.boundaryIat).toBe(100);
  });

  it('marks a logout event enforced exactly once', async () => {
    await methods.recordOpenIDLogoutEvent({
      issuer,
      clientId,
      subject,
      boundaryIat: 100,
      jti: 'jti-enforce',
      receivedAt: new Date(),
    });

    const enforced = await methods.markOpenIDLogoutEventEnforced({
      issuer,
      clientId,
      jti: 'jti-enforce',
    });
    expect(enforced?.state).toBe('enforced');

    const again = await methods.markOpenIDLogoutEventEnforced({
      issuer,
      clientId,
      jti: 'jti-enforce',
    });
    expect(again).toBeNull();

    const found = await methods.findOpenIDLogoutEvent({ issuer, clientId, jti: 'jti-enforce' });
    expect(found?.state).toBe('enforced');
  });

  it('sets expiresAt only once the logout event is enforced', async () => {
    await methods.recordOpenIDLogoutEvent({
      issuer,
      clientId,
      subject,
      boundaryIat: 100,
      jti: 'jti-expiry',
      receivedAt: new Date(),
    });
    const received = await methods.findOpenIDLogoutEvent({ issuer, clientId, jti: 'jti-expiry' });
    expect(received?.expiresAt).toBeUndefined();

    const expiresAt = new Date('2030-01-01T00:00:00Z');
    const enforced = await methods.markOpenIDLogoutEventEnforced({
      issuer,
      clientId,
      jti: 'jti-expiry',
      expiresAt,
    });
    expect(enforced?.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
  });

  it('creates a TTL index on expiresAt', async () => {
    await methods.recordOpenIDLogoutEvent({
      issuer,
      clientId,
      subject,
      boundaryIat: 100,
      jti: 'jti-ttl-index',
      receivedAt: new Date(),
    });
    await expect(connection.models.OpenIDLogout.listIndexes()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
      ]),
    );
  });

  it('lists only received events, oldest receivedAt first, up to the limit', async () => {
    const base = new Date('2024-01-01T00:00:00Z').getTime();
    await methods.recordOpenIDLogoutEvent({
      issuer,
      clientId,
      subject,
      boundaryIat: 100,
      jti: 'jti-pending-2',
      receivedAt: new Date(base + 2000),
    });
    await methods.recordOpenIDLogoutEvent({
      issuer,
      clientId,
      subject,
      boundaryIat: 100,
      jti: 'jti-pending-1',
      receivedAt: new Date(base + 1000),
    });
    await methods.recordOpenIDLogoutEvent({
      issuer,
      clientId,
      subject,
      boundaryIat: 100,
      jti: 'jti-pending-3',
      receivedAt: new Date(base + 3000),
    });
    await methods.recordOpenIDLogoutEvent({
      issuer,
      clientId,
      subject,
      boundaryIat: 100,
      jti: 'jti-already-enforced',
      receivedAt: new Date(base),
    });
    await methods.markOpenIDLogoutEventEnforced({ issuer, clientId, jti: 'jti-already-enforced' });

    const pending = await methods.listPendingLogoutEvents(10);
    expect(pending.map((event) => event.jti)).toEqual([
      'jti-pending-1',
      'jti-pending-2',
      'jti-pending-3',
    ]);
    expect(pending.every((event) => event.state === 'received')).toBe(true);

    const limited = await methods.listPendingLogoutEvents(2);
    expect(limited.map((event) => event.jti)).toEqual(['jti-pending-1', 'jti-pending-2']);
  });
});

describe('isOpenIDSessionDenied', () => {
  it('denies once the session is revoked', () => {
    expect(isOpenIDSessionDenied({ sessionRevokedAt: new Date() })).toBe(true);
  });

  it('allows when no boundary has ever been recorded', () => {
    expect(isOpenIDSessionDenied({ sessionFirstLoginIat: 100 })).toBe(false);
  });

  it('denies a session with no recorded login once a boundary exists', () => {
    expect(isOpenIDSessionDenied({ subjectBoundaryIat: 100 })).toBe(true);
  });

  it('denies on a tie between the boundary and the first login', () => {
    expect(isOpenIDSessionDenied({ subjectBoundaryIat: 100, sessionFirstLoginIat: 100 })).toBe(
      true,
    );
  });

  it('allows a session that logged in after the boundary', () => {
    expect(isOpenIDSessionDenied({ subjectBoundaryIat: 100, sessionFirstLoginIat: 101 })).toBe(
      false,
    );
  });
});
