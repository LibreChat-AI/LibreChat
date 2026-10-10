import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ToolApprovalGrantBinding } from 'librechat-data-provider';
import { createToolApprovalGrantModel } from '../models/toolApprovalGrant';
import { createToolApprovalGrantMethods } from './toolApprovalGrant';
import { tenantStorage } from '~/config/tenantContext';
import { createModels } from '../models';

let mongo: MongoMemoryServer;
const scope = { userId: 'user-a', conversationId: 'chat-a' };
const grant: ToolApprovalGrantBinding = {
  agentId: 'agent-a',
  instanceName: 'query_mcp_db',
  toolName: 'query_mcp_db',
  binding: 'digest-a',
  scope: 'chat',
};
const storage = createToolApprovalGrantMethods(mongoose);

/** Delay only the real grant update, after its authoritative read has completed. */
function suspendGrantWrite() {
  let resume!: () => void;
  let reached!: () => void;
  const suspended = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const execute = mongoose.Query.prototype.exec;
  let paused = false;
  const execution = jest.spyOn(mongoose.Query.prototype, 'exec').mockImplementation(function (
    this: mongoose.Query<unknown, unknown>,
  ) {
    if (
      !paused &&
      this.model.modelName === 'ToolApprovalGrant' &&
      'op' in this &&
      this.op === 'updateOne'
    ) {
      paused = true;
      reached();
      return suspended.then(() => execute.call(this));
    }
    return execute.call(this);
  });
  return { started, resume, restore: () => execution.mockRestore() };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  await createToolApprovalGrantModel(mongoose).syncIndexes();
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongoose.models.ToolApprovalGrant.deleteMany({});
});

test('per-chat approval survives a rebuilt reader without crossing chats or users', async () => {
  await storage.rememberToolApprovalGrants(scope, [grant]);
  const rebuilt = createToolApprovalGrantMethods(mongoose);
  expect((await rebuilt.getToolApprovalGrants(scope, [grant]))[0].approved).toBe(true);
  expect(
    (await rebuilt.getToolApprovalGrants({ ...scope, conversationId: 'chat-b' }, [grant]))[0]
      .approved,
  ).toBe(false);
  expect(
    (await rebuilt.getToolApprovalGrants({ ...scope, userId: 'user-b' }, [grant]))[0].approved,
  ).toBe(false);
});

test('persistent approval crosses chats but a schema-binding change does not', async () => {
  await storage.rememberToolApprovalGrants(scope, [{ ...grant, scope: 'always' }]);
  expect(
    (await storage.getToolApprovalGrants({ ...scope, conversationId: 'chat-b' }, [grant]))[0]
      .approved,
  ).toBe(true);
  expect(
    (await storage.getToolApprovalGrants(scope, [{ ...grant, binding: 'digest-b' }]))[0].approved,
  ).toBe(false);
});

test('reset fences every chat and a late approval cannot resurrect the grant', async () => {
  await storage.rememberToolApprovalGrants(scope, [grant]);
  await storage.resetToolApprovalGrants(scope.userId, grant.agentId, grant.toolName);
  await storage.rememberToolApprovalGrants(scope, [grant]);
  const reset = (await storage.getToolApprovalGrants(scope, [grant]))[0];
  expect(reset.approved).toBe(false);
  expect(reset.revocation).toEqual(expect.any(String));
  await storage.rememberToolApprovalGrants(scope, [{ ...grant, revocation: reset.revocation }]);
  expect((await storage.getToolApprovalGrants(scope, [grant]))[0].approved).toBe(true);
});

test('parallel saves remain idempotent', async () => {
  await Promise.all(
    Array.from({ length: 6 }, () => storage.rememberToolApprovalGrants(scope, [grant])),
  );
  expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(1);
});

test('identical user and tool identifiers stay isolated between tenants', async () => {
  const tenantA = { ...scope, tenantId: 'tenant-a' };
  const tenantB = { ...scope, tenantId: 'tenant-b' };
  await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
    storage.rememberToolApprovalGrants(tenantA, [grant]),
  );
  const a = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
    storage.getToolApprovalGrants(tenantA, [grant]),
  );
  const b = await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
    storage.getToolApprovalGrants(tenantB, [grant]),
  );
  expect(a[0].approved).toBe(true);
  expect(b[0].approved).toBe(false);
  await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
    storage.resetToolApprovalGrants(scope.userId, grant.agentId, grant.toolName),
  );
  expect(
    (
      await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        storage.getToolApprovalGrants(tenantA, [grant]),
      )
    )[0].approved,
  ).toBe(true);
});

test('reset before the first stored grant fences a late approved execution', async () => {
  const initial = (await storage.getToolApprovalGrants(scope, [grant]))[0];
  await storage.resetToolApprovalGrants(scope.userId, grant.agentId, grant.toolName);
  await storage.rememberToolApprovalGrants(scope, [{ ...grant, revocation: initial.revocation }]);
  expect((await storage.getToolApprovalGrants(scope, [grant]))[0].approved).toBe(false);
});

test('one-time review bindings cannot become stored grants', async () => {
  await expect(
    storage.rememberToolApprovalGrants(scope, [{ ...grant, scope: 'once' }]),
  ).rejects.toThrow('One-time');
  expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(0);
});

test('OAuth consent is generation-bound without hashing renewable token bytes', async () => {
  const owner = new mongoose.Types.ObjectId().toString();
  const authScope = { userId: owner, conversationId: 'oauth-chat' };
  const bound = { ...grant, serverName: 'db', oauthEpoch: 'grant-a' };
  const row = await mongoose.models.Token.create({
    userId: owner,
    type: 'mcp_oauth',
    identifier: 'mcp:db',
    token: 'synthetic-token-a',
    expiresAt: new Date(Date.now() + 60000),
    metadata: { credential_set_id: 'grant-a' },
  });
  await storage.rememberToolApprovalGrants(authScope, [bound]);
  expect((await storage.getToolApprovalGrants(authScope, [bound]))[0].approved).toBe(true);
  await mongoose.models.Token.updateOne(
    { _id: row._id },
    { $set: { token: 'synthetic-refreshed-token' } },
  );
  expect((await storage.getToolApprovalGrants(authScope, [bound]))[0].approved).toBe(true);
  await mongoose.models.Token.updateOne(
    { _id: row._id },
    { $set: { 'metadata.credential_set_id': 'grant-b' } },
  );
  const changed = (await storage.getToolApprovalGrants(authScope, [bound]))[0];
  expect(changed.oauthEpoch).toBe('grant-b');
  expect(changed.approved).toBe(false);
  expect(JSON.stringify(changed)).not.toContain('synthetic-refreshed-token');
  await mongoose.models.Token.deleteOne({ _id: row._id });
});

test('agent-wide personal reset fences every learned tool without touching another user or agent', async () => {
  const persistent: ToolApprovalGrantBinding = {
    ...grant,
    toolName: 'other_mcp_db',
    instanceName: 'other_mcp_db',
    binding: 'digest-b',
    scope: 'always',
  };
  const anotherAgent = { ...grant, agentId: 'agent-b', binding: 'digest-agent-b' };
  await storage.rememberToolApprovalGrants(scope, [grant, persistent, anotherAgent]);
  await storage.rememberToolApprovalGrants({ ...scope, userId: 'user-b' }, [grant]);
  await storage.resetToolApprovalGrants(scope.userId, grant.agentId);
  // A completed in-flight approval still carries the pre-reset epoch.
  await storage.rememberToolApprovalGrants(scope, [grant, persistent]);
  expect(
    (await storage.getToolApprovalGrants(scope, [grant, persistent])).map(
      (status) => status.approved,
    ),
  ).toEqual([false, false]);
  expect((await storage.getToolApprovalGrants(scope, [anotherAgent]))[0].approved).toBe(true);
  expect(
    (await storage.getToolApprovalGrants({ ...scope, userId: 'user-b' }, [grant]))[0].approved,
  ).toBe(true);
});

test('agent-wide reset before the first grant fences every unseen in-flight tool', async () => {
  const pending: ToolApprovalGrantBinding = {
    ...grant,
    toolName: 'pending_mcp_db',
    instanceName: 'pending_mcp_db',
    binding: 'pending-binding',
  };
  await storage.resetToolApprovalGrants(scope.userId, grant.agentId);
  await storage.rememberToolApprovalGrants(scope, [grant, pending]);
  expect(
    (await storage.getToolApprovalGrants(scope, [grant, pending])).map((status) => status.approved),
  ).toEqual([false, false]);
});

test('agent-wide reset cannot cross tenant scope for the same user and tools', async () => {
  const other: ToolApprovalGrantBinding = {
    ...grant,
    toolName: 'other_mcp_db',
    instanceName: 'other_mcp_db',
    binding: 'digest-b',
  };
  const a = { ...scope, tenantId: 'tenant-a' };
  const b = { ...scope, tenantId: 'tenant-b' };
  for (const current of [a, b])
    await tenantStorage.run({ tenantId: current.tenantId }, () =>
      storage.rememberToolApprovalGrants(current, [grant, other]),
    );
  await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
    storage.resetToolApprovalGrants(scope.userId, grant.agentId),
  );
  expect(
    (
      await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        storage.getToolApprovalGrants(a, [grant, other]),
      )
    ).map((status) => status.approved),
  ).toEqual([false, false]);
  expect(
    (
      await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
        storage.getToolApprovalGrants(b, [grant, other]),
      )
    ).map((status) => status.approved),
  ).toEqual([true, true]);
});

for (const mode of ['chat', 'always'] as const) {
  for (const resetScope of ['tool', 'agent'] as const) {
    test(`${mode} consent renewed after ${resetScope} reset survives a late stale completion`, async () => {
      const pending = { ...grant, scope: mode };
      await storage.rememberToolApprovalGrants(scope, [pending]);
      await storage.resetToolApprovalGrants(
        scope.userId,
        grant.agentId,
        resetScope === 'tool' ? grant.toolName : undefined,
      );
      const current = (await storage.getToolApprovalGrants(scope, [pending]))[0];
      const renewed = { ...pending, revocation: current.revocation };
      await storage.rememberToolApprovalGrants(scope, [renewed]);
      await storage.rememberToolApprovalGrants(scope, [pending]);
      expect((await storage.getToolApprovalGrants(scope, [renewed]))[0].approved).toBe(true);
    });

    test.each([false, true])(
      `${mode} ${resetScope} reset between fence read and write cannot clobber renewal; first grant=%s`,
      async (firstGrant) => {
        const pending = { ...grant, scope: mode };
        if (!firstGrant) await storage.rememberToolApprovalGrants(scope, [pending]);
        const pause = suspendGrantWrite();
        const staleWrite = storage.rememberToolApprovalGrants(scope, [pending]);
        await pause.started;
        try {
          await storage.resetToolApprovalGrants(
            scope.userId,
            grant.agentId,
            resetScope === 'tool' ? grant.toolName : undefined,
          );
          const status = (await storage.getToolApprovalGrants(scope, [pending]))[0];
          const renewed = { ...pending, revocation: status.revocation };
          await storage.rememberToolApprovalGrants(scope, [renewed]);
          pause.resume();
          await staleWrite;
          expect((await storage.getToolApprovalGrants(scope, [renewed]))[0].approved).toBe(true);
        } finally {
          pause.resume();
          await staleWrite;
          pause.restore();
        }
      },
    );
  }
}

for (const mode of ['chat', 'always'] as const) {
  test(`${mode} storage refuses an OAuth epoch already replaced before persistence`, async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const current = { ...scope, userId };
    const old = { ...grant, scope: mode, serverName: 'db', oauthEpoch: 'account-a' };
    const token = await mongoose.models.Token.create({
      userId,
      type: 'mcp_oauth',
      identifier: 'mcp:db',
      token: 'synthetic-a',
      expiresAt: new Date(Date.now() + 60000),
      metadata: { credential_set_id: 'account-a' },
    });
    try {
      await storage.rememberToolApprovalGrants(current, [old]);
      await mongoose.models.Token.updateOne(
        { _id: token._id },
        { $set: { 'metadata.credential_set_id': 'account-b' } },
      );
      const renewed = { ...old, oauthEpoch: 'account-b' };
      await storage.rememberToolApprovalGrants(current, [renewed]);
      await storage.rememberToolApprovalGrants(current, [old]);
      expect((await storage.getToolApprovalGrants(current, [renewed]))[0].approved).toBe(true);
    } finally {
      await mongoose.models.Token.deleteOne({ _id: token._id });
    }
  });

  test(`${mode} current OAuth consent can replace a changed tool binding`, async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const current = { ...scope, userId };
    const original = { ...grant, scope: mode, serverName: 'db', oauthEpoch: 'account-a' };
    const token = await mongoose.models.Token.create({
      userId,
      type: 'mcp_oauth',
      identifier: 'mcp:db',
      token: 'synthetic-a',
      expiresAt: new Date(Date.now() + 60000),
      metadata: { credential_set_id: 'account-a' },
    });
    try {
      await storage.rememberToolApprovalGrants(current, [original]);
      const changed = {
        ...original,
        binding: 'changed-tool-schema',
        consentBinding: original.binding,
      };
      await storage.rememberToolApprovalGrants(current, [changed]);
      expect((await storage.getToolApprovalGrants(current, [changed]))[0].approved).toBe(true);
      expect((await storage.getToolApprovalGrants(current, [original]))[0].approved).toBe(false);
    } finally {
      await mongoose.models.Token.deleteOne({ _id: token._id });
    }
  });

  for (const initialEpoch of ['account-a', null]) {
    test.each([false, true])(
      `${mode} delayed OAuth write cannot clobber account B; initial=${initialEpoch}, first grant=%s`,
      async (firstGrant) => {
        const userId = new mongoose.Types.ObjectId().toString();
        const current = { ...scope, userId };
        const old = { ...grant, scope: mode, serverName: 'db', oauthEpoch: initialEpoch };
        const tokenData = {
          userId,
          type: 'mcp_oauth',
          identifier: 'mcp:db',
          token: 'synthetic-token',
          expiresAt: new Date(Date.now() + 60000),
        };
        if (initialEpoch)
          await mongoose.models.Token.create({
            ...tokenData,
            metadata: { credential_set_id: initialEpoch },
          });
        if (!firstGrant) await storage.rememberToolApprovalGrants(current, [old]);
        const pause = suspendGrantWrite();
        const stale = storage.rememberToolApprovalGrants(current, [old]);
        await pause.started;
        try {
          await mongoose.models.Token.deleteMany({ userId });
          await mongoose.models.Token.create({
            ...tokenData,
            metadata: { credential_set_id: 'account-b' },
          });
          const renewed = { ...old, oauthEpoch: 'account-b' };
          await storage.rememberToolApprovalGrants(current, [renewed]);
          pause.resume();
          await stale;
          const status = (await storage.getToolApprovalGrants(current, [renewed]))[0];
          expect(status.approved).toBe(true);
          expect(status).not.toHaveProperty('previousOAuthEpoch');
          expect(JSON.stringify(status)).not.toContain('synthetic-token');
        } finally {
          pause.resume();
          await stale;
          pause.restore();
          await mongoose.models.Token.deleteMany({ userId });
        }
      },
    );
  }
}

for (const mode of ['chat', 'always'] as const) {
  test.each(['connection', 'schema', 'revision'])(
    `${mode} late completion cannot replace renewed %s consent`,
    async (change) => {
      const original = { ...grant, scope: mode };
      await storage.rememberToolApprovalGrants(scope, [original]);
      const snapshot = (await storage.getToolApprovalGrants(scope, [original]))[0];
      const oldExecution = { ...original, consentBinding: snapshot.consentBinding };
      const replacement = {
        ...original,
        binding: `replacement-${change}`,
        consentBinding: snapshot.consentBinding,
      };
      await storage.rememberToolApprovalGrants(scope, [replacement]);
      await storage.rememberToolApprovalGrants(scope, [oldExecution]);
      expect(
        (await storage.getToolApprovalGrants(scope, [original, replacement])).map(
          (status) => status.approved,
        ),
      ).toEqual([false, true]);
    },
  );

  test.each([false, true])(
    `${mode} binding replacement between read and write wins; first grant=%s`,
    async (firstGrant) => {
      const original = { ...grant, scope: mode };
      if (!firstGrant) await storage.rememberToolApprovalGrants(scope, [original]);
      const snapshot = (await storage.getToolApprovalGrants(scope, [original]))[0];
      const captured = { ...original, consentBinding: snapshot.consentBinding };
      const pause = suspendGrantWrite();
      const oldWrite = storage.rememberToolApprovalGrants(scope, [captured]);
      await pause.started;
      try {
        const replacement = { ...captured, binding: 'new-current-authority' };
        await storage.rememberToolApprovalGrants(scope, [replacement]);
        pause.resume();
        await oldWrite;
        expect(
          (await storage.getToolApprovalGrants(scope, [original, replacement])).map(
            (status) => status.approved,
          ),
        ).toEqual([false, true]);
      } finally {
        pause.resume();
        await oldWrite;
        pause.restore();
      }
    },
  );

  test(`${mode} reviewed replacement can supersede a previous binding and parallel repeats remain idempotent`, async () => {
    const original = { ...grant, scope: mode };
    await storage.rememberToolApprovalGrants(scope, [original]);
    const snapshot = (await storage.getToolApprovalGrants(scope, [original]))[0];
    const replacement = {
      ...original,
      binding: 'reviewed-new-authority',
      consentBinding: snapshot.consentBinding,
    };
    await Promise.all(
      Array.from({ length: 4 }, () => storage.rememberToolApprovalGrants(scope, [replacement])),
    );
    expect((await storage.getToolApprovalGrants(scope, [replacement]))[0].approved).toBe(true);
    expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(1);
  });
}

test('non-OAuth authority ignores retained OAuth epochs without querying token records', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  const current = { userId, conversationId: 'api-key-chat' };
  const token = await mongoose.models.Token.create({
    userId,
    type: 'mcp_oauth',
    identifier: 'mcp:db',
    token: 'synthetic-retained-token',
    expiresAt: new Date(Date.now() + 60000),
    metadata: { credential_set_id: 'old-oauth-account' },
  });
  const apiKey = {
    ...grant,
    serverName: 'db',
    authKind: 'other' as const,
    oauthEpoch: null,
    binding: 'current-api-key-authority',
  };
  const find = jest.spyOn(mongoose.models.Token, 'find');
  try {
    await storage.rememberToolApprovalGrants(current, [apiKey]);
    const status = (await storage.getToolApprovalGrants(current, [apiKey]))[0];
    expect(status.oauthEpoch).toBeNull();
    expect(status.approved).toBe(true);
    expect(find).not.toHaveBeenCalled();
  } finally {
    find.mockRestore();
    await mongoose.models.Token.deleteOne({ _id: token._id });
  }
});

test('batched OAuth and API-key tools on the same server resolve distinct effective epochs', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  const current = { ...scope, userId };
  const token = await mongoose.models.Token.create({
    userId,
    type: 'mcp_oauth',
    identifier: 'mcp:db',
    token: 'synthetic-token',
    expiresAt: new Date(Date.now() + 60000),
    metadata: { credential_set_id: 'account-a' },
  });
  const oauth = { ...grant, serverName: 'db', authKind: 'oauth' as const, oauthEpoch: 'account-a' };
  const apiKey = {
    ...grant,
    serverName: 'db',
    authKind: 'other' as const,
    oauthEpoch: null,
    toolName: 'key_mcp_db',
    instanceName: 'key_mcp_db',
    binding: 'key-authority',
  };
  try {
    await storage.rememberToolApprovalGrants(current, [oauth, apiKey]);
    expect(
      (await storage.getToolApprovalGrants(current, [oauth, apiKey])).map((status) => [
        status.oauthEpoch,
        status.approved,
      ]),
    ).toEqual([
      ['account-a', true],
      [null, true],
    ]);
    await mongoose.models.Token.updateOne(
      { _id: token._id },
      { $set: { 'metadata.credential_set_id': 'account-b' } },
    );
    expect(
      (await storage.getToolApprovalGrants(current, [oauth, apiKey])).map(
        (status) => status.approved,
      ),
    ).toEqual([false, true]);
  } finally {
    await mongoose.models.Token.deleteOne({ _id: token._id });
  }
});
