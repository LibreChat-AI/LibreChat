import mongoose from 'mongoose';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import type { SlackWorkspaceStorage } from './slackWorkspace';
import { createSlackWorkspaceModel, createSlackInstallModel } from '~/models/slackWorkspace';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { TransactionUnavailableError } from '~/utils/transactions';
import { eraseChannelPersistenceForUser } from './channelErasure';
import { createSlackWorkspaceStorage } from './slackWorkspace';
import { closeResponseScopes } from './responseScope';

jest.mock('~/config/winston', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('organization-owned Slack workspaces', () => {
  const db = new mongoose.Mongoose();
  let mongo: MongoMemoryReplSet;
  let store: SlackWorkspaceStorage;
  const userId = '000000000000000000000001';
  const scopes = ['app_mentions:read', 'chat:write'];
  const scoped = <T>(id: string | undefined, task: () => Promise<T>) =>
    tenantStorage.run({ tenantId: id }, task);
  const start = (hash: string, extra = {}) =>
    store.startInstall({
      stateHash: hash,
      userId,
      appId: 'A123',
      clientId: '123.456',
      expiresAt: new Date(Date.now() + 60_000),
      ...extra,
    });
  const finish = async (
    hash: string,
    teamId = 'T123',
    encryptedBotToken = 'ciphertext-not-plaintext',
  ) => {
    const claim = await store.claimInstall(hash, userId, new Date());
    if (!claim) return { ok: false, code: 'invalid_install' } as const;
    return store.completeInstall(
      hash,
      claim.callbackId,
      {
        appId: 'A123',
        teamId,
        teamName: 'Sandbox',
        botUserId: 'U123',
        scopes,
        encryptedBotToken,
      },
      new Date(),
    );
  };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await db.connect(mongo.getUri(), {
      readPreference: 'secondaryPreferred',
      monitorCommands: true,
    });
    store = createSlackWorkspaceStorage(db);
  }, 60000);
  afterAll(async () => {
    await db.disconnect();
    await mongo?.stop();
  });
  beforeEach(async () => {
    await runAsSystem(async () => {
      for (const model of Object.values(db.models)) await model.deleteMany({});
    });
  });

  it('reads a just-created callback state from primary despite the connection read preference', async () => {
    await scoped('org-a', () => start('primary-callback-state'));
    const modes: string[] = [];
    const collection = createSlackInstallModel(db).collection.collectionName;
    const observe = (event: mongoose.mongo.CommandStartedEvent) => {
      if (event.commandName === 'find' && event.command.find === collection)
        modes.push(event.command.$readPreference?.mode ?? 'primary');
    };
    const client = db.connection.getClient();
    client.on('commandStarted', observe);
    try {
      expect(await store.findInstall('primary-callback-state')).toMatchObject({
        tenantId: 'org-a',
      });
      expect(modes).toEqual(['primary']);
    } finally {
      client.off('commandStarted', observe);
    }
  });

  const appCredentials = {
    appId: 'A123',
    clientId: '123.456',
    encryptedClientSecret: 'encrypted-client-secret',
    encryptedSigningSecret: 'encrypted-signing-secret',
  };

  it('keeps app credentials organization-owned, secret-free in listings and isolated by tenant', async () => {
    await scoped('org-a', async () => {
      expect(await store.configureApp(appCredentials, userId)).toMatchObject({
        appId: 'A123',
        clientId: '123.456',
      });
      expect(await store.app('A123')).toMatchObject(appCredentials);
      expect(JSON.stringify(await store.apps())).not.toContain('encrypted-');
      await closeResponseScopes(db, { userId, tenantId: 'org-a' });
      await eraseChannelPersistenceForUser(db, { userId, tenantId: 'org-a' });
      expect((await store.apps()).apps).toHaveLength(1);
    });
    await scoped('org-b', async () => {
      expect(await store.app('A123')).toBeNull();
      expect((await store.apps()).apps).toEqual([]);
    });
  });

  it('requires the current app revision and fences a callback when credentials change', async () => {
    await scoped('org-a', async () => {
      const first = await store.configureApp(appCredentials, userId);
      expect(first).not.toBeNull();
      await start('before-app-update');
      expect(await store.configureApp(appCredentials, userId)).toBeNull();
      expect(await store.configureApp(appCredentials, userId, 'stale')).toBeNull();
      const next = await store.configureApp(
        { ...appCredentials, encryptedClientSecret: 'replacement-ciphertext' },
        userId,
        first!.revision,
      );
      expect(next?.revision).not.toBe(first!.revision);
      expect(await finish('before-app-update')).toEqual({ ok: false, code: 'stale_install' });
    });
  });

  it('does not remove credentials while workspaces use the app, then erases both secrets', async () => {
    await scoped('org-a', async () => {
      await store.configureApp(appCredentials, userId);
      await start('active-workspace');
      const installed = await finish('active-workspace');
      expect(installed.ok).toBe(true);
      const current = await store.app('A123');
      expect(await store.removeApp('A123', current!.revision)).toBe('workspace_in_use');
      if (!installed.ok) throw new Error('Test install failed');
      await store.disconnect(installed.workspace.workspaceId);
      const disconnected = await store.app('A123');
      expect(await store.removeApp('A123', disconnected!.revision)).toBe('removed');
      expect(await store.app('A123')).toBeNull();
      expect((await store.apps()).apps).toEqual([]);
      expect((await store.list()).workspaces).toEqual([]);
      expect(await store.read(installed.workspace.workspaceId)).toMatchObject({
        status: 'disconnected',
        removedAt: expect.any(Date),
      });
    });
  });

  it('removes only a current disconnected workspace and preserves installation fences', async () => {
    await scoped('org-a', () => start('original'));
    const installed = await scoped('org-a', () => finish('original'));
    if (!installed.ok) throw new Error('Test install failed');
    const { workspaceId, revision } = installed.workspace;
    expect(await scoped('org-a', () => store.remove(workspaceId, revision))).toBe(false);
    await scoped('org-a', () => start('delayed-before-disconnect'));
    await scoped('org-a', () => store.disconnect(workspaceId, revision));
    const retired = await scoped('org-a', () => store.read(workspaceId));
    expect(retired?.encryptedBotToken).toBeUndefined();
    expect(await scoped('org-b', () => store.remove(workspaceId, retired!.revision))).toBe(false);
    expect(await scoped('org-a', () => store.remove(workspaceId, revision))).toBe(false);
    expect(await scoped('org-a', () => store.remove(workspaceId, retired!.revision))).toBe(true);
    expect((await scoped('org-a', () => store.list())).workspaces).toEqual([]);
    expect(await scoped('org-a', () => store.read(workspaceId))).toMatchObject({
      status: 'disconnected',
      removedAt: expect.any(Date),
    });
    expect(await scoped('org-a', () => finish('delayed-before-disconnect'))).toEqual({
      ok: false,
      code: 'stale_install',
    });
    await scoped('org-a', () => start('fresh-install'));
    const fresh = await scoped('org-a', () => finish('fresh-install'));
    if (!fresh.ok) throw new Error('Fresh install failed');
    expect(fresh.workspace.workspaceId).not.toBe(workspaceId);
    expect((await scoped('org-a', () => store.list())).workspaces).toEqual([fresh.workspace]);
    expect(await scoped('org-a', () => store.remove(workspaceId, retired!.revision))).toBe(false);
  });

  it('allows only one concurrent update of the same organization app revision', async () => {
    await scoped('org-a', async () => {
      const current = await store.configureApp(appCredentials, userId);
      const changes = await Promise.all([
        store.configureApp(
          { ...appCredentials, encryptedClientSecret: 'first' },
          userId,
          current!.revision,
        ),
        store.configureApp(
          { ...appCredentials, encryptedClientSecret: 'second' },
          userId,
          current!.revision,
        ),
      ]);
      expect(changes.filter(Boolean)).toHaveLength(1);
    });
  });

  it('supports several workspaces without tying them to the installing user', async () => {
    await scoped('org-a', async () => {
      await start('state-a');
      await start('state-b');
      expect((await finish('state-a', 'T1')).ok).toBe(true);
      expect((await finish('state-b', 'T2')).ok).toBe(true);
      await closeResponseScopes(db, { userId, tenantId: 'org-a' });
      await eraseChannelPersistenceForUser(db, { userId, tenantId: 'org-a' });
      const page = await store.list(undefined, 1);
      expect(page.workspaces).toHaveLength(1);
      expect(page.next).toBeDefined();
      expect((await store.list(page.next, 1)).workspaces).toHaveLength(1);
      expect(JSON.stringify(await store.list())).not.toContain('ciphertext');
      expect(JSON.stringify(await store.list())).not.toContain(userId);
    });
    expect((await scoped('org-b', () => store.list())).workspaces).toEqual([]);
  });

  it('consumes a flow once and never permits another tenant to complete it', async () => {
    await scoped('org-a', () => start('one-use'));
    expect(await scoped('org-b', () => finish('one-use'))).toEqual({
      ok: false,
      code: 'invalid_install',
    });
    expect((await scoped('org-a', () => finish('one-use'))).ok).toBe(true);
    expect(await scoped('org-a', () => finish('one-use'))).toEqual({
      ok: false,
      code: 'invalid_install',
    });
  });

  it('requires an exclusive callback claim and does not let a wrong claim consume it', async () => {
    await scoped('org-a', async () => {
      await start('exclusive');
      const claims = await Promise.all([
        store.claimInstall('exclusive', userId, new Date()),
        store.claimInstall('exclusive', userId, new Date()),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const claimed = claims.find((claim) => claim !== null)!;
      const grant = {
        appId: 'A123',
        teamId: 'T123',
        teamName: 'Sandbox',
        botUserId: 'U123',
        scopes,
        encryptedBotToken: 'ciphertext',
      };
      expect(await store.completeInstall('exclusive', '', grant, new Date())).toEqual({
        ok: false,
        code: 'invalid_install',
      });
      expect(await store.completeInstall('exclusive', 'wrong-claim', grant, new Date())).toEqual({
        ok: false,
        code: 'invalid_install',
      });
      await store.retireInstall('exclusive', 'wrong-claim');
      expect(
        (await store.completeInstall('exclusive', claimed.callbackId, grant, new Date())).ok,
      ).toBe(true);
      await start('cancel-claimed');
      const cancelled = await store.claimInstall('cancel-claimed', userId, new Date());
      await store.cancelInstall('cancel-claimed', userId);
      expect(
        await store.completeInstall('cancel-claimed', cancelled!.callbackId, grant, new Date()),
      ).toEqual({ ok: false, code: 'invalid_install' });
    });
  });

  it('does not trust delayed TTL deletion to reject expired flows', async () => {
    await scoped('org-a', () => start('expired', { expiresAt: new Date(0) }));
    expect(await scoped('org-a', () => finish('expired'))).toEqual({
      ok: false,
      code: 'invalid_install',
    });
    expect((await scoped('org-a', () => store.list())).workspaces).toEqual([]);
  });

  it('has one active tenant owner, and permits an explicit disconnect before transfer', async () => {
    await scoped('org-a', async () => {
      await start('first');
      expect((await finish('first')).ok).toBe(true);
    });
    await scoped('org-b', async () => {
      await start('conflict');
      expect(await finish('conflict')).toEqual({ ok: false, code: 'workspace_in_use' });
    });
    const [workspace] = (await scoped('org-a', () => store.list())).workspaces;
    expect(await scoped('org-b', () => store.disconnect(workspace.workspaceId))).toBe(false);
    expect(await scoped('org-a', () => store.disconnect(workspace.workspaceId))).toBe(true);
    await scoped('org-b', async () => {
      await start('transfer');
      const installed = await finish('transfer');
      expect(installed.ok).toBe(true);
      if (installed.ok) expect(installed.workspace.workspaceId).not.toBe(workspace.workspaceId);
    });
    expect(await scoped('org-a', () => store.read(workspace.workspaceId))).toBeNull();
  });

  it('disconnect removes stored credentials and fences every older pending callback', async () => {
    await scoped('org-a', async () => {
      await start('initial');
      await finish('initial');
      const [workspace] = (await store.list()).workspaces;
      await start('late');
      await store.disconnect(workspace.workspaceId);
      expect((await store.read(workspace.workspaceId))?.encryptedBotToken).toBeUndefined();
      expect(await finish('late')).toEqual({ ok: false, code: 'stale_install' });
      expect(await store.route('A123', 'T123')).toBeNull();
      await start('fresh');
      expect((await finish('fresh')).ok).toBe(true);
    });
  });

  it('reconnect cannot silently attach a different workspace', async () => {
    await scoped('org-a', async () => {
      await start('initial');
      await finish('initial');
      const [workspace] = (await store.list()).workspaces;
      await start('reconnect', {
        workspaceId: workspace.workspaceId,
        workspaceRevision: workspace.revision,
      });
      expect(await finish('reconnect', 'T-other')).toEqual({
        ok: false,
        code: 'workspace_changed',
      });
      expect((await store.list()).workspaces).toHaveLength(1);
    });
  });

  it('a delayed older installation cannot overwrite a newer credential', async () => {
    await scoped('org-a', async () => {
      await start('older');
      await start('newer');
      expect((await finish('newer')).ok).toBe(true);
      expect(await finish('older')).toEqual({ ok: false, code: 'stale_install' });
    });
  });

  it('concurrent initial attempts and callbacks preserve the newer credential', async () => {
    await scoped('org-a', async () => {
      const attempts = await Promise.all([start('concurrent-a'), start('concurrent-b')]);
      const [older, newer] = attempts.sort((a, b) => a.installOrder - b.installOrder);
      const outcomes = await Promise.all([
        finish(older.stateHash, 'T123', 'older-ciphertext'),
        finish(newer.stateHash, 'T123', 'newer-ciphertext'),
      ]);
      expect(outcomes[1].ok).toBe(true);
      const [workspace] = (await store.list()).workspaces;
      expect((await store.read(workspace.workspaceId))?.encryptedBotToken).toBe('newer-ciphertext');
    });
  });

  it('disconnect racing a callback leaves no active installation or stored credential', async () => {
    await scoped('org-a', async () => {
      await start('initial');
      await finish('initial');
      const [workspace] = (await store.list()).workspaces;
      await start('racing');
      await Promise.all([finish('racing'), store.disconnect(workspace.workspaceId)]);
      expect(await store.route('A123', 'T123')).toBeNull();
      expect((await store.read(workspace.workspaceId))?.encryptedBotToken).toBeUndefined();
    });
  });

  it('only the initiating user can cancel an attempt and a late callback cannot complete it', async () => {
    await scoped('org-a', async () => {
      await start('cancelled');
      await store.cancelInstall('cancelled', 'some-other-user');
      expect(await store.findInstall('cancelled')).not.toBeNull();
      await store.cancelInstall('cancelled', userId);
      expect(await finish('cancelled')).toEqual({ ok: false, code: 'invalid_install' });
    });
  });

  it('default-tenant reads never enumerate tenant-owned connections or credentials', async () => {
    await scoped('org-a', async () => {
      await start('org');
      await finish('org');
    });
    expect((await scoped(undefined, () => store.list())).workspaces).toEqual([]);
    const route = await store.route('A123', 'T123');
    expect(route?.tenantId).toBe('org-a');
    expect(route).not.toHaveProperty('encryptedBotToken');
    const raw = await runAsSystem(async () => createSlackWorkspaceModel(db).findOne({}).lean());
    expect(raw).not.toHaveProperty('encryptedBotToken');
  });
});

describe('standalone database', () => {
  it('rejects install persistence before private flow or credential writes', async () => {
    const db = new mongoose.Mongoose();
    const mongo = await MongoMemoryServer.create();
    try {
      await db.connect(mongo.getUri());
      const store = createSlackWorkspaceStorage(db);
      expect(await store.list()).toEqual({ workspaces: [] });
      await expect(
        store.startInstall({
          stateHash: 'private-state',
          userId: '000000000000000000000001',
          appId: 'A123',
          clientId: '123.456',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).rejects.toBeInstanceOf(TransactionUnavailableError);
      expect(await createSlackInstallModel(db).countDocuments()).toBe(0);
      expect(await createSlackWorkspaceModel(db).countDocuments()).toBe(0);
    } finally {
      await db.disconnect();
      await mongo.stop();
    }
  }, 60000);
});
