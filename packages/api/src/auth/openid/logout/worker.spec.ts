import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createOpenIDAuthorizationMethods,
  resolveAuthorizationQueryOptions,
} from '@librechat/data-schemas';
import type { OpenIDAuthorizationMethods } from '@librechat/data-schemas';
import type { Connection } from 'mongoose';
import type { BackchannelLogoutWorkerMethods } from './worker';
import type { LeaseDeps } from '~/admin/lease';
import { ResourcePermissionsUnavailableError } from '~/acl/accessControlService';
import { createBackchannelLogoutWorker } from './worker';

const ISSUER = 'https://issuer.example';
const CLIENT_ID = 'client-1';
const SUBJECT = 'subject-1';

let mongoServer: MongoMemoryServer;
let connection: Connection;
let authMethods: OpenIDAuthorizationMethods;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(mongoServer.getUri()).asPromise();
}, 30_000);

afterAll(async () => {
  await connection.close();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await connection.dropDatabase();
  authMethods = createOpenIDAuthorizationMethods(
    connection,
    resolveAuthorizationQueryOptions('standalone', { maxTimeMS: 2000 }),
  );
});

function workerMethods(): BackchannelLogoutWorkerMethods {
  return {
    upsertOpenIDSubjectBoundary: authMethods.upsertOpenIDSubjectBoundary,
    recordOpenIDLogout: authMethods.recordOpenIDLogout,
    markOpenIDLogoutEventEnforced: authMethods.markOpenIDLogoutEventEnforced,
    listPendingLogoutEvents: authMethods.listPendingLogoutEvents,
  };
}

function createLogger() {
  return { error: jest.fn(), warn: jest.fn() };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor: condition was never satisfied');
}

function createMutexLease(): LeaseDeps {
  const held = new Set<string>();
  return {
    acquireResourceLock: async ({ key }) => {
      if (held.has(key)) {
        return false;
      }
      held.add(key);
      return true;
    },
    renewResourceLock: async ({ key }) => held.has(key),
    releaseResourceLock: async ({ key }) => {
      held.delete(key);
      return true;
    },
  };
}

describe('createBackchannelLogoutWorker', () => {
  it('finishes step 2 for an event a crash left in received, without a duplicate', async () => {
    await authMethods.recordOpenIDLogoutEvent({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      subject: SUBJECT,
      sid: 'sid-1',
      boundaryIat: 1_000,
      jti: 'jti-crash',
      receivedAt: new Date(),
    });

    const worker = createBackchannelLogoutWorker({
      methods: workerMethods(),
      logger: createLogger(),
      intervalMs: 50,
    });
    worker.start();
    try {
      await waitFor(async () => {
        const event = await authMethods.findOpenIDLogoutEvent({
          issuer: ISSUER,
          clientId: CLIENT_ID,
          jti: 'jti-crash',
        });
        return event?.state === 'enforced';
      });
    } finally {
      worker.stop();
    }

    const subject = await authMethods.findOpenIDSubject({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      subject: SUBJECT,
    });
    expect(subject?.boundaryIat).toBe(1_000);
    const session = await authMethods.findOpenIDSession({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      sid: 'sid-1',
    });
    expect(session?.revokedAt).toBeInstanceOf(Date);

    const pending = await authMethods.listPendingLogoutEvents(10);
    expect(pending).toHaveLength(0);
  });

  it("revokes the session at the event's receivedAt timestamp, not the enforcement time", async () => {
    const receivedAt = new Date('2023-06-15T12:00:00.000Z');
    await authMethods.recordOpenIDLogoutEvent({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      subject: SUBJECT,
      sid: 'sid-receivedat',
      boundaryIat: 1_000,
      jti: 'jti-receivedat',
      receivedAt,
    });

    const worker = createBackchannelLogoutWorker({
      methods: workerMethods(),
      logger: createLogger(),
      intervalMs: 50,
    });
    worker.start();
    try {
      await waitFor(async () => {
        const event = await authMethods.findOpenIDLogoutEvent({
          issuer: ISSUER,
          clientId: CLIENT_ID,
          jti: 'jti-receivedat',
        });
        return event?.state === 'enforced';
      });
    } finally {
      worker.stop();
    }

    const session = await authMethods.findOpenIDSession({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      sid: 'sid-receivedat',
    });
    expect(session?.revokedAt?.toISOString()).toBe(receivedAt.toISOString());
  });

  it('stops polling once stopped', async () => {
    const methods = workerMethods();
    const listSpy = jest.spyOn(methods, 'listPendingLogoutEvents');
    const worker = createBackchannelLogoutWorker({
      methods,
      logger: createLogger(),
      intervalMs: 20,
    });
    worker.start();
    await waitFor(async () => listSpy.mock.calls.length > 0);
    worker.stop();
    const callsAtStop = listSpy.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(listSpy.mock.calls.length).toBe(callsAtStop);
  });

  it('lets only one leased worker enforce a given pass', async () => {
    await authMethods.recordOpenIDLogoutEvent({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      subject: SUBJECT,
      sid: 'sid-shared',
      boundaryIat: 1_000,
      jti: 'jti-shared',
      receivedAt: new Date(),
    });

    const lease = createMutexLease();
    const methodsA = workerMethods();
    const methodsB = workerMethods();
    const upsertSpyA = jest.spyOn(methodsA, 'upsertOpenIDSubjectBoundary');
    const upsertSpyB = jest.spyOn(methodsB, 'upsertOpenIDSubjectBoundary');
    const workerA = createBackchannelLogoutWorker({
      methods: methodsA,
      lease,
      logger: createLogger(),
      intervalMs: 20,
    });
    const workerB = createBackchannelLogoutWorker({
      methods: methodsB,
      lease,
      logger: createLogger(),
      intervalMs: 20,
    });

    workerA.start();
    workerB.start();
    try {
      await waitFor(async () => {
        const event = await authMethods.findOpenIDLogoutEvent({
          issuer: ISSUER,
          clientId: CLIENT_ID,
          jti: 'jti-shared',
        });
        return event?.state === 'enforced';
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      workerA.stop();
      workerB.stop();
    }

    expect(upsertSpyA.mock.calls.length + upsertSpyB.mock.calls.length).toBe(1);
  });

  it('logs a lock-store connection failure at warn, not error', async () => {
    const lease: LeaseDeps = {
      acquireResourceLock: async () => {
        throw new ResourcePermissionsUnavailableError();
      },
      renewResourceLock: async () => true,
      releaseResourceLock: async () => true,
    };
    const logger = createLogger();
    const worker = createBackchannelLogoutWorker({
      methods: workerMethods(),
      lease,
      logger,
      intervalMs: 20,
    });
    worker.start();
    try {
      await waitFor(async () => logger.warn.mock.calls.length > 0);
    } finally {
      worker.stop();
    }
    expect(logger.error).not.toHaveBeenCalled();
  });
});
