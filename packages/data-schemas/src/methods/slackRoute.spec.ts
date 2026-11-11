import mongoose from 'mongoose';
import { ResourceType } from 'librechat-data-provider';
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
import { waitForPause } from './test-helpers';
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
  const appCredentials = {
    appId: 'A123',
    clientId: '123.456',
    encryptedClientSecret: 'encrypted-client-secret',
    encryptedSigningSecret: 'encrypted-signing-secret',
  };

  async function install(token = 'encrypted-bot-token', teamId = 'T123', appId = 'A123') {
    const stateHash = `attempt-${++sequence}`;
    await installations.startInstall({
      stateHash,
      userId: 'admin',
      appId,
      clientId: '123.456',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const claim = await installations.claimInstall(stateHash, 'admin', new Date());
    if (!claim) throw new Error('Missing install claim');
    const installed = await installations.completeInstall(
      stateHash,
      claim.callbackId,
      {
        appId,
        teamId,
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
  const assign = async (
    workspaceId: string,
    channelId: string,
    externalChannelId?: string,
    expectedRevision?: string,
  ) => {
    const channel = await channels.getAgentChannel(channelId);
    return routes.assign({
      userId: 'admin',
      isBotAdmin: true,
      workspaceId,
      channelId,
      externalChannelId,
      expectedRevision,
      channelRevision: channel?.revision ?? 'missing',
    });
  };

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
  beforeEach(async () => {
    await runAsSystem(async () => {
      for (const name of [
        'AclEntry',
        'User',
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
    });
    await scoped(async () => {
      if (!(await installations.configureApp(appCredentials, 'admin')))
        throw new Error('Could not register fixture app');
    });
  });
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
      expect((await channels.getActiveAgentChannel('binding-a'))?.encryptedSigningSecret).toBe(
        'encrypted-signing-secret',
      );
      expect(await install('replacement-token')).toBe(workspaceId);
      expect((await channels.getActiveAgentChannel('binding-a'))?.encryptedBotToken).toBe(
        'replacement-token',
      );
      expect((await channels.getAgentChannelMetadata('binding-a'))?.revision).toBe(
        'consent-binding-a',
      );
    }));

  it('uses current organization signing credentials and refuses execution when they are missing', async () =>
    scoped(async () => {
      const workspaceId = await install();
      await binding(workspaceId);
      const app = await installations.app('A123');
      expect(
        await installations.configureApp(
          { ...appCredentials, encryptedSigningSecret: 'replacement-signing-secret' },
          'admin',
          app?.revision,
        ),
      ).not.toBeNull();
      expect(await channels.getActiveAgentChannel('binding-a')).toMatchObject({
        encryptedBotToken: 'encrypted-bot-token',
        encryptedSigningSecret: 'replacement-signing-secret',
      });
      expect(await channels.getAgentChannel('binding-a')).not.toHaveProperty(
        'encryptedSigningSecret',
      );
      await db.models.SlackInstallGeneration.updateOne(
        { partition: 'org-a', appId: 'A123' },
        { $unset: { encryptedSigningSecret: 1 } },
      );
      expect(await channels.getActiveAgentChannel('binding-a')).toBeNull();
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

  const adminId = '000000000000000000000001';
  const managerId = '000000000000000000000002';
  const otherId = '000000000000000000000003';
  async function grantManagers(workspaceId: string, userIds = [managerId]) {
    for (const id of [adminId, managerId, otherId]) {
      await db.models.User.updateOne(
        { _id: id },
        { $setOnInsert: { email: `${id}@example.com`, name: id } },
        { upsert: true },
      );
    }
    const workspace = await installations.metadata(workspaceId);
    if (!workspace) throw new Error('Missing workspace');
    const result = await installations.setBotManagers({
      workspaceId,
      revision: workspace.revision,
      actorId: adminId,
      userIds,
      maxManagers: 50,
    });
    if (!result.ok) throw new Error(result.code);
    return result.revision;
  }

  it('requires explicit management even for an unclaimed destination and permits co-manager replacements', async () =>
    scoped(async () => {
      const workspaceId = await install();
      await binding(workspaceId);
      await binding(workspaceId, 'binding-b');
      const change = {
        userId: managerId,
        workspaceId,
        channelId: 'binding-a',
        channelRevision: 'consent-binding-a',
      };
      expect(await routes.assign(change)).toEqual({ ok: false, code: 'bot_access_required' });
      await grantManagers(workspaceId, [managerId, otherId]);
      const first = await routes.assign(change);
      if (!first.ok || !first.route) throw new Error('Missing managed route');
      expect(
        (
          await routes.assign({
            ...change,
            userId: otherId,
            channelId: 'binding-b',
            channelRevision: 'consent-binding-b',
            expectedRevision: first.route.revision,
          })
        ).ok,
      ).toBe(true);
      expect(await installations.metadata(workspaceId, managerId)).toMatchObject({
        canManageBot: true,
      });
      expect(await installations.metadata(workspaceId, '000000000000000000000004')).toMatchObject({
        canManageBot: false,
      });
    }));

  it('revokes future assignments while preserving existing authority and permitting removal', async () =>
    scoped(async () => {
      const workspaceId = await install();
      await binding(workspaceId);
      await grantManagers(workspaceId);
      const assigned = await routes.assign({
        workspaceId,
        channelId: 'binding-a',
        channelRevision: 'consent-binding-a',
        userId: managerId,
      });
      if (!assigned.ok || !assigned.route) throw new Error('Missing route');
      await grantManagers(workspaceId, []);
      expect(await channels.getActiveAgentChannel('binding-a')).not.toBeNull();
      expect((await routes.resolve(workspaceId, 'C123'))?.channelId).toBe('binding-a');
      expect(
        await routes.assign({
          workspaceId,
          channelId: 'binding-a',
          channelRevision: 'consent-binding-a',
          userId: managerId,
          externalChannelId: 'C123',
        }),
      ).toEqual({ ok: false, code: 'bot_access_required' });
      expect(
        (
          await routes.remove({
            workspaceId,
            channelId: 'binding-a',
            userId: managerId,
            expectedRevision: assigned.route.revision,
          })
        ).ok,
      ).toBe(true);
    }));

  it('rejects an assignment paused before a concurrently committed revocation', async () =>
    scoped(async () => {
      const workspaceId = await install();
      await binding(workspaceId);
      await grantManagers(workspaceId);
      let release!: () => void;
      let paused!: () => void;
      const resumed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        paused = resolve;
      });
      const model = db.models.SlackWorkspace;
      const update = model.updateOne.bind(model);
      const spy = jest.spyOn(model, 'updateOne').mockImplementationOnce((...args) => {
        paused();
        return resumed.then(() => update(...args)) as ReturnType<typeof model.updateOne>;
      });
      const assignment = routes.assign({
        workspaceId,
        channelId: 'binding-a',
        channelRevision: 'consent-binding-a',
        userId: managerId,
      });
      try {
        await waitForPause(reached, assignment);
        await grantManagers(workspaceId, []);
        release();
        expect(await assignment).toEqual({ ok: false, code: 'bot_access_required' });
        expect(await routes.read(workspaceId)).toBeNull();
      } finally {
        release();
        spy.mockRestore();
        await Promise.allSettled([assignment]);
      }
    }));

  it('uses revision-checked tenant-local grants and rejects erased, foreign and nonexistent users atomically', async () =>
    scoped(async () => {
      const workspaceId = await install();
      const revision = await grantManagers(workspaceId);
      const change = (userIds: string[], expected = revision) =>
        installations.setBotManagers({
          workspaceId,
          revision: expected,
          userIds,
          actorId: adminId,
          maxManagers: 2,
        });
      for (const userIds of [
        ['not-an-id'],
        [otherId, '000000000000000000000099'],
        [adminId, managerId, otherId],
      ]) {
        expect((await change(userIds)).ok).toBe(false);
      }
      await db.models.User.updateOne(
        { _id: otherId },
        { $set: { agentTriggerDeletionStartedAt: new Date() } },
      );
      expect((await change([otherId])).ok).toBe(false);
      expect(await installations.botManagers(workspaceId)).toMatchObject({
        revision,
        managers: [{ id: managerId }],
      });
      await scoped(async () => {
        expect(await installations.botManagers(workspaceId)).toBeNull();
        expect((await change([managerId])).ok).toBe(false);
      }, 'org-b');
      const result = await change([]);
      expect(result.ok).toBe(true);
      expect(await change([managerId])).toEqual({ ok: false, code: 'workspace_changed' });
    }));

  it('filters member pages before pagination and never copies Slack credentials into manager metadata', async () =>
    scoped(async () => {
      const app = await installations.app('A123');
      await installations.configureApp(
        { ...appCredentials, name: 'Permitted bot' },
        'admin',
        app!.revision,
      );
      const first = await install();
      await grantManagers(first);
      expect((await installations.list(undefined, 1, otherId)).workspaces).toEqual([]);
      const hidden = await install('ungranted-token', 'T999', 'A456');
      await db.models.SlackWorkspace.updateOne(
        { workspaceId: hidden },
        { $set: { workspaceId: 'a-hidden' } },
      );
      await db.models.SlackWorkspace.updateOne(
        { workspaceId: first },
        { $set: { workspaceId: 'z-managed' } },
      );
      expect((await installations.list(undefined, 1)).workspaces[0].workspaceId).toBe('a-hidden');
      const listed = await installations.list(undefined, 1, managerId);
      expect(listed.workspaces).toHaveLength(1);
      expect(listed.workspaces[0]).toMatchObject({
        workspaceId: 'z-managed',
        canManageBot: true,
        appName: 'Permitted bot',
      });
      expect(JSON.stringify(listed)).not.toMatch(/encrypted|bot-token|client-secret/);
      expect(await scoped(() => installations.list(undefined, 1, managerId), 'org-b')).toEqual({
        workspaces: [],
      });
    }));

  it('preserves grants on token refresh and clears them before disconnect or a fresh installation', async () =>
    scoped(async () => {
      const workspaceId = await install();
      await grantManagers(workspaceId);
      expect(await install('refreshed-token')).toBe(workspaceId);
      expect((await installations.metadata(workspaceId, managerId))?.canManageBot).toBe(true);
      await installations.disconnect(workspaceId);
      expect(
        await db.models.AclEntry.countDocuments({ resourceType: ResourceType.SLACK_BOT }),
      ).toBe(0);
      const replacement = await install();
      expect(replacement).not.toBe(workspaceId);
      expect((await installations.metadata(replacement, managerId))?.canManageBot).toBe(false);
      expect((await installations.botManagers(replacement))?.managers).toEqual([]);
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

  it('retires routing with the channel, preserves old threads and lets new conversations use the default', async () =>
    scoped(async () => {
      const workspaceId = await install();
      await binding(workspaceId);
      await binding(workspaceId, 'specific');
      await assign(workspaceId, 'binding-a');
      await assign(workspaceId, 'specific', 'C123');
      await db.models.SlackThreadRoute.create({
        workspaceId,
        externalUserId: 'U123',
        externalThreadKey: 'C123:old',
        channelId: 'specific',
        userId: 'member',
      });
      await db.models.ChannelRun.collection.insertOne({
        tenantId: 'org-a',
        channelId: 'specific',
        runId: 'draining',
        laneId: 'draining',
        sequence: 1,
        state: 'executing',
      });
      expect(await channels.deleteAgentChannel('specific', 'agent-manager')).toEqual({
        status: 'pending_drain',
      });
      expect(await routes.read(workspaceId, 'C123')).toBeNull();
      expect((await routes.resolve(workspaceId, 'C123'))?.channelId).toBe('binding-a');
      expect(await dispatch.thread(workspaceId, 'U123', 'C123:old')).toBe('specific');
      expect(await channels.getActiveAgentChannel('specific')).toBeNull();
      expect(await routes.listForChannel('specific')).toEqual({ routes: [] });
      await db.models.ChannelRun.deleteMany({ runId: 'draining' });
      expect(await channels.deleteAgentChannel('specific', 'agent-manager')).toEqual({
        status: 'deleted',
      });
      await channels.deleteAgentChannel('binding-a', 'agent-manager');
      expect(await routes.resolve(workspaceId, 'C123')).toBeNull();
    }));

  it('serializes assignment against retirement without erasing another tenant’s routes', async () => {
    const workspaceId = await scoped(async () => {
      const id = await install();
      await binding(id);
      return id;
    });
    await scoped(
      () =>
        db.models.SlackRoute.create({
          workspaceId: 'foreign-workspace',
          channelId: 'binding-a',
          revision: 'foreign',
        }),
      'org-b',
    );
    await scoped(async () => {
      await Promise.all([
        assign(workspaceId, 'binding-a', 'C123'),
        channels.beginAgentChannelDeletion('binding-a', 'agent-manager'),
      ]);
      expect(await routes.resolve(workspaceId, 'C123')).toBeNull();
      expect(await routes.listForChannel('binding-a')).toEqual({ routes: [] });
    });
    expect((await scoped(() => routes.read('foreign-workspace'), 'org-b'))?.revision).toBe(
      'foreign',
    );
  });

  it('uses indexed OR branches for progress and receipt lookups in an established workspace', async () =>
    scoped(async () => {
      const workspaceId = await install();
      await db.models.ChannelRun.collection.insertMany(
        Array.from({ length: 500 }, (_, i) => ({
          tenantId: 'org-a',
          workspaceId,
          channelId: 'binding-a',
          runId: `lookup-${i}`,
          laneId: `lookup-${i}`,
          sequence: 1,
          admission: { actor: { teamId: 'T123', appId: 'A123' }, eventId: `lookup-${i}` },
          progress: { externalMessageKey: i === 0 ? 'progress-target' : `other-${i}` },
          receipts: i === 1 ? [{ externalMessageKey: 'receipt-target' }] : [],
        })),
      );
      for (const externalMessageKey of ['progress-target', 'receipt-target']) {
        expect(await dispatch.message(workspaceId, externalMessageKey)).toBe('binding-a');
        const plan = await db.models.ChannelRun.collection
          .find({
            tenantId: 'org-a',
            workspaceId,
            $or: [
              { 'progress.externalMessageKey': externalMessageKey },
              { 'receipts.externalMessageKey': externalMessageKey },
            ],
          })
          .limit(2)
          .explain('executionStats');
        expect(plan.executionStats.nReturned).toBe(1);
        expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(2);
        expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.toContain('COLLSCAN');
      }
    }));

  it('removes the deleted creator’s routes without deleting the organization installation', async () =>
    scoped(async () => {
      const workspaceId = await install();
      const owner = { tenantId: 'org-a', userId: '000000000000000000000020' };
      await channels.createAgentChannel({
        channelId: 'account-owned',
        workspaceId,
        agentId: 'agent-account',
        createdBy: owner.userId,
        type: 'slack',
        status: 'active',
        credentialMode: 'per_user',
        revision: 'account-consent',
      });
      expect((await assign(workspaceId, 'account-owned', 'C123')).ok).toBe(true);
      await closeResponseScopes(db, owner);
      await eraseChannelPersistenceForUser(db, owner);
      expect(await routes.read(workspaceId, 'C123')).toBeNull();
      expect(await channels.getAgentChannel('account-owned')).toBeNull();
      expect((await installations.metadata(workspaceId))?.status).toBe('active');
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

  it('reads committed installation and routing authority from primary despite a secondary connection default', async () =>
    scoped(async () => {
      const workspaceId = await install();
      await binding(workspaceId);
      await assign(workspaceId, 'binding-a');
      const principal = await linked('binding-a');
      const admitted = await createChannelRunStorage(db).admit(
        {
          tenantId: 'org-a',
          workspaceId,
          channelId: 'binding-a',
          agentId: 'agent-binding-a',
          principal,
          admission: event('one'),
        },
        Date.now(),
      );
      await installations.startInstall({
        stateHash: 'pending-read',
        userId: 'admin',
        appId: 'A123',
        clientId: '123.456',
        expiresAt: new Date(Date.now() + 60000),
      });
      const reader = new mongoose.Mongoose();
      let restoreDatabase: (() => void) | undefined;
      try {
        await reader.connect(mongo.getUri(), {
          serverSelectionTimeoutMS: 1000,
          autoIndex: false,
          autoCreate: false,
        });
        const database = jest.replaceProperty(
          reader.connection,
          'db',
          reader.connection.getClient().db(reader.connection.name, { readPreference: 'secondary' }),
        );
        restoreDatabase = () => database.restore();
        createModels(reader);
        const saved = createSlackWorkspaceStorage(reader);
        const routing = createSlackRouteStorage(reader);
        const discovery = createSlackDispatchStorage(reader);
        const live = createAgentChannelMethods(reader);
        // This replica set has no secondary: any accidental inherited read preference fails.
        await expect(
          reader.models.AgentChannel.findOne({ channelId: 'binding-a' }).lean(),
        ).rejects.toThrow('Server selection timed out');
        expect((await saved.list()).workspaces).toHaveLength(1);
        expect((await saved.metadata(workspaceId))?.status).toBe('active');
        expect((await saved.read(workspaceId))?.encryptedBotToken).toBe('encrypted-bot-token');
        expect((await saved.route('A123', 'T123'))?.workspaceId).toBe(workspaceId);
        expect((await saved.findInstall('pending-read'))?.stateHash).toBe('pending-read');
        expect((await routing.resolve(workspaceId, 'C123'))?.channelId).toBe('binding-a');
        expect((await routing.listForChannel('binding-a')).routes).toHaveLength(1);
        expect((await live.getActiveAgentChannel('binding-a'))?.workspaceId).toBe(workspaceId);
        expect((await live.getAgentChannelMetadata('binding-a'))?.status).toBe('active');
        expect((await live.listAgentChannels('agent-binding-a'))[0].status).toBe('active');
        expect(await discovery.thread(workspaceId, 'UACTOR', 'C123:1.000001')).toBe('binding-a');
        expect(await discovery.run(workspaceId, admitted.run.runId)).toBe('binding-a');
        expect(await discovery.link(principal.linkId)).toBe('binding-a');
        expect(await discovery.message(workspaceId, 'C123:1.000001')).toBeNull();
        expect(await runAsSystem(() => discovery.discover(1, Date.now()))).toEqual([
          { tenantId: 'org-a', channelId: 'binding-a' },
        ]);
      } finally {
        restoreDatabase?.();
        await reader.disconnect();
      }
    }));

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

  it.each(['disable', 'disconnect'] as const)(
    'advances past a saturated page of unclaimable runs after %s without granting execution',
    async (retirement) =>
      scoped(async () => {
        const workspaceId = await install();
        const runs = createChannelRunStorage(db);
        const now = Date.now();
        for (const [index, channelId] of ['stale-a', 'stale-b'].entries()) {
          await binding(workspaceId, channelId);
          await runs.admit(
            {
              tenantId: 'org-a',
              workspaceId,
              channelId,
              agentId: `agent-${channelId}`,
              principal: await linked(channelId),
              admission: { ...event(channelId), externalThreadKey: `C123:1.00000${index}` },
            },
            now,
          );
          if (retirement === 'disable')
            await channels.updateAgentChannel(
              channelId,
              'agent-manager',
              { status: 'disabled' },
              'active',
              `consent-${channelId}`,
            );
        }
        if (retirement === 'disconnect') await installations.disconnect(workspaceId);
        expect(await channels.getActiveAgentChannel('stale-a')).toBeNull();
        const healthyWorkspace = retirement === 'disconnect' ? await install() : workspaceId;
        await binding(healthyWorkspace, 'healthy');
        await runs.admit(
          {
            tenantId: 'org-a',
            workspaceId: healthyWorkspace,
            channelId: 'healthy',
            agentId: 'agent-healthy',
            principal: await linked('healthy'),
            admission: { ...event('healthy'), externalThreadKey: 'C123:1.000003' },
          },
          now + 1,
        );
        expect(await runAsSystem(() => dispatch.discover(2, now + 2))).toEqual([
          { tenantId: 'org-a', channelId: 'stale-a' },
          { tenantId: 'org-a', channelId: 'stale-b' },
        ]);
        expect(await runAsSystem(() => dispatch.discover(2, now + 3))).toContainEqual({
          tenantId: 'org-a',
          channelId: 'healthy',
        });
        expect(await db.models.ChannelRun.countDocuments({ state: 'queued', leaseEpoch: 0 })).toBe(
          3,
        );
      }),
  );

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
