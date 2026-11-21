import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { AgentKeyMCPIdentity, RunGrant } from 'librechat-data-provider';
import type { RunGrantStorage } from './runGrant';
import { createAgentKeyMCPConsentStorage } from './runGrant';
import { createModels } from '../models';

let mongo: MongoMemoryServer;
let storage: RunGrantStorage<AgentKeyMCPIdentity>;
let identity: AgentKeyMCPIdentity;
const owner = new mongoose.Types.ObjectId();

async function createKey(fields: Record<string, unknown> = {}): Promise<string> {
  const key = await mongoose.models.AgentApiKey.create({
    userId: owner,
    name: `key-${new mongoose.Types.ObjectId().toString()}`,
    keyHash: new mongoose.Types.ObjectId().toString(),
    keyPrefix: 'sk-test',
    tenantId: 'tenant-1',
    ...fields,
  });
  return key._id.toString();
}

function grant(
  subject: AgentKeyMCPIdentity = identity,
  revision = 'grant-1',
): RunGrant<AgentKeyMCPIdentity> {
  return {
    version: 1,
    revision,
    scheduleRevision: 0,
    consents: [
      {
        id: 'consent-1',
        revision,
        identity: subject,
        resource: {
          serverName: 'warehouse',
          url: 'https://warehouse.example/mcp',
          configurationRevision: 'config-1',
          credentialMode: 'stored_oauth',
          issuer: 'https://issuer.example/',
          audience: 'warehouse',
          scopes: ['read'],
        },
        permittedTools: [{ agentId: subject.agentId, tools: ['query'] }],
        policyRevision: 'policy-1',
        grantedAtMs: Date.now() - 1000,
        absoluteExpiresAtMs: Date.now() + 600_000,
        revokedAtMs: null,
      },
    ],
  };
}
const confirm = (
  subject: AgentKeyMCPIdentity = identity,
  expectedRevision: string | null = null,
  revision = 'grant-1',
) =>
  storage.confirmRunGrant({
    identity: subject,
    expectedConfigRevision: 0,
    expectedRevision,
    enrollment: grant(subject, revision),
  });
const admit = (subject: AgentKeyMCPIdentity = identity, revision = 'grant-1') =>
  storage.admitRunGrant({
    identity: subject,
    revision,
    expectedConfigRevision: 0,
    consentId: 'consent-1',
  });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  storage = createAgentKeyMCPConsentStorage(mongoose);
}, 60_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
}, 60_000);
beforeEach(async () => {
  await mongoose.models.AgentApiKey.deleteMany({});
  identity = {
    keyId: await createKey(),
    ownerId: owner.toString(),
    tenantId: 'tenant-1',
    agentId: 'agent_root',
    invocationMode: 'delegated',
  };
});

it('reports a key with no grant for the agent as ungranted, not as missing', async () => {
  expect(await storage.readRunGrant(identity)).toEqual({
    agentId: 'agent_root',
    enabled: true,
    configRevision: 0,
    enrollment: null,
    compatible: true,
  });
  expect(await admit()).toBe(false);
});

it('keeps one grant per agent on the key, each on its own', async () => {
  const other = { ...identity, agentId: 'agent_other' };
  expect(await confirm()).toBe(true);
  expect((await storage.readRunGrant(other))?.enrollment).toBeNull();
  expect(await confirm(other, null, 'grant-2')).toBe(true);
  expect((await storage.readRunGrant(identity))?.enrollment?.revision).toBe('grant-1');
  expect((await storage.readRunGrant(other))?.enrollment?.revision).toBe('grant-2');
  await storage.revokeRunGrant(other, 'grant-2');
  expect(await admit(other, 'grant-2')).toBe(false);
  expect(await admit()).toBe(true);
});

it('has one winner among concurrent grants and replaces only the revision it was shown', async () => {
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, n) => confirm(identity, null, `grant-${n}`)),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  const current = (await storage.readRunGrant(identity))!.enrollment!.revision;
  expect(await confirm(identity, 'stale', 'next')).toBe(false);
  expect(await confirm(identity, current, 'next')).toBe(true);
});

it('stops use after revocation and keeps the record for the owner to see', async () => {
  await confirm();
  expect(await admit()).toBe(true);
  expect(await storage.revokeRunGrant(identity, 'grant-1')).toBe(true);
  expect(await admit()).toBe(false);
  const revoked = (await storage.readRunGrant(identity))!.enrollment!;
  expect(revoked.consents[0].revokedAtMs).not.toBeNull();
  expect(await admit(identity, revoked.revision)).toBe(false);
});

it('pins and flags tools on the grant of the one agent', async () => {
  const other = { ...identity, agentId: 'agent_other' };
  await confirm();
  await confirm(other, null, 'grant-2');
  const pin = { identity, revision: 'grant-1', consentId: 'consent-1', tool: 'query' };
  expect(await storage.pinRunGrantTool({ ...pin, digest: 'a'.repeat(64) })).toBe(true);
  expect(await storage.pinRunGrantTool({ ...pin, digest: 'b'.repeat(64) })).toBe(false);
  expect(await storage.flagRunGrantTool(pin)).toBe(true);
  expect((await storage.readRunGrant(identity))?.enrollment?.consents[0]).toMatchObject({
    definitions: [{ tool: 'query', digest: 'a'.repeat(64) }],
    changedTools: ['query'],
  });
  const untouched = (await storage.readRunGrant(other))!.enrollment!.consents[0];
  expect(untouched.definitions).toBeUndefined();
  expect(untouched.changedTools).toBeUndefined();
});

it.each([
  ['another owner', () => ({ ownerId: new mongoose.Types.ObjectId().toString() })],
  ['another tenant', () => ({ tenantId: 'tenant-2' })],
  ['a key that does not exist', () => ({ keyId: new mongoose.Types.ObjectId().toString() })],
])('finds nothing and writes nothing for %s', async (_case, change) => {
  await confirm();
  const stranger = { ...identity, ...change() };
  expect(await storage.readRunGrant(stranger)).toBeNull();
  expect(await confirm(stranger, null, 'theirs')).toBe(false);
  expect(await admit(stranger)).toBe(false);
  expect(await storage.revokeRunGrant(stranger, 'grant-1')).toBe(false);
  expect((await storage.readRunGrant(identity))?.enrollment?.revision).toBe('grant-1');
});

it.each([
  ['an expired key', { expiresAt: new Date(Date.now() - 1000) }],
  ['a key bound to an integration', { binding: { kind: 'channel', id: 'c1' } }],
])('holds no grant on %s', async (_case, fields) => {
  const subject = { ...identity, keyId: await createKey(fields) };
  expect(await storage.readRunGrant(subject)).toBeNull();
  expect(await confirm(subject)).toBe(false);
});

it('holds the pin fences on the grant of a key as on that of a schedule, one agent at a time', async () => {
  const other = { ...identity, agentId: 'agent_other' };
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const pin = (subject: AgentKeyMCPIdentity, digest: string) =>
    storage.pinRunGrantTool({
      identity: subject,
      revision: 'grant-1',
      consentId: 'consent-1',
      tool: 'query',
      digest,
    });
  const use = (subject: AgentKeyMCPIdentity, digest: string) =>
    storage.admitRunGrant({
      identity: subject,
      revision: 'grant-1',
      expectedConfigRevision: 0,
      consentId: 'consent-1',
      definitions: { query: digest },
    });
  await confirm();
  await confirm(other);
  const unpinned = (await storage.readRunGrant(identity))?.enrollment;
  await pin(identity, first);
  // Admission looks at the pin in the same write, and only at this agent's grant.
  expect(await use(identity, first)).toBe(true);
  expect(await use(identity, second)).toBe(false);
  expect(await use(other, second)).toBe(true);
  // A grant built from the read before the pin would drop it, so it is not written.
  const replace = (basis: typeof unpinned) =>
    storage.confirmRunGrant({
      identity,
      expectedConfigRevision: 0,
      expectedRevision: 'grant-1',
      enrollment: grant(identity, 'grant-2'),
      basis,
    });
  expect(await replace(unpinned)).toBe(false);
  expect(await replace((await storage.readRunGrant(identity))?.enrollment)).toBe(true);
  expect((await storage.readRunGrant(other))?.enrollment?.revision).toBe('grant-1');
});

it('accepts a key with an expiry still ahead', async () => {
  const subject = {
    ...identity,
    keyId: await createKey({ expiresAt: new Date(Date.now() + 60_000) }),
  };
  expect(await confirm(subject)).toBe(true);
  expect(await admit(subject)).toBe(true);
});

it('refuses a grant made out to a different key, owner or agent', async () => {
  for (const change of [
    { keyId: new mongoose.Types.ObjectId().toString() },
    { ownerId: new mongoose.Types.ObjectId().toString() },
    { agentId: 'agent_other' },
  ])
    await expect(
      storage.confirmRunGrant({
        identity,
        expectedConfigRevision: 0,
        expectedRevision: null,
        enrollment: grant({ ...identity, ...change }),
      }),
    ).rejects.toThrow('binding');
  expect((await storage.readRunGrant(identity))?.enrollment).toBeNull();
});

it.each(['agent.other', 'agent$set', '', 'a b'])(
  'never builds a field path from the agent id %p',
  async (agentId) => {
    const subject = { ...identity, agentId };
    await expect(storage.readRunGrant(subject)).rejects.toThrow();
    await expect(admit(subject)).rejects.toThrow();
  },
);

it('fails closed on a stored grant it cannot read', async () => {
  await mongoose.models.AgentApiKey.updateOne(
    { _id: identity.keyId },
    { $set: { 'mcpGrants.agent_root': { version: 2, revision: 'future' } } },
  );
  expect(await storage.readRunGrant(identity)).toMatchObject({
    enrollment: null,
    compatible: false,
  });
  expect(await confirm()).toBe(false);
});

it('uses only classic update operators', async () => {
  const update = jest.spyOn(mongoose.models.AgentApiKey, 'updateOne');
  await confirm();
  await admit();
  await storage.pinRunGrantTool({
    identity,
    revision: 'grant-1',
    consentId: 'consent-1',
    tool: 'query',
    digest: 'a'.repeat(64),
  });
  await storage.revokeRunGrant(identity, 'grant-1');
  expect(update.mock.calls.map((call) => Object.keys(Array.from(call)[1]!))).toEqual([
    ['$set'],
    ['$set'],
    ['$push'],
    ['$set'],
  ]);
  update.mockRestore();
});
