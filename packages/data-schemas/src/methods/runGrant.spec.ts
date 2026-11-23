import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ScheduledMCPIdentity, ScheduledMCPEnrollment } from 'librechat-data-provider';
import type { ScheduleMCPConsentStorage } from './runGrant';
import { createScheduleMCPConsentStorage, createAgentKeyMCPConsentStorage } from './runGrant';
import { createScheduleMethods } from './schedule';
import { createModels } from '../models';
import { createMethods } from './index';

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

it('admits a disabled row only for activation, with the same live consent fence', async () => {
  await confirm();
  await mongoose.models.Schedule.updateOne(
    { id: identity.scheduleId },
    { $set: { enabled: false } },
  );
  const input = {
    identity,
    revision: 'grant-1',
    consentId: 'consent-1',
    expectedConfigRevision: 0,
  };
  expect(await storage.admitRunGrant(input)).toBe(false);
  expect(await storage.admitRunGrant({ ...input, requireEnabled: false })).toBe(true);
  await storage.revokeRunGrant(identity, 'grant-1');
  expect(await storage.admitRunGrant({ ...input, requireEnabled: false })).toBe(false);
});

it('carries consent through activation atomically without extending its absolute expiry', async () => {
  await confirm();
  const before = await storage.readRunGrant(identity);
  const methods = createScheduleMethods(mongoose);
  const updated = await methods.updateScheduleById(
    identity.scheduleId,
    owner,
    { enabled: false },
    undefined,
    {
      expectedConfigRevision: 0,
      preserveMCPConsentRevision: 'grant-1',
    },
  );
  expect(updated?.mcpConsent?.scheduleRevision).toBe(1);
  const after = await storage.readRunGrant(identity);
  expect(after?.enrollment?.consents).toEqual(before?.enrollment?.consents);
  expect(after?.configRevision).toBe(1);
  expect(after?.enabled).toBe(false);
  expect(
    await storage.admitRunGrant({
      identity,
      revision: 'grant-1',
      consentId: 'consent-1',
      expectedConfigRevision: 1,
      requireEnabled: false,
    }),
  ).toBe(true);
});

it('replaces the grant with an edit only while it is the grant the new one was decided against', async () => {
  await confirm();
  const methods = createScheduleMethods(mongoose);
  const basis = (await storage.readRunGrant(identity))!.enrollment!;
  const next = (revision: string, scheduleRevision: number) =>
    enrollment(revision, { scheduleRevision });
  const edit = (
    grant: ScheduledMCPEnrollment,
    expectedConfigRevision: number,
    replaces?: ScheduledMCPEnrollment | null,
  ) =>
    methods.updateScheduleById(
      identity.scheduleId,
      owner,
      { prompt: 'Edited', mcpConsent: grant },
      undefined,
      { expectedConfigRevision, ...(replaces !== undefined && { replacesMCPConsent: replaces }) },
    );
  // An edit that writes a grant has to say which one it replaces.
  await expect(edit(next('grant-2', 1), 0)).rejects.toThrow(
    'A grant written with an edit must name the grant it replaces',
  );
  // A run pins a tool between the decision and the write: the pin is not dropped.
  await storage.pinRunGrantTool({
    identity,
    revision: 'grant-1',
    consentId: 'consent-1',
    tool: 'query',
    digest: 'a'.repeat(64),
  });
  expect(await edit(next('grant-2', 1), 0, basis)).toBeNull();
  const pinned = (await storage.readRunGrant(identity))!.enrollment!;
  expect(pinned.consents[0].definitions).toEqual([{ tool: 'query', digest: 'a'.repeat(64) }]);
  // Decided against what is stored now, the edit goes through and carries the new grant.
  const updated = await edit(next('grant-2', 1), 0, pinned);
  expect(updated?.mcpConsent).toMatchObject({ revision: 'grant-2', scheduleRevision: 1 });
  // The owner revokes in another tab: an edit decided before that does not bring it back.
  const stored = (await storage.readRunGrant(identity))!.enrollment!;
  await storage.revokeRunGrant(identity, 'grant-2');
  expect(await edit(next('grant-3', 2), 1, stored)).toBeNull();
  expect(
    (await storage.readRunGrant(identity))!.enrollment!.consents[0].revokedAtMs,
  ).not.toBeNull();
  // Nor does one decided when the schedule had no grant overwrite one made since.
  expect(await edit(next('grant-3', 2), 1, null)).toBeNull();
});

it('tells a completion turn whether its schedule is still there to act for, and whether it holds a grant', async () => {
  const methods = createScheduleMethods(mongoose);
  const state = () => methods.getScheduleMCPCompletionState(identity);
  // No grant, then one: either way there is a schedule for the turn to act for.
  expect(await state()).toEqual({ identity, enrolled: false });
  await confirm();
  expect(await state()).toEqual({ identity, enrolled: true });
  // Revoked is still a grant: the turn runs under it, and is refused its tools by it.
  await storage.revokeRunGrant(identity, 'grant-1');
  expect(await state()).toEqual({ identity, enrolled: true });
  // Moved to another agent, being deleted, or gone: nothing left to act for.
  expect(
    await methods.getScheduleMCPCompletionState({ ...identity, agentId: 'another' }),
  ).toBeNull();
  await mongoose.models.Schedule.updateOne({ id: identity.scheduleId }, { deleting: true });
  expect(await state()).toBeNull();
  await mongoose.models.Schedule.updateOne(
    { id: identity.scheduleId },
    { $unset: { deleting: 1 }, $set: { erased: true } },
  );
  expect(await state()).toBeNull();
  await mongoose.models.Schedule.deleteMany({});
  expect(await state()).toBeNull();
});

it('does not revive stale enrollment through a later enabled-state edit', async () => {
  await confirm();
  const methods = createScheduleMethods(mongoose);
  await methods.updateScheduleById(identity.scheduleId, owner, { prompt: 'Changed' }, undefined, {
    expectedConfigRevision: 0,
  });
  expect(
    await methods.updateScheduleById(identity.scheduleId, owner, { enabled: true }, undefined, {
      expectedConfigRevision: 1,
      preserveMCPConsentRevision: 'grant-1',
    }),
  ).toBeNull();
});

it('never overwrites revocation racing an activation edit or carries consent across prompt edits', async () => {
  await confirm();
  await storage.revokeRunGrant(identity, 'grant-1');
  const methods = createScheduleMethods(mongoose);
  expect(
    await methods.updateScheduleById(identity.scheduleId, owner, { enabled: false }, undefined, {
      expectedConfigRevision: 0,
      preserveMCPConsentRevision: 'grant-1',
    }),
  ).toBeNull();
  await expect(
    methods.updateScheduleById(identity.scheduleId, owner, { prompt: 'Write now' }, undefined, {
      expectedConfigRevision: 0,
      preserveMCPConsentRevision: 'grant-1',
    }),
  ).rejects.toThrow('Consent continuity is limited to activation state');
  expect(
    (await storage.readRunGrant(identity))?.enrollment?.consents[0].revokedAtMs,
  ).not.toBeNull();
});

const confirm = (
  expectedRevision: string | null = null,
  grant = enrollment(),
  basis?: ScheduledMCPEnrollment | null,
) =>
  storage.confirmRunGrant({
    identity,
    expectedConfigRevision: 0,
    expectedRevision,
    enrollment: grant,
    basis,
  });
const admit = (revision = 'grant-1', definitions?: Record<string, string>) =>
  storage.admitRunGrant({
    identity,
    revision,
    expectedConfigRevision: 0,
    consentId: 'consent-1',
    definitions,
  });

it('leaves legacy schedules unenrolled and does not change enabled/default scheduling state', async () => {
  expect((await storage.readRunGrant(identity))?.enrollment).toBeNull();
  expect(await confirm()).toBe(true);
  const freshStorage = createScheduleMCPConsentStorage(mongoose);
  expect(
    (await freshStorage.readRunGrant(identity))?.enrollment?.consents[0].identity.agentId,
  ).toBe('root');
  expect((await freshStorage.readRunGrant(identity))?.enabled).toBe(true);
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
  expect((await storage.readRunGrant(identity))?.enrollment?.consents[0].absoluteExpiresAtMs).toBe(
    grant.consents[0].absoluteExpiresAtMs,
  );
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
  await storage.revokeRunGrant(identity, 'grant-1');
  expect(await admit()).toBe(false);
  expect(await confirm('grant-1', enrollment('grant-2'))).toBe(false);
  const row = await storage.readRunGrant(identity);
  expect(row?.enrollment?.consents[0].revokedAtMs).not.toBeNull();
  expect(await confirm(row!.enrollment!.revision, enrollment('fresh-grant'))).toBe(true);
});
it('makes revoke/use races linearizable at the atomic admission boundary', async () => {
  await confirm();
  await Promise.all([admit(), storage.revokeRunGrant(identity, 'grant-1')]);
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
  expect(await storage.revokeRunGrant({ ...identity, agentId: 'other' }, 'grant-1')).toBe(true);
});
it('isolates owners and tenants even for an identical schedule id', async () => {
  await confirm();
  for (const wrong of [
    { ...identity, ownerId: new mongoose.Types.ObjectId().toString() },
    { ...identity, tenantId: 'tenant-2' },
    { ...identity, tenantId: null },
  ]) {
    expect(await storage.readRunGrant(wrong)).toBeNull();
    expect(await storage.revokeRunGrant(wrong, 'grant-1')).toBe(false);
    expect(
      await storage.admitRunGrant({
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
  expect(await storage.readRunGrant(identity)).toBeNull();
});
it('fails closed on an unknown stored version without overwriting it', async () => {
  await mongoose.models.Schedule.updateOne(
    { id: identity.scheduleId },
    { $set: { mcpConsent: { version: 2, revision: 'future' } } },
  );
  expect((await storage.readRunGrant(identity))?.enrollment).toBeNull();
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

it('keeps the other tools the owner allowed on the grant, through revocation too', async () => {
  const tools = [{ agentId: 'root', tools: ['execute_code', 'web_search'] }];
  expect(await confirm(null, enrollment('grant-1', { tools }))).toBe(true);
  expect((await storage.readRunGrant(identity))?.enrollment?.tools).toEqual(tools);
  await storage.revokeRunGrant(identity, 'grant-1');
  const revoked = await storage.readRunGrant(identity);
  expect(revoked?.compatible).toBe(true);
  expect(revoked?.enrollment?.tools).toEqual(tools);
});

it('holds a grant that allows other tools and no MCP server, with its own lifetime', async () => {
  const tools = [{ agentId: 'root', tools: ['web_search'] }];
  const grant = (revision: string, lifetime: Partial<ScheduledMCPEnrollment> = {}) => ({
    ...enrollment(revision, { tools, ...lifetime }),
    consents: [],
  });
  const live = { grantedAtMs: Date.now() - 1000, absoluteExpiresAtMs: Date.now() + 600_000 };
  // Nothing carries its deadline but the grant itself, so one without it is not a grant.
  await expect(confirm(null, grant('grant-1'))).rejects.toThrow();
  // Already past its deadline: not written.
  expect(
    await confirm(null, grant('grant-1', { ...live, absoluteExpiresAtMs: Date.now() - 1 })),
  ).toBe(false);
  expect(await confirm(null, grant('grant-1', { ...live, revokedAtMs: null }))).toBe(true);
  const stored = await storage.readRunGrant(identity);
  expect(stored).toMatchObject({ compatible: true, enrollment: { consents: [], tools } });

  expect(await storage.revokeRunGrant(identity, 'grant-1')).toBe(true);
  const revoked = (await storage.readRunGrant(identity))?.enrollment;
  expect(revoked?.revokedAtMs).toEqual(expect.any(Number));
  expect(revoked?.tools).toEqual(tools);
});

it('uses only classic update operators for confirmation, revocation and admission', async () => {
  const update = jest.spyOn(mongoose.models.Schedule, 'updateOne');
  await confirm();
  await admit();
  await storage.revokeRunGrant(identity, 'grant-1');
  for (const call of update.mock.calls) {
    const [filter, operation] = Array.from(call);
    expect(Array.isArray(operation)).toBe(false);
    expect(JSON.stringify(filter)).not.toContain('$$NOW');
    expect(JSON.stringify(operation)).not.toContain('$$NOW');
    expect(Object.keys(operation!)).toEqual(['$set']);
  }
});

it('reports the edit mark of a schedule that was never authorized, and keeps it through a grant', async () => {
  expect((await storage.readRunGrant(identity))?.required).toBeUndefined();
  const updated = await createScheduleMethods(mongoose).updateScheduleById(
    identity.scheduleId,
    owner,
    { name: 'Renamed', mcpConsentRequired: true },
    undefined,
    { expectedConfigRevision: 0 },
  );
  expect(updated?.mcpConsentRequired).toBe(true);
  expect(await storage.readRunGrant(identity)).toMatchObject({
    required: true,
    enrollment: null,
    configRevision: 1,
  });
  expect(
    await storage.confirmRunGrant({
      identity,
      expectedConfigRevision: 1,
      expectedRevision: null,
      enrollment: enrollment('grant-1', { scheduleRevision: 1 }),
    }),
  ).toBe(true);
  expect(await storage.readRunGrant(identity)).toMatchObject({
    required: true,
    enrollment: { revision: 'grant-1' },
  });
});

describe('definition pins', () => {
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const pin = (digest = first, tool = 'query', revision = 'grant-1') =>
    storage.pinRunGrantTool({
      identity,
      revision,
      consentId: 'consent-1',
      tool,
      digest,
    });
  const flag = (tool = 'query', revision = 'grant-1') =>
    storage.flagRunGrantTool({ identity, revision, consentId: 'consent-1', tool });
  const stored = async () => (await storage.readRunGrant(identity))?.enrollment;

  it('keeps the first definition a tool was pinned to', async () => {
    await confirm();
    expect(await pin(first)).toBe(true);
    expect(await pin(second)).toBe(false);
    expect(await pin(second, 'list')).toBe(true);
    expect((await stored())?.consents[0].definitions).toEqual([
      { tool: 'query', digest: first },
      { tool: 'list', digest: second },
    ]);
  });

  it('has one winner among concurrent first uses', async () => {
    await confirm();
    const digests = Array.from({ length: 6 }, (_, n) => String(n).repeat(64));
    const results = await Promise.all(digests.map((digest) => pin(digest)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await stored())?.consents[0].definitions).toEqual([
      { tool: 'query', digest: digests[results.indexOf(true)] },
    ]);
  });

  it('marks a pinned tool as changed without rewriting its pin', async () => {
    await confirm();
    expect(await flag()).toBe(false);
    await pin();
    expect(await flag()).toBe(true);
    expect(await flag()).toBe(true);
    expect((await stored())?.consents[0]).toMatchObject({
      definitions: [{ tool: 'query', digest: first }],
      changedTools: ['query'],
    });
    expect((await storage.readRunGrant(identity))?.compatible).toBe(true);
  });

  it('writes nothing to a revoked or replaced grant', async () => {
    await confirm();
    expect(await pin(first, 'query', 'grant-0')).toBe(false);
    expect(await flag('query', 'grant-0')).toBe(false);
    await storage.revokeRunGrant(identity, 'grant-1');
    const revoked = (await stored())!.revision;
    expect(await pin(first, 'query', revoked)).toBe(false);
    expect((await stored())?.consents[0].definitions).toBeUndefined();
  });

  it('rejects a malformed pin before it reaches the record', async () => {
    await confirm();
    await expect(pin('not-a-digest')).rejects.toThrow();
    expect((await stored())?.consents[0].definitions).toBeUndefined();
  });

  it('does not extend the deadline or change the grant revision', async () => {
    const grant = enrollment();
    await confirm(null, grant);
    await pin();
    await flag();
    expect(await stored()).toMatchObject({
      revision: 'grant-1',
      consents: [{ absoluteExpiresAtMs: grant.consents[0].absoluteExpiresAtMs }],
    });
    expect(await admit()).toBe(true);
  });

  it('admits a tool only while it is unmarked and pinned to the definition in use', async () => {
    await confirm();
    expect(await admit('grant-1', { query: first })).toBe(true);
    await pin(first);
    expect(await admit('grant-1', { query: first })).toBe(true);
    expect(await admit('grant-1', { query: second })).toBe(false);
    // A tool with no pin yet, and a use that reads no definition, are not held back by it.
    expect(await admit('grant-1', { list: second })).toBe(true);
    expect(await admit('grant-1', { query: second, list: second })).toBe(false);
    await flag();
    expect(await admit('grant-1', { query: first })).toBe(false);
    expect(await admit('grant-1', { list: second })).toBe(true);
    expect(await admit()).toBe(true);
  });

  it('refuses a confirmation built from a grant that has since gained a pin or a mark', async () => {
    await confirm();
    const unpinned = await stored();
    await pin();
    expect(await confirm('grant-1', enrollment('grant-2'), unpinned)).toBe(false);
    const unmarked = await stored();
    await flag();
    expect(await confirm('grant-1', enrollment('grant-2'), unmarked)).toBe(false);
    expect((await stored())?.revision).toBe('grant-1');
    expect(await confirm('grant-1', enrollment('grant-2'), await stored())).toBe(true);
    expect((await stored())?.revision).toBe('grant-2');
  });

  it('revokes without dropping a pin stored between its read and its write', async () => {
    await confirm();
    const model = mongoose.models.Schedule;
    const write = model.updateOne.bind(model);
    const update = jest
      .spyOn(model, 'updateOne')
      .mockImplementationOnce(((...args: Parameters<typeof write>) =>
        pin().then(() => write(...args))) as typeof model.updateOne);
    expect(await storage.revokeRunGrant(identity, 'grant-1')).toBe(true);
    update.mockRestore();
    expect((await stored())?.consents[0]).toMatchObject({
      revokedAtMs: expect.any(Number),
      definitions: [{ tool: 'query', digest: first }],
    });
  });

  it('uses only classic update operators', async () => {
    await confirm();
    const update = jest.spyOn(mongoose.models.Schedule, 'updateOne');
    await pin();
    await flag();
    expect(update.mock.calls.map((call) => Object.keys(Array.from(call)[1]!))).toEqual([
      ['$push'],
      ['$addToSet'],
    ]);
    update.mockRestore();
  });
});

it('keeps every grant storage out of the shared method bag', () => {
  // Each subject's storage answers to the same names. Spread into the bag, a second one
  // would replace the first, and a schedule's grant would be read from another document.
  const names = Object.keys(storage);
  expect(names).toEqual(Object.keys(createAgentKeyMCPConsentStorage(mongoose)));
  const bag = createMethods(mongoose);
  expect(names.filter((name) => name in bag)).toEqual([]);
});
