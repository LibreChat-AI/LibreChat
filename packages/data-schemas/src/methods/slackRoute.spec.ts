import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { SlackWorkspaceStorage } from './slackWorkspace';
import type { SlackDispatchStorage } from './slackDispatch';
import type { SlackRouteStorage } from './slackRoute';
import type { AgentChannelMethods } from './channel';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { eraseChannelPersistenceForUser } from './channelErasure';
import { createChannelIdentityStorage } from './channelIdentity';
import { createSlackWorkspaceStorage } from './slackWorkspace';
import { withRequiredTransaction } from '~/utils/transactions';
import { createSlackDispatchStorage } from './slackDispatch';
import { createSlackRouteStorage } from './slackRoute';
import { touchChannelAuthority } from './channelScope';
import { createChannelRunStorage } from './channelRun';
import { createAgentChannelMethods } from './channel';
import { closeResponseScopes } from './responseScope';
import { createModels } from '~/models';

describe('workspace routing and live channel authority', () => {
  const db = new mongoose.Mongoose();
  let mongo: MongoMemoryReplSet;
  let installations: SlackWorkspaceStorage;
  let channels: AgentChannelMethods;
  let routes: SlackRouteStorage;
  let dispatch: SlackDispatchStorage;
  let sequence = 0;
  const scoped = <T>(fn: () => Promise<T>, tenantId = 'org-a') =>
    tenantStorage.run({ tenantId }, fn);

  async function install(token = 'encrypted-bot-token') {
    const stateHash = `attempt-${++sequence}`;
    await installations.startInstall({
      stateHash,
      userId: 'admin',
      appId: 'A123',
      clientId: '123.456',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const claim = await installations.claimInstall(stateHash, 'admin', new Date());
    if (!claim) throw new Error('Missing install claim');
    const installed = await installations.completeInstall(
      stateHash,
      claim.callbackId,
      {
        appId: 'A123',
        teamId: 'T123',
        teamName: 'Workspace',
        botUserId: 'U123',
        scopes: [],
        encryptedBotToken: token,
      },
      new Date(),
    );
    if (!installed.ok) throw new Error(installed.code);
    return installed.workspace.workspaceId;
  }
  async function binding(workspaceId: string, channelId = 'binding-a') {
    return channels.createAgentChannel({
      channelId,
      workspaceId,
      agentId: `agent-${channelId}`,
      tenantId: 'org-a',
      createdBy: 'agent-manager',
      type: 'slack',
      status: 'active',
      credentialMode: 'per_user',
      revision: `consent-${channelId}`,
    });
  }
  const assign = (
    workspaceId: string,
    channelId: string,
    externalChannelId?: string,
    expectedRevision?: string,
  ) =>
    routes.assign({ userId: 'admin', workspaceId, channelId, externalChannelId, expectedRevision });

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await db.connect(mongo.getUri(), { autoIndex: false });
    createModels(db);
    installations = createSlackWorkspaceStorage(db);
    channels = createAgentChannelMethods(db);
    routes = createSlackRouteStorage(db);
    dispatch = createSlackDispatchStorage(db);
    await dispatch.ready();
  }, 60_000);
  beforeEach(async () =>
    runAsSystem(async () => {
      for (const name of [
        'AgentChannel',
        'SlackWorkspace',
        'SlackInstall',
        'SlackInstallGeneration',
        'SlackRoute',
        'SlackThreadRoute',
        'ResponseScope',
        'ChannelScope',
        'ChannelIdentity',
        'ChannelRun',
        'ChannelLane',
      ])
        await db.models[name]?.deleteMany({});
    }),
  );
  afterAll(async () => {
    await db.disconnect();
    await mongo?.stop();
  });

  it('prevents workspace bindings from acquiring personal token copies or shared execution identity', async () =>
    scoped(async () => {
      const workspaceId = await install();
      await binding(workspaceId);
      for (const update of [
        { credentialMode: 'shared' as const },
        { encryptedBotToken: 'copied-token' },
        { encryptedSigningSecret: 'copied-secret' },
      ]) {
        await expect(
          channels.updateAgentChannel(
            'binding-a',
            'agent-manager',
            update,
            'active',
            'consent-binding-a',
          ),
        ).rejects.toThrow('installation-owned credentials');
      }
      expect((await channels.getAgentChannel('binding-a'))?.credentialMode).toBe('per_user');
      await installations.disconnect(workspaceId);
      await expect(binding(workspaceId, 'after-disconnect')).rejects.toThrow(
        'installation unavailable',
      );
      expect(await channels.getAgentChannel('after-disconnect')).toBeNull();
      expect((await channels.listAgentChannels('agent-binding-a'))[0].status).toBe('disabled');
    }));

  it('reads current workspace credentials without copying them into the agent binding or metadata', async () =>
    scoped(async () => {
      const workspaceId = await install();
      await binding(workspaceId);
      expect(await channels.getAgentChannel('binding-a')).not.toHaveProperty('encryptedBotToken');
      const metadata = await channels.getAgentChannelMetadata('binding-a');
      expect(metadata?.slack).toEqual({ appId: 'A123', teamId: 'T123', botUserId: 'U123' });
      expect(metadata).not.toHaveProperty('encryptedBotToken');
      expect((await channels.getActiveAgentChannel('binding-a'))?.encryptedBotToken).toBe(
        'encrypted-bot-token',
      );
      expect(await install('replacement-token')).toBe(workspaceId);
      expect((await channels.getActiveAgentChannel('binding-a'))?.encryptedBotToken).toBe(
        'replacement-token',
      );
      expect((await channels.getAgentChannelMetadata('binding-a'))?.revision).toBe(
        'consent-binding-a',
      );
    }));

  it('disconnect immediately removes live authority and reconnect cannot reactivate old bindings', async () =>
    scoped(async () => {
      const workspaceId = await install();
      await binding(workspaceId);
      await installations.disconnect(workspaceId);
      expect(await channels.getActiveAgentChannel('binding-a')).toBeNull();
      expect((await channels.getAgentChannelMetadata('binding-a'))?.status).toBe('disabled');
      expect(await install('new-authorization')).not.toBe(workspaceId);
      expect(await channels.getActiveAgentChannel('binding-a')).toBeNull();
      expect((await channels.getAgentChannel('binding-a'))?.status).toBe('active');
    }));

  it('resolves explicit channel routes before the workspace default and rejects stale replacements', async () =>
    scoped(async () => {
      const workspaceId = await install();
      await binding(workspaceId);
      await binding(workspaceId, 'binding-b');
      const initial = await assign(workspaceId, 'binding-a');
      expect(initial.ok).toBe(true);
      expect((await routes.resolve(workspaceId, 'C123'))?.channelId).toBe('binding-a');
      expect((await assign(workspaceId, 'binding-b', 'C123')).ok).toBe(true);
      expect((await routes.resolve(workspaceId, 'C123'))?.channelId).toBe('binding-b');
      expect(await assign(workspaceId, 'binding-b')).toEqual({ ok: false, code: 'route_changed' });
      if (!initial.ok || !initial.route) throw new Error('Missing initial route');
      expect((await assign(workspaceId, 'binding-b', undefined, initial.route.revision)).ok).toBe(
        true,
      );
      expect((await channels.getAgentChannelMetadata('binding-a'))?.revision).toBe(
        'consent-binding-a',
      );
      expect((await channels.getAgentChannelMetadata('binding-a'))?.status).toBe('active');
    }));

  it('serializes competing initial assignments rather than letting two agents own a default', async () =>
    scoped(async () => {
      const workspaceId = await install();
      await binding(workspaceId);
      await binding(workspaceId, 'binding-b');
      const results = await Promise.all([
        assign(workspaceId, 'binding-a'),
        assign(workspaceId, 'binding-b'),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        { ok: false, code: 'route_changed' },
      ]);
      expect(['binding-a', 'binding-b']).toContain(
        (await routes.resolve(workspaceId, 'D123'))?.channelId,
      );
    }));

  it('never borrows another tenant’s installation credentials or routing configuration', async () => {
    const workspaceId = await scoped(async () => {
      const id = await install();
      await binding(id);
      await assign(id, 'binding-a');
      return id;
    });
    await scoped(async () => {
      expect(await routes.read(workspaceId)).toBeNull();
      expect(await routes.resolve(workspaceId, 'C123')).toBeNull();
      expect(await channels.getActiveAgentChannel('binding-a')).toBeNull();
      expect(await assign(workspaceId, 'binding-a')).toEqual({
        ok: false,
        code: 'workspace_unavailable',
      });
    }, 'org-b');
  });

  it('allows explicit cleanup after disconnect without changing other targets or restoring authority', async () =>
    scoped(async () => {
      const workspaceId = await install();
      await binding(workspaceId);
      const initial = await assign(workspaceId, 'binding-a', 'C123');
      await assign(workspaceId, 'binding-a');
      if (!initial.ok || !initial.route) throw new Error('Missing route');
      await installations.disconnect(workspaceId);
      expect(
        await routes.remove({
          userId: 'admin',
          workspaceId,
          externalChannelId: 'C123',
          expectedRevision: initial.route.revision,
        }),
      ).toEqual({ ok: true, route: null });
      expect(await routes.read(workspaceId, 'C123')).toBeNull();
      expect(await routes.read(workspaceId)).not.toBeNull();
      expect(await channels.getActiveAgentChannel('binding-a')).toBeNull();
    }));

  it('joins identity and run admission to the same workspace disconnect fence', async () =>
    scoped(async () => {
      const workspaceId = await install();
      await binding(workspaceId);
      const authority = {
        tenantId: 'org-a',
        channelId: 'binding-a',
        agentId: 'agent-binding-a',
        channelRevision: 'consent-binding-a',
        teamId: 'T123',
        appId: 'A123',
      };
      const admit = (teamId = 'T123') =>
        withRequiredTransaction(db, (session) =>
          touchChannelAuthority(db, { ...authority, teamId }, session),
        );
      expect(await admit('TOTHER')).toBe(false);
      expect(await admit()).toBe(true);
      await installations.disconnect(workspaceId);
      expect(await admit()).toBe(false);
      await install();
      expect(await admit()).toBe(false);
    }));

  async function linked(
    channelId: string,
    userId = '000000000000000000000010',
    revision = 'link-one',
    previous: string | null = null,
  ) {
    const stored = await createChannelIdentityStorage(db).saveChannelIdentity(
      {
        tenantId: 'org-a',
        linkId: `link-${channelId}`,
        revision,
        state: 'active',
        ticketHash: `hash-${channelId}`,
        ticketExpiresAtMs: Date.now() + 60_000,
        expiresAtMs: Date.now() + 120_000,
        userId,
        identity: {
          tenantId: 'org-a',
          channelId,
          channelRevision: `consent-${channelId}`,
          agentId: `agent-${channelId}`,
          teamId: 'T123',
          externalUserId: 'UACTOR',
        },
      },
      previous,
    );
    if (!stored) throw new Error('Could not seed authorized identity');
    return {
      userId,
      linkId: `link-${channelId}`,
      linkRevision: revision,
      channelRevision: `consent-${channelId}`,
    };
  }
  const event = (eventId: string) => ({
    eventId,
    externalChannelId: 'C123',
    externalThreadKey: 'C123:1.000001',
    externalMessageKey: `C123:${eventId}`,
    actor: { teamId: 'T123', appId: 'A123', externalUserId: 'UACTOR' },
    input: 'Private test input',
  });

  it('pins authorized admission to its original agent when a default changes', async () =>
    scoped(async () => {
      const workspaceId = await install();
      await binding(workspaceId);
      await binding(workspaceId, 'binding-b');
      const first = await linked('binding-a');
      const second = await linked('binding-b');
      const runs = createChannelRunStorage(db);
      await runs.admit(
        {
          tenantId: 'org-a',
          workspaceId,
          channelId: 'binding-a',
          agentId: 'agent-binding-a',
          principal: first,
          admission: event('one'),
        },
        Date.now(),
      );
      await assign(workspaceId, 'binding-b');
      expect((await routes.resolve(workspaceId, 'C123'))?.channelId).toBe('binding-b');
      expect(await dispatch.thread(workspaceId, 'UACTOR', 'C123:1.000001')).toBe('binding-a');
      await expect(
        runs.admit(
          {
            tenantId: 'org-a',
            workspaceId,
            channelId: 'binding-b',
            agentId: 'agent-binding-b',
            principal: second,
            admission: event('two'),
          },
          Date.now(),
        ),
      ).rejects.toMatchObject({ code: 'thread_route_changed' });
    }));

  it('two simultaneous first messages cannot bind one actor thread to different agents', async () =>
    scoped(async () => {
      const workspaceId = await install();
      await binding(workspaceId);
      await binding(workspaceId, 'binding-b');
      const first = await linked('binding-a');
      const second = await linked('binding-b');
      const runs = createChannelRunStorage(db);
      const results = await Promise.allSettled([
        runs.admit(
          {
            tenantId: 'org-a',
            workspaceId,
            channelId: 'binding-a',
            agentId: 'agent-binding-a',
            principal: first,
            admission: event('one'),
          },
          Date.now(),
        ),
        runs.admit(
          {
            tenantId: 'org-a',
            workspaceId,
            channelId: 'binding-b',
            agentId: 'agent-binding-b',
            principal: second,
            admission: event('two'),
          },
          Date.now(),
        ),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected).toMatchObject({
        status: 'rejected',
        reason: { code: 'thread_route_changed' },
      });
      expect(['binding-a', 'binding-b']).toContain(
        await dispatch.thread(workspaceId, 'UACTOR', 'C123:1.000001'),
      );
    }));

  it('discovers only eligible shared work in system scope and keeps leased work out of the next page', async () =>
    scoped(async () => {
      const workspaceId = await install();
      await binding(workspaceId);
      const principal = await linked('binding-a');
      const runs = createChannelRunStorage(db);
      const now = Date.now();
      const admitted = await runs.admit(
        {
          tenantId: 'org-a',
          workspaceId,
          channelId: 'binding-a',
          agentId: 'agent-binding-a',
          principal,
          admission: event('one'),
        },
        now,
      );
      await channels.createAgentChannel({
        channelId: 'manual-binding',
        agentId: 'manual-agent',
        tenantId: 'org-a',
        createdBy: 'agent-manager',
        type: 'slack',
        status: 'active',
        credentialMode: 'shared',
        revision: 'manual-consent',
        slack: { teamId: 'T123', appId: 'A123', botUserId: 'U123' },
      });
      await runs.admit(
        {
          tenantId: 'org-a',
          channelId: 'manual-binding',
          agentId: 'manual-agent',
          principal: { userId: 'agent-manager', channelRevision: 'manual-consent' },
          admission: event('manual'),
        },
        now,
      );
      const page = await runAsSystem(() => dispatch.discover(10, now));
      expect(page).toEqual([{ tenantId: 'org-a', channelId: 'binding-a' }]);
      expect(JSON.stringify(page)).not.toContain('Private test input');
      expect(await dispatch.run(workspaceId, admitted.run.runId)).toBe('binding-a');
      await expect(dispatch.discover(10, now)).rejects.toThrow('system scope');
      await runs.claim('org-a', 'binding-a', 'worker', now, 60_000);
      expect(await runAsSystem(() => dispatch.discover(10, now))).toEqual([]);
      expect(await scoped(() => dispatch.run(workspaceId, admitted.run.runId), 'org-b')).toBeNull();
    }));

  it('account erasure cannot remove a thread adopted by its currently linked principal', async () =>
    scoped(async () => {
      const workspaceId = await install();
      await binding(workspaceId);
      const runs = createChannelRunStorage(db);
      const first = await linked('binding-a');
      await runs.admit(
        {
          tenantId: 'org-a',
          workspaceId,
          channelId: 'binding-a',
          agentId: 'agent-binding-a',
          principal: first,
          admission: event('one'),
        },
        Date.now(),
      );
      const second = await linked('binding-a', '000000000000000000000011', 'link-two', 'link-one');
      const later = await runs.admit(
        {
          tenantId: 'org-a',
          workspaceId,
          channelId: 'binding-a',
          agentId: 'agent-binding-a',
          principal: second,
          admission: event('two'),
        },
        Date.now(),
      );
      const owner = { tenantId: 'org-a', userId: '000000000000000000000010' };
      await closeResponseScopes(db, owner);
      await eraseChannelPersistenceForUser(db, owner);
      expect(await dispatch.thread(workspaceId, 'UACTOR', 'C123:1.000001')).toBe('binding-a');
      expect(await runs.read('org-a', 'binding-a', later.run.runId)).not.toBeNull();
      await closeResponseScopes(db, { ...owner, userId: '000000000000000000000011' });
      await eraseChannelPersistenceForUser(db, { ...owner, userId: '000000000000000000000011' });
      expect(await dispatch.thread(workspaceId, 'UACTOR', 'C123:1.000001')).toBeNull();
    }));
});
