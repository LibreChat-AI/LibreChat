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
  const finish = (hash: string, teamId = 'T123', encryptedBotToken = 'ciphertext-not-plaintext') =>
    store.completeInstall(
      hash,
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

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await db.connect(mongo.getUri(), { readPreference: 'secondaryPreferred' });
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
