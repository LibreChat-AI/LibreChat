import mongoose from 'mongoose';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import type { SlackWorkspaceStorage } from './slackWorkspace';
import {
  createSlackWorkspaceModel,
  createSlackInstallModel,
  createSlackInstallGenerationModel,
} from '~/models/slackWorkspace';
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
    appId = 'A123',
  ) => {
    const claim = await store.claimInstall(hash, userId, new Date());
    if (!claim) return { ok: false, code: 'invalid_install' } as const;
    return store.completeInstall(
      hash,
      claim.callbackId,
      {
        appId,
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

  it('persists display names, supports secret-free edits and clears names on removal', async () => {
    await scoped('org-a', async () => {
      const first = await store.configureApp(
        { ...appCredentials, name: '  Support bot  ' },
        userId,
      );
      expect(first).toMatchObject({ name: 'Support bot' });
      expect((await store.apps()).apps).toEqual([first]);
      await start('before-name-edit');
      const renamed = await store.configureApp(
        { appId: 'A123', clientId: '123.456', name: 'Help desk' },
        userId,
        first!.revision,
      );
      expect(renamed).toMatchObject({ name: 'Help desk' });
      expect(await store.app('A123')).toMatchObject({ ...appCredentials, name: 'Help desk' });
      expect(
        await store.configureApp(
          { appId: 'A123', clientId: '123.456', name: 'stale' },
          userId,
          first!.revision,
        ),
      ).toBeNull();
      expect(await finish('before-name-edit')).toEqual({ ok: false, code: 'stale_install' });
      const preserved = await store.configureApp(
        { appId: 'A123', clientId: '123.456', encryptedSigningSecret: 'new-signing-ciphertext' },
        userId,
        renamed!.revision,
      );
      expect(preserved?.name).toBe('Help desk');
      expect(await store.app('A123')).toMatchObject({
        encryptedClientSecret: appCredentials.encryptedClientSecret,
        encryptedSigningSecret: 'new-signing-ciphertext',
      });
      const cleared = await store.configureApp(
        { appId: 'A123', clientId: '123.456', name: '  ' },
        userId,
        preserved!.revision,
      );
      expect(cleared).not.toHaveProperty('name');
      expect(await store.app('A123')).not.toHaveProperty('name');
      const named = await store.configureApp(
        { appId: 'A123', clientId: '123.456', name: 'Removed bot' },
        userId,
        cleared!.revision,
      );
      expect(await store.removeApp('A123', named!.revision)).toBe('removed');
      const recreated = await store.configureApp(appCredentials, userId);
      expect(recreated).not.toHaveProperty('name');
      expect(await store.app('A123')).not.toHaveProperty('name');
    });
    expect(await scoped('org-b', () => store.apps())).toEqual({ apps: [] });
  });

  it('keeps active workspace authority and its bot token intact when an app is renamed', async () => {
    await scoped('org-a', async () => {
      const app = await store.configureApp(appCredentials, userId);
      await start('active-before-name-edit');
      const installed = await finish('active-before-name-edit');
      if (!installed.ok) throw new Error('Test install failed');
      const before = await store.read(installed.workspace.workspaceId);
      await store.configureApp(
        { appId: 'A123', clientId: '123.456', name: 'Friendly bot' },
        userId,
        app!.revision,
      );
      expect(await store.metadata(installed.workspace.workspaceId)).toEqual({
        ...installed.workspace,
        appName: 'Friendly bot',
      });
      expect((await store.read(installed.workspace.workspaceId))?.encryptedBotToken).toBe(
        before?.encryptedBotToken,
      );
    });
  });

  it('batches current app names only for the authorized workspace page', async () => {
    await scoped('org-a', async () => {
      await store.configureApp({ ...appCredentials, name: 'Support bot' }, userId);
      await store.configureApp({ ...appCredentials, appId: 'A456', name: 'Sales bot' }, userId);
      await start('support-name');
      await finish('support-name');
      await start('sales-name', { appId: 'A456' });
      await finish('sales-name', 'T456', 'sales-token', 'A456');
      const reads: mongoose.mongo.Document[] = [];
      const collection = createSlackInstallGenerationModel(db).collection.collectionName;
      const observe = (event: mongoose.mongo.CommandStartedEvent) => {
        if (event.commandName === 'find' && event.command.find === collection)
          reads.push(event.command);
      };
      const client = db.connection.getClient();
      client.on('commandStarted', observe);
      try {
        const listed = await store.list(undefined, 2);
        expect(listed.workspaces.map((workspace) => workspace.appName).sort()).toEqual([
          'Sales bot',
          'Support bot',
        ]);
        expect(reads).toHaveLength(1);
        expect(reads[0].projection).toEqual({ appId: 1, name: 1, _id: 0 });
        expect(reads[0].filter).toMatchObject({
          tenantId: 'org-a',
          partition: 'org-a',
          appId: { $in: expect.arrayContaining(['A123', 'A456']) },
        });
        expect(JSON.stringify(listed)).not.toMatch(
          /encrypted|clientId|client-secret|signing-secret/,
        );
        reads.length = 0;
        const page = await store.list(undefined, 1);
        expect(reads).toHaveLength(1);
        expect(reads[0].filter.appId.$in).toEqual([page.workspaces[0].appId]);
        reads.length = 0;
        expect((await store.list(undefined, 1, '000000000000000000000002')).workspaces).toEqual([]);
        expect(reads).toHaveLength(0);
      } finally {
        client.off('commandStarted', observe);
      }
    });
  });

  it('reads fresh tenant-local display names without copying them into workspace storage or routing', async () => {
    const installed = await scoped('org-a', async () => {
      await store.configureApp({ ...appCredentials, name: 'Support bot' }, userId);
      await start('named-detail');
      const result = await finish('named-detail');
      if (!result.ok) throw new Error('Test installation failed');
      return result.workspace;
    });
    await scoped('org-b', async () => {
      await store.configureApp({ ...appCredentials, name: 'Other tenant bot' }, userId);
      expect(await store.metadata(installed.workspaceId)).toBeNull();
      expect((await store.list()).workspaces).toEqual([]);
    });
    await scoped('org-a', async () => {
      expect((await store.metadata(installed.workspaceId))?.appName).toBe('Support bot');
      const app = await store.app('A123');
      const renamed = await store.configureApp(
        { appId: 'A123', clientId: '123.456', name: 'Renamed bot' },
        userId,
        app!.revision,
      );
      expect((await store.metadata(installed.workspaceId))?.appName).toBe('Renamed bot');
      expect((await store.list()).workspaces[0].appName).toBe('Renamed bot');
      expect(await store.read(installed.workspaceId)).not.toHaveProperty('appName');
      expect(await store.route('A123', 'T123')).not.toHaveProperty('appName');
      await store.configureApp(
        { appId: 'A123', clientId: '123.456', name: '' },
        userId,
        renamed!.revision,
      );
      expect(await store.metadata(installed.workspaceId)).not.toHaveProperty('appName');
      expect((await store.list()).workspaces[0]).not.toHaveProperty('appName');
    });
  });

  it('requires complete new app credentials and a new secret when the client identity changes', async () => {
    await scoped('org-a', async () => {
      expect(
        await store.configureApp(
          { appId: 'A123', clientId: '123.456', name: 'Incomplete' },
          userId,
        ),
      ).toBeNull();
      expect(await store.app('A123')).toBeNull();
      const saved = await store.configureApp(appCredentials, userId);
      expect(
        await store.configureApp({ appId: 'A123', clientId: '987.654' }, userId, saved!.revision),
      ).toBeNull();
      expect(
        await store.configureApp(
          { appId: 'A123', clientId: '123.456', name: 'x'.repeat(101) },
          userId,
          saved!.revision,
        ),
      ).toBeNull();
      expect(
        await store.configureApp(
          { appId: 'A123', clientId: '123.456', encryptedSigningSecret: '' },
          userId,
          saved!.revision,
        ),
      ).toBeNull();
      const changed = await store.configureApp(
        { appId: 'A123', clientId: '987.654', encryptedClientSecret: 'new-client-ciphertext' },
        userId,
        saved!.revision,
      );
      expect(changed?.clientId).toBe('987.654');
      expect(await store.app('A123')).toMatchObject({
        encryptedSigningSecret: appCredentials.encryptedSigningSecret,
      });
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

  it('supports separate apps without tying their workspaces to the installing user', async () => {
    await scoped('org-a', async () => {
      await start('state-a');
      await start('state-b', { appId: 'A456' });
      expect((await finish('state-a', 'T1')).ok).toBe(true);
      expect((await finish('state-b', 'T2', 'second-app-ciphertext', 'A456')).ok).toBe(true);
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

  it.each([
    ['org-a', 'org-a'],
    ['org-a', 'org-b'],
  ])(
    'allows one active workspace per app across concurrent %s and %s callbacks',
    async (firstTenant, secondTenant) => {
      await Promise.all([
        scoped(firstTenant, () => start('single-app-first')),
        scoped(secondTenant, () => start('single-app-second')),
      ]);
      const outcomes = await Promise.all([
        scoped(firstTenant, () => finish('single-app-first', 'TFIRST')),
        scoped(secondTenant, () => finish('single-app-second', 'TSECOND')),
      ]);
      expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
      expect(outcomes.find((result) => !result.ok)).toEqual({
        ok: false,
        code: 'workspace_in_use',
      });
      const active = await runAsSystem(() =>
        createSlackWorkspaceModel(db).find({ appId: 'A123', status: 'active' }).lean(),
      );
      expect(active).toHaveLength(1);
      expect(await scoped(firstTenant, () => store.appInUse('A123'))).toBe(true);
      expect(await scoped(firstTenant, () => store.appInUse('A123', active[0].workspaceId))).toBe(
        false,
      );
    },
  );

  it('requires disconnect before moving an app and retains the retired workspace', async () => {
    await scoped('org-a', async () => {
      await start('first-team');
      const first = await finish('first-team', 'TFIRST');
      if (!first.ok) throw new Error('Test install failed');
      await start('wrong-team');
      expect(await finish('wrong-team', 'TSECOND')).toEqual({
        ok: false,
        code: 'workspace_in_use',
      });
      await start('same-team-refresh');
      const refreshed = await finish('same-team-refresh', 'TFIRST', 'refreshed-ciphertext');
      expect(refreshed.ok).toBe(true);
      expect((await store.read(first.workspace.workspaceId))?.encryptedBotToken).toBe(
        'refreshed-ciphertext',
      );
      await store.disconnect(first.workspace.workspaceId);
      expect(await store.appInUse('A123')).toBe(false);
      await start('new-team');
      const moved = await finish('new-team', 'TSECOND');
      expect(moved.ok).toBe(true);
      const workspaces = (await store.list()).workspaces;
      expect(workspaces).toHaveLength(2);
      expect(workspaces.find((workspace) => workspace.teamId === 'TFIRST')?.status).toBe(
        'disconnected',
      );
      expect(workspaces.find((workspace) => workspace.teamId === 'TSECOND')?.status).toBe('active');
    });
  });

  it('permits different apps in the same workspace', async () => {
    await scoped('org-a', async () => {
      await start('first-app');
      expect((await finish('first-app')).ok).toBe(true);
      await start('second-app', { appId: 'A456' });
      expect((await finish('second-app', 'T123', 'second-app-ciphertext', 'A456')).ok).toBe(true);
      expect((await store.list()).workspaces).toHaveLength(2);
    });
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
