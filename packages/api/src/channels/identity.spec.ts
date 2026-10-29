import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createModels,
  createChannelIdentityStorage,
  runAsSystem,
  tenantStorage,
} from '@librechat/data-schemas';
import type { ChannelExternalIdentity, ChannelIdentityResult } from 'librechat-data-provider';
import type { ChannelIdentityDependencies } from './identity';
import { createChannelIdentityService } from './identity';

let mongo: MongoMemoryServer;
let clock: number;
let allowed: boolean;
let allowedUsers: Set<string>;
let currentRevision: string;
let service: ReturnType<typeof createChannelIdentityService>;
let dependencies: ChannelIdentityDependencies;
const identity: ChannelExternalIdentity = {
  tenantId: 'tenant-a',
  channelId: 'channel-a',
  channelRevision: 'channel-rev-1',
  teamId: 'T1',
  externalUserId: 'U1',
  agentId: 'agent-a',
};
const principal = { tenantId: 'tenant-a', userId: 'user-a', accountLabel: 'Local account' };

function value<T>(result: ChannelIdentityResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
const scoped = (test: () => Promise<void>) => () =>
  tenantStorage.run({ tenantId: identity.tenantId }, test);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  await mongoose.models.ChannelIdentity.init();
}, 60_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(() => mongoose.models.ChannelIdentity.deleteMany({}));
  clock = 1_000_000;
  allowed = true;
  allowedUsers = new Set([principal.userId]);
  currentRevision = identity.channelRevision;
  dependencies = {
    storage: createChannelIdentityStorage(mongoose),
    channelIsCurrent: async (actor) => actor.channelRevision === currentRevision,
    canUse: async (_actor, userId) => allowed && allowedUsers.has(userId),
    publicBaseUrl: 'http://127.0.0.1:3088',
    ticketLifetimeMs: 60_000,
    linkLifetimeMs: 600_000,
    now: () => clock,
  };
  service = createChannelIdentityService(dependencies);
});

async function accept() {
  const issued = value(await service.issue(identity));
  const secret = new URL(issued.url).hash.slice(1);
  const preview = value(await service.preview(principal, secret));
  const accepted = value(await service.accept(principal, secret, preview.revision));
  return { issued, secret, preview, accepted };
}

it(
  'resolves current configured ticket/link lifetimes at issue and confirmation',
  scoped(async () => {
    const settings = { ticketLifetimeMs: 1000, linkLifetimeMs: 5000 };
    service = createChannelIdentityService({ ...dependencies, getLifetimes: async () => settings });
    const { issued, accepted } = await accept();
    expect(issued.expiresAtMs).toBe(clock + 1000);
    settings.linkLifetimeMs = 500;
    const active = value(await service.confirm(identity, accepted.linkId, accepted.revision));
    expect(active.expiresAtMs).toBe(clock + 500);
    clock += 501;
    expect(await service.resolve(identity, active.revision)).toEqual({
      ok: false,
      error: { code: 'expired' },
    });
  }),
);

it(
  'never resolves actor A permissions for actor B joining the same channel and thread',
  scoped(async () => {
    const actorB = { ...identity, externalUserId: 'U2' };
    const principalB = { ...principal, userId: 'user-b', accountLabel: 'Account B' };
    allowedUsers.add(principalB.userId);
    const { accepted } = await accept();
    const linkA = value(await service.confirm(identity, accepted.linkId, accepted.revision));
    expect(await service.resolve(actorB)).toEqual({ ok: false, error: { code: 'changed' } });
    expect(await service.confirm(actorB, linkA.linkId, linkA.revision)).toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
    const ticketB = value(await service.issue(actorB));
    const secretB = new URL(ticketB.url).hash.slice(1);
    const pendingB = value(await service.preview(principalB, secretB));
    const acceptedB = value(await service.accept(principalB, secretB, pendingB.revision));
    const linkB = value(await service.confirm(actorB, acceptedB.linkId, acceptedB.revision));
    expect(value(await service.resolve(actorB))).toMatchObject({ userId: 'user-b' });
    expect(value(await service.resolve(identity))).toMatchObject({ userId: 'user-a' });
    expect(linkB.linkId).not.toBe(linkA.linkId);
    expect(await service.resolve(actorB, linkA.revision)).toEqual({
      ok: false,
      error: { code: 'changed' },
    });
    expect(await service.revoke(principalB, linkA.linkId, linkA.revision)).toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
  }),
);

it(
  'a forwarded A ticket accepted by account B cannot be confirmed by Slack actor B',
  scoped(async () => {
    const actorB = { ...identity, externalUserId: 'U2' };
    const principalB = { ...principal, userId: 'user-b', accountLabel: 'Account B' };
    allowedUsers.add(principalB.userId);
    const issued = value(await service.issue(identity));
    const secret = new URL(issued.url).hash.slice(1);
    const pending = value(await service.preview(principalB, secret));
    const accepted = value(await service.accept(principalB, secret, pending.revision));
    expect(await service.confirm(actorB, accepted.linkId, accepted.revision)).toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await service.resolve(identity)).toEqual({
      ok: false,
      error: { code: 'confirmation_required' },
    });
    expect(await service.resolve(actorB)).toEqual({ ok: false, error: { code: 'changed' } });
    expect(await service.preview(principal, secret)).toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(value(await service.inspectActor(identity))).toMatchObject({
      state: 'accepted',
      accountLabel: 'Account B',
    });
  }),
);

it(
  'requires browser acceptance then matching actor confirmation and never returns a credential',
  scoped(async () => {
    const { secret, accepted } = await accept();
    expect(await service.resolve(identity)).toEqual({
      ok: false,
      error: { code: 'confirmation_required' },
    });
    expect(
      await service.confirm(
        { ...identity, externalUserId: 'U2' },
        accepted.linkId,
        accepted.revision,
      ),
    ).toEqual({ ok: false, error: { code: 'forbidden' } });
    const link = value(await service.confirm(identity, accepted.linkId, accepted.revision));
    expect(value(await service.resolve(identity, link.revision))).toEqual(link);
    expect(JSON.stringify(link)).not.toMatch(/apiKey|accessToken|refreshToken/);
    const stored = await createChannelIdentityStorage(mongoose).readChannelIdentity(identity);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(stored?.ticketHash).toHaveLength(64);
  }),
);

it(
  'allows exactly one concurrent browser acceptance and actor confirmation',
  scoped(async () => {
    const issued = value(await service.issue(identity));
    const secret = new URL(issued.url).hash.slice(1);
    const preview = value(await service.preview(principal, secret));
    const results = await Promise.all([
      service.accept(principal, secret, preview.revision),
      service.accept(principal, secret, preview.revision),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const accepted = value(results.find((result) => result.ok)!);
    const confirmations = await Promise.all([
      service.confirm(identity, accepted.linkId, accepted.revision),
      service.confirm(identity, accepted.linkId, accepted.revision),
    ]);
    expect(confirmations.filter((result) => result.ok)).toHaveLength(1);
    expect(await service.accept(principal, secret, preview.revision)).toEqual({
      ok: false,
      error: { code: 'changed' },
    });
  }),
);

it(
  'expires tickets, prevents cross-tenant claiming, and invalidates superseded tickets',
  scoped(async () => {
    const first = value(await service.issue(identity));
    const secret = new URL(first.url).hash.slice(1);
    const otherTenant = await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
      service.preview({ ...principal, tenantId: 'tenant-b' }, secret),
    );
    expect(otherTenant).toEqual({ ok: false, error: { code: 'invalid_ticket' } });
    await service.issue(identity);
    expect(await service.preview(principal, secret)).toEqual({
      ok: false,
      error: { code: 'invalid_ticket' },
    });
    const latest = value(await service.issue(identity));
    clock += 60_001;
    expect(await service.preview(principal, new URL(latest.url).hash.slice(1))).toEqual({
      ok: false,
      error: { code: 'expired' },
    });
  }),
);

it(
  'revocation and current channel/RBAC changes fence subsequent admission and continuation',
  scoped(async () => {
    const { accepted } = await accept();
    const link = value(await service.confirm(identity, accepted.linkId, accepted.revision));
    allowed = false;
    expect(await service.resolve(identity, link.revision)).toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
    allowed = true;
    currentRevision = 'mode-change';
    expect(await service.resolve(identity, link.revision)).toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
    currentRevision = identity.channelRevision;
    expect(
      await service.revoke({ ...principal, userId: 'other' }, link.linkId, link.revision),
    ).toEqual({ ok: false, error: { code: 'forbidden' } });
    value(await service.revoke(principal, link.linkId, link.revision));
    expect(await service.resolve(identity, link.revision)).toEqual({
      ok: false,
      error: { code: 'revoked' },
    });
    expect((await service.list(principal))[0].state).toBe('revoked');
  }),
);

it(
  'cannot confirm a pending ticket, a changed mode, or an expired accepted ticket',
  scoped(async () => {
    const issued = value(await service.issue(identity));
    const secret = new URL(issued.url).hash.slice(1);
    const pending = value(await service.preview(principal, secret));
    expect(await service.confirm(identity, pending.linkId, pending.revision)).toEqual({
      ok: false,
      error: { code: 'changed' },
    });
    const accepted = value(await service.accept(principal, secret, pending.revision));
    currentRevision = 'other';
    expect(await service.confirm(identity, accepted.linkId, accepted.revision)).toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
    currentRevision = identity.channelRevision;
    clock += 60_001;
    expect(await service.confirm(identity, accepted.linkId, accepted.revision)).toEqual({
      ok: false,
      error: { code: 'expired' },
    });
  }),
);
