import mongoose from 'mongoose';
import assert from 'node:assert';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { CommandStartedEvent } from 'mongodb';
import type { Connection } from 'mongoose';
import type * as t from '~/types';
import { createOpenIDAuthorizationMethods, isOpenIDSessionDenied } from './openidAuthorization';
import { resolveAuthorizationQueryOptions } from '~/utils/mongoEngine';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const issuer = 'https://issuer.example';
const clientId = 'client-1';
const maxTimeMS = 2000;

let replSet: MongoMemoryReplSet;
let connection: Connection;
let methods: ReturnType<typeof createOpenIDAuthorizationMethods>;
let commands: CommandStartedEvent[];

function freshMethods(): ReturnType<typeof createOpenIDAuthorizationMethods> {
  return createOpenIDAuthorizationMethods(
    connection,
    resolveAuthorizationQueryOptions('replicaSet', { maxTimeMS }),
  );
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  connection = await mongoose
    .createConnection(replSet.getUri(), { monitorCommands: true })
    .asPromise();
  commands = [];
  connection.getClient().on('commandStarted', (event: CommandStartedEvent) => {
    commands.push(event);
  });
}, 60_000);

afterAll(async () => {
  await connection.close();
  await replSet?.stop();
});

beforeEach(async () => {
  await connection.dropDatabase();
  methods = freshMethods();
  commands.length = 0;
});

function commandsFor(collectionName: string, commandName: string): CommandStartedEvent[] {
  return commands.filter(
    (event) => event.commandName === commandName && event.command[commandName] === collectionName,
  );
}

describe('authorization engine wire options on a replica set', () => {
  it('sends majority write concern and a wtimeout on every upsert', async () => {
    await methods.upsertOpenIDSubjectBoundary({
      issuer,
      clientId,
      subject: 'subject-wire',
      boundaryIat: 100,
    });
    const writes = commandsFor(connection.models.OpenIDSubject.collection.name, 'findAndModify');
    expect(writes.length).toBeGreaterThan(0);
    for (const event of writes) {
      expect(event.command.writeConcern).toMatchObject({ w: 'majority' });
      expect(event.command.writeConcern.wtimeout).toBe(maxTimeMS);
    }
  });

  it('sends linearizable read concern and maxTimeMS on a unique-document read', async () => {
    await methods.upsertOpenIDSubjectBoundary({
      issuer,
      clientId,
      subject: 'subject-wire-read',
      boundaryIat: 100,
    });
    commands.length = 0;
    await methods.findOpenIDSubject({ issuer, clientId, subject: 'subject-wire-read' });
    const reads = commandsFor(connection.models.OpenIDSubject.collection.name, 'find');
    expect(reads.length).toBeGreaterThan(0);
    for (const event of reads) {
      expect(event.command.readConcern).toMatchObject({ level: 'linearizable' });
      expect(event.command.maxTimeMS).toBe(maxTimeMS);
    }
  });

  it('sends majority write concern and a wtimeout on a session upsert', async () => {
    await methods.recordOpenIDLogin({
      issuer,
      clientId,
      subject: 'subject-wire-session',
      sid: 'sid-wire-session',
      loginIat: 100,
    });
    const writes = commandsFor(connection.models.OpenIDSession.collection.name, 'findAndModify');
    expect(writes.length).toBeGreaterThan(0);
    for (const event of writes) {
      expect(event.command.writeConcern).toMatchObject({ w: 'majority' });
      expect(event.command.writeConcern.wtimeout).toBe(maxTimeMS);
    }
  });

  it('sends linearizable read concern and maxTimeMS on a session read', async () => {
    await methods.recordOpenIDLogin({
      issuer,
      clientId,
      subject: 'subject-wire-session-read',
      sid: 'sid-wire-session-read',
      loginIat: 100,
    });
    commands.length = 0;
    await methods.findOpenIDSession({ issuer, clientId, sid: 'sid-wire-session-read' });
    const reads = commandsFor(connection.models.OpenIDSession.collection.name, 'find');
    expect(reads.length).toBeGreaterThan(0);
    for (const event of reads) {
      expect(event.command.readConcern).toMatchObject({ level: 'linearizable' });
      expect(event.command.maxTimeMS).toBe(maxTimeMS);
    }
  });

  it('sends majority write concern and a wtimeout on a binding upsert', async () => {
    const login = await methods.recordOpenIDLogin({
      issuer,
      clientId,
      subject: 'subject-wire-binding',
      sid: 'sid-wire-binding',
      loginIat: 100,
    });
    assert(login.ok);
    commands.length = 0;
    await methods.upsertOpenIDBinding({
      sessionId: login.session._id,
      user: new mongoose.Types.ObjectId(),
      tenantId: 'tenant-1',
    });
    const writes = commandsFor(connection.models.OpenIDBinding.collection.name, 'findAndModify');
    expect(writes.length).toBeGreaterThan(0);
    for (const event of writes) {
      expect(event.command.writeConcern).toMatchObject({ w: 'majority' });
      expect(event.command.writeConcern.wtimeout).toBe(maxTimeMS);
    }
  });

  it('sends linearizable read concern and maxTimeMS on a binding read', async () => {
    const login = await methods.recordOpenIDLogin({
      issuer,
      clientId,
      subject: 'subject-wire-binding-read',
      sid: 'sid-wire-binding-read',
      loginIat: 100,
    });
    assert(login.ok);
    const user = new mongoose.Types.ObjectId();
    await methods.upsertOpenIDBinding({ sessionId: login.session._id, user, tenantId: 'tenant-1' });
    commands.length = 0;
    await methods.findOpenIDBinding({ sessionId: login.session._id, user, tenantId: 'tenant-1' });
    const reads = commandsFor(connection.models.OpenIDBinding.collection.name, 'find');
    expect(reads.length).toBeGreaterThan(0);
    for (const event of reads) {
      expect(event.command.readConcern).toMatchObject({ level: 'linearizable' });
      expect(event.command.maxTimeMS).toBe(maxTimeMS);
    }
  });

  it('sends majority write concern and a wtimeout on a logout-event upsert', async () => {
    await methods.recordOpenIDLogoutEvent({
      issuer,
      clientId,
      subject: 'subject-wire-event',
      boundaryIat: 100,
      jti: 'jti-wire-event',
      receivedAt: new Date(),
    });
    const writes = commandsFor(connection.models.OpenIDLogout.collection.name, 'findAndModify');
    expect(writes.length).toBeGreaterThan(0);
    for (const event of writes) {
      expect(event.command.writeConcern).toMatchObject({ w: 'majority' });
      expect(event.command.writeConcern.wtimeout).toBe(maxTimeMS);
    }
  });

  it('sends linearizable read concern and maxTimeMS on a logout-event read', async () => {
    await methods.recordOpenIDLogoutEvent({
      issuer,
      clientId,
      subject: 'subject-wire-event-read',
      boundaryIat: 100,
      jti: 'jti-wire-event-read',
      receivedAt: new Date(),
    });
    commands.length = 0;
    await methods.findOpenIDLogoutEvent({ issuer, clientId, jti: 'jti-wire-event-read' });
    const reads = commandsFor(connection.models.OpenIDLogout.collection.name, 'find');
    expect(reads.length).toBeGreaterThan(0);
    for (const event of reads) {
      expect(event.command.readConcern).toMatchObject({ level: 'linearizable' });
      expect(event.command.maxTimeMS).toBe(maxTimeMS);
    }
  });

  it('sends majority, not linearizable, read concern on the pending-logout-events read', async () => {
    await methods.recordOpenIDLogoutEvent({
      issuer,
      clientId,
      subject: 'subject-wire-pending-read',
      boundaryIat: 100,
      jti: 'jti-wire-pending-read',
      receivedAt: new Date(),
    });
    commands.length = 0;
    await methods.listPendingLogoutEvents(10);
    const reads = commandsFor(connection.models.OpenIDLogout.collection.name, 'find');
    expect(reads.length).toBeGreaterThan(0);
    for (const event of reads) {
      expect(event.command.readConcern).toMatchObject({ level: 'majority' });
      expect(event.command.maxTimeMS).toBe(maxTimeMS);
    }
  });
});

describe('concurrent login and logout races', () => {
  it('loses no revocation and raises no false mismatch across 200 fresh login/logout pairs', async () => {
    const pairs = Array.from({ length: 200 }, (_, index) => ({
      sid: `sid-race-${index}`,
      subject: `subject-race-${index}`,
    }));

    const results = await Promise.all(
      pairs.flatMap(({ sid, subject }) => [
        methods.recordOpenIDLogin({ issuer, clientId, subject, sid, loginIat: 100 }),
        methods.recordOpenIDLogout({
          issuer,
          clientId,
          subject,
          sid,
          revokedAt: new Date(200_000),
        }),
      ]),
    );

    const loginResults = results.filter(
      (result, index) => index % 2 === 0,
    ) as t.OpenIDSessionLoginResult[];
    const falseMismatches = loginResults.filter((result) => !result.ok);
    expect(falseMismatches).toHaveLength(0);

    const sessions = await Promise.all(
      pairs.map(({ sid }) => methods.findOpenIDSession({ issuer, clientId, sid })),
    );
    const lostRevocations = sessions.filter((session) => session?.revokedAt == null);
    expect(lostRevocations).toHaveLength(0);
  }, 30_000);

  it('resolves 20 concurrent same-subject logins into a single record', async () => {
    const sid = 'sid-same-subject';
    const subject = 'subject-same';

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        methods.recordOpenIDLogin({ issuer, clientId, subject, sid, loginIat: 100 + index }),
      ),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    const count = await connection.models.OpenIDSession.countDocuments({
      issuer,
      clientId,
      sid,
    });
    expect(count).toBe(1);
  });

  it('keeps the highest boundaryIat across concurrent subject boundary writes', async () => {
    const subject = 'subject-boundary-race';
    const values = [50, 900, 100, 10, 750, 300, 999, 1, 500, 2];

    await Promise.all(
      values.map((boundaryIat) =>
        methods.upsertOpenIDSubjectBoundary({ issuer, clientId, subject, boundaryIat }),
      ),
    );

    const stored = await methods.findOpenIDSubject({ issuer, clientId, subject });
    expect(stored?.boundaryIat).toBe(Math.max(...values));
  });

  it('never throws on concurrent binding upserts for the same key', async () => {
    const login = await methods.recordOpenIDLogin({
      issuer,
      clientId,
      subject: 'subject-binding-race',
      sid: 'sid-binding-race',
      loginIat: 100,
    });
    if (!login.ok) throw new Error('expected login to succeed');
    const user = new mongoose.Types.ObjectId();

    await expect(
      Promise.all(
        Array.from({ length: 20 }, () =>
          methods.upsertOpenIDBinding({ sessionId: login.session._id, user, tenantId: 'tenant-1' }),
        ),
      ),
    ).resolves.toBeDefined();

    const count = await connection.models.OpenIDBinding.countDocuments({
      sessionId: login.session._id,
      user,
      tenantId: 'tenant-1',
    });
    expect(count).toBe(1);
  });
});

describe('no write lifts a denial', () => {
  it('keeps a revoked session denied against every write method', async () => {
    const subject = 'subject-denied-by-revoke';
    const sid = 'sid-denied-by-revoke';
    await methods.recordOpenIDLogin({ issuer, clientId, subject, sid, loginIat: 100 });
    await methods.recordOpenIDLogout({
      issuer,
      clientId,
      subject,
      sid,
      revokedAt: new Date(150_000),
    });

    await methods.recordOpenIDLogin({ issuer, clientId, subject, sid, loginIat: 999 });
    await methods.recordOpenIDLogout({
      issuer,
      clientId,
      subject,
      sid,
      revokedAt: new Date(999_000),
    });
    await methods.upsertOpenIDSubjectBoundary({ issuer, clientId, subject, boundaryIat: 1 });
    const login = await methods.recordOpenIDLogin({ issuer, clientId, subject, sid, loginIat: 50 });
    expect(login.ok).toBe(true);
    assert(login.ok);
    await methods.upsertOpenIDBinding({
      sessionId: login.session._id,
      user: new mongoose.Types.ObjectId(),
      tenantId: 'tenant-1',
    });
    const revoked = await methods.revokeOpenIDSessionById(login.session._id, new Date(2_000_000));
    expect(revoked?.revokedAt?.getTime()).toBe(150_000);

    const session = await methods.findOpenIDSession({ issuer, clientId, sid });
    const boundary = await methods.findOpenIDSubject({ issuer, clientId, subject });
    expect(
      isOpenIDSessionDenied({
        sessionRevokedAt: session?.revokedAt,
        sessionFirstLoginIat: session?.firstLoginIat,
        subjectBoundaryIat: boundary?.boundaryIat,
      }),
    ).toBe(true);
  });

  it('keeps a session denied by a subject boundary against every write method', async () => {
    const subject = 'subject-denied-by-boundary';
    const sid = 'sid-denied-by-boundary';
    await methods.recordOpenIDLogin({ issuer, clientId, subject, sid, loginIat: 100 });
    await methods.upsertOpenIDSubjectBoundary({ issuer, clientId, subject, boundaryIat: 150 });

    await methods.recordOpenIDLogin({ issuer, clientId, subject, sid, loginIat: 500 });
    await methods.upsertOpenIDSubjectBoundary({ issuer, clientId, subject, boundaryIat: 50 });
    const login = await methods.recordOpenIDLogin({ issuer, clientId, subject, sid, loginIat: 50 });
    expect(login.ok).toBe(true);
    assert(login.ok);
    await methods.upsertOpenIDBinding({
      sessionId: login.session._id,
      user: new mongoose.Types.ObjectId(),
      tenantId: 'tenant-1',
    });
    await methods.revokeOpenIDSessionById(login.session._id, new Date(5_000_000));

    const session = await methods.findOpenIDSession({ issuer, clientId, sid });
    const boundary = await methods.findOpenIDSubject({ issuer, clientId, subject });
    expect(session?.firstLoginIat).toBe(50);
    expect(boundary?.boundaryIat).toBe(150);
    expect(
      isOpenIDSessionDenied({
        sessionRevokedAt: session?.revokedAt,
        sessionFirstLoginIat: session?.firstLoginIat,
        subjectBoundaryIat: boundary?.boundaryIat,
      }),
    ).toBe(true);
  });
});

function throwDuplicateKey(): never {
  throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
}

describe('upsert retry on a duplicate-key race', () => {
  it('retries a session login exactly once and returns the upserted session', async () => {
    const spy = jest
      .spyOn(connection.models.OpenIDSession, 'findOneAndUpdate')
      .mockImplementationOnce(throwDuplicateKey);

    const result = await methods.recordOpenIDLogin({
      issuer,
      clientId,
      subject: 'subject-retry-login',
      sid: 'sid-retry-login',
      loginIat: 100,
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it('rejects a racing login under a different subject without a second attempt', async () => {
    const sid = 'sid-retry-mismatch';
    await methods.recordOpenIDLogin({ issuer, clientId, subject: 'subject-a', sid, loginIat: 100 });
    const spy = jest.spyOn(connection.models.OpenIDSession, 'findOneAndUpdate');

    const result = await methods.recordOpenIDLogin({
      issuer,
      clientId,
      subject: 'subject-b',
      sid,
      loginIat: 100,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, error: { code: 'subject_mismatch' } });
  });

  it('retries a session logout exactly once and keeps the revoked timestamp', async () => {
    const spy = jest
      .spyOn(connection.models.OpenIDSession, 'findOneAndUpdate')
      .mockImplementationOnce(throwDuplicateKey);
    const revokedAt = new Date();

    const result = await methods.recordOpenIDLogout({
      issuer,
      clientId,
      subject: 'subject-retry-logout',
      sid: 'sid-retry-logout',
      revokedAt,
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.revokedAt?.getTime()).toBe(revokedAt.getTime());
  });

  it('retries a subject boundary upsert exactly once and returns the stored boundary', async () => {
    const spy = jest
      .spyOn(connection.models.OpenIDSubject, 'findOneAndUpdate')
      .mockImplementationOnce(throwDuplicateKey);

    const result = await methods.upsertOpenIDSubjectBoundary({
      issuer,
      clientId,
      subject: 'subject-retry-boundary',
      boundaryIat: 100,
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.boundaryIat).toBe(100);
  });

  it('retries a binding upsert exactly once and returns the stored binding', async () => {
    const login = await methods.recordOpenIDLogin({
      issuer,
      clientId,
      subject: 'subject-retry-binding',
      sid: 'sid-retry-binding',
      loginIat: 100,
    });
    assert(login.ok);
    const user = new mongoose.Types.ObjectId();
    const spy = jest
      .spyOn(connection.models.OpenIDBinding, 'findOneAndUpdate')
      .mockImplementationOnce(throwDuplicateKey);

    const result = await methods.upsertOpenIDBinding({
      sessionId: login.session._id,
      user,
      tenantId: 'tenant-1',
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.user.toString()).toBe(user.toString());
  });

  it('retries a logout-event upsert exactly once and reports it as created', async () => {
    const spy = jest
      .spyOn(connection.models.OpenIDLogout, 'findOneAndUpdate')
      .mockImplementationOnce(throwDuplicateKey);

    const result = await methods.recordOpenIDLogoutEvent({
      issuer,
      clientId,
      subject: 'subject-retry-event',
      boundaryIat: 100,
      jti: 'jti-retry-event',
      receivedAt: new Date(),
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.created).toBe(true);
  });
});
