import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ScheduledMCPIdentity, ScheduledMCPEnrollment } from 'librechat-data-provider';
import type { ScheduleMCPConsentStorage } from './scheduleConsent';
import { createScheduleMCPConsentStorage } from './scheduleConsent';
import { createScheduleMethods } from './schedule';
import { createModels } from '../models';

let mongo: MongoMemoryServer;
let storage: ScheduleMCPConsentStorage;
let identity: ScheduledMCPIdentity;
const owner = new mongoose.Types.ObjectId();

function enrollment(
  revision = 'grant-1',
  overrides: Partial<ScheduledMCPEnrollment> = {},
): ScheduledMCPEnrollment {
  return {
    version: 1,
    revision,
    scheduleRevision: 0,
    consents: [
      {
        id: 'consent-1',
        revision,
        identity,
        resource: {
          serverName: 'warehouse',
          url: 'https://warehouse.example/mcp',
          configurationRevision: 'config-1',
          credentialMode: 'resource_bearer',
          issuer: 'https://issuer.example/',
          audience: 'warehouse',
          scopes: ['read'],
        },
        permittedTools: [{ agentId: 'root', tools: ['query'] }],
        policyRevision: 'policy-1',
        grantedAtMs: Date.now() - 1000,
        absoluteExpiresAtMs: Date.now() + 600_000,
        revokedAtMs: null,
      },
    ],
    ...overrides,
  };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  await mongoose.models.Schedule.init();
  storage = createScheduleMCPConsentStorage(mongoose);
}, 60_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
}, 60_000);
beforeEach(async () => {
  await mongoose.models.Schedule.deleteMany({});
  identity = {
    scheduleId: 'schedule-1',
    ownerId: owner.toString(),
    tenantId: 'tenant-1',
    agentId: 'root',
    invocationMode: 'delegated',
  };
  await createScheduleMethods(mongoose).createSchedule({
    id: identity.scheduleId,
    user: owner,
    tenantId: 'tenant-1',
    agent_id: 'root',
    name: 'Digest',
    prompt: 'Read',
    cadence: { frequency: 'hourly', minute: 0, hour: 1 },
    timezone: 'UTC',
    enabled: true,
  });
});

const confirm = (expectedRevision: string | null = null, grant = enrollment()) =>
  storage.confirmScheduleMCPConsent({
    identity,
    expectedConfigRevision: 0,
    expectedRevision,
    enrollment: grant,
  });
const admit = (revision = 'grant-1') =>
  storage.admitScheduleMCPConsent({
    identity,
    revision,
    expectedConfigRevision: 0,
    consentId: 'consent-1',
  });

it('leaves legacy schedules unenrolled and does not change enabled/default scheduling state', async () => {
  expect((await storage.readScheduleMCPConsent(identity))?.enrollment).toBeNull();
  expect(await confirm()).toBe(true);
  const freshStorage = createScheduleMCPConsentStorage(mongoose);
  expect(
    (await freshStorage.readScheduleMCPConsent(identity))?.enrollment?.consents[0].identity.agentId,
  ).toBe('root');
  expect((await freshStorage.readScheduleMCPConsent(identity))?.enabled).toBe(true);
});
it('has one winner among concurrent confirmations', async () => {
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, n) => confirm(null, enrollment(`grant-${n}`))),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
});
it('does not extend the deadline when an admission is recorded', async () => {
  const grant = enrollment();
  await confirm(null, grant);
  expect(await admit()).toBe(true);
  expect(await admit()).toBe(true);
  expect(
    (await storage.readScheduleMCPConsent(identity))?.enrollment?.consents[0].absoluteExpiresAtMs,
  ).toBe(grant.consents[0].absoluteExpiresAtMs);
});
it('rejects expired consent at the storage write boundary', async () => {
  const grant = enrollment();
  grant.consents[0].grantedAtMs = Date.now() - 5000;
  grant.consents[0].absoluteExpiresAtMs = Date.now() - 1000;
  expect(await confirm(null, grant)).toBe(false);
  await confirm();
  await mongoose.models.Schedule.updateOne(
    { id: identity.scheduleId },
    { $set: { 'mcpConsent.consents.0.absoluteExpiresAtMs': Date.now() - 1 } },
  );
  expect(await admit()).toBe(false);
});
it('fences use after revocation and invalidates a confirmation prepared before revocation', async () => {
  await confirm();
  await storage.revokeScheduleMCPConsent(identity, 'grant-1');
  expect(await admit()).toBe(false);
  expect(await confirm('grant-1', enrollment('grant-2'))).toBe(false);
  const row = await storage.readScheduleMCPConsent(identity);
  expect(row?.enrollment?.consents[0].revokedAtMs).not.toBeNull();
  expect(await confirm(row!.enrollment!.revision, enrollment('fresh-grant'))).toBe(true);
});
it('makes revoke/use races linearizable at the atomic admission boundary', async () => {
  await confirm();
  await Promise.all([admit(), storage.revokeScheduleMCPConsent(identity, 'grant-1')]);
  expect(await admit()).toBe(false);
});
it('cannot enroll or use after a root-agent change or config edit', async () => {
  await confirm();
  await mongoose.models.Schedule.updateOne(
    { id: identity.scheduleId },
    { $set: { agent_id: 'other' }, $inc: { configRevision: 1 } },
  );
  expect(await admit()).toBe(false);
  expect(await confirm('grant-1', enrollment('fresh'))).toBe(false);
  expect(await storage.revokeScheduleMCPConsent({ ...identity, agentId: 'other' }, 'grant-1')).toBe(
    true,
  );
});
it('isolates owners and tenants even for an identical schedule id', async () => {
  await confirm();
  for (const wrong of [
    { ...identity, ownerId: new mongoose.Types.ObjectId().toString() },
    { ...identity, tenantId: 'tenant-2' },
    { ...identity, tenantId: null },
  ]) {
    expect(await storage.readScheduleMCPConsent(wrong)).toBeNull();
    expect(await storage.revokeScheduleMCPConsent(wrong, 'grant-1')).toBe(false);
    expect(
      await storage.admitScheduleMCPConsent({
        identity: wrong,
        revision: 'grant-1',
        expectedConfigRevision: 0,
        consentId: 'consent-1',
      }),
    ).toBe(false);
  }
});
it.each(['deleting', 'erased'])('denies grants and admission for %s schedules', async (field) => {
  await confirm();
  await mongoose.models.Schedule.updateOne(
    { id: identity.scheduleId },
    { $set: { [field]: true } },
  );
  expect(await admit()).toBe(false);
  expect(await storage.readScheduleMCPConsent(identity)).toBeNull();
});
it('fails closed on an unknown stored version without overwriting it', async () => {
  await mongoose.models.Schedule.updateOne(
    { id: identity.scheduleId },
    { $set: { mcpConsent: { version: 2, revision: 'future' } } },
  );
  expect((await storage.readScheduleMCPConsent(identity))?.enrollment).toBeNull();
  expect(await confirm()).toBe(false);
  expect(await admit('future')).toBe(false);
});
it('rejects credential-bearing or mismatched records at the persistence boundary', async () => {
  const bad = enrollment();
  bad.consents[0].identity = { ...identity, agentId: 'changed' };
  await expect(confirm(null, bad)).rejects.toThrow('binding');
  const secret = enrollment();
  Object.assign(secret.consents[0].resource, { accessToken: 'do-not-store' });
  await expect(confirm(null, secret)).rejects.toThrow();
});

it('uses only classic update operators for confirmation, revocation and admission', async () => {
  const update = jest.spyOn(mongoose.models.Schedule, 'updateOne');
  await confirm();
  await admit();
  await storage.revokeScheduleMCPConsent(identity, 'grant-1');
  for (const call of update.mock.calls) {
    const [filter, operation] = Array.from(call);
    expect(Array.isArray(operation)).toBe(false);
    expect(JSON.stringify(filter)).not.toContain('$$NOW');
    expect(JSON.stringify(operation)).not.toContain('$$NOW');
    expect(Object.keys(operation!)).toEqual(['$set']);
  }
});
