import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ToolApprovalGrantBinding } from 'librechat-data-provider';
import { createToolApprovalGrantModel } from '../models/toolApprovalGrant';
import { createToolApprovalGrantMethods } from './toolApprovalGrant';
import { tenantStorage } from '~/config/tenantContext';

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

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
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

test('resetting an unknown tool does not create arbitrary records', async () => {
  await storage.resetToolApprovalGrants(scope.userId, 'unknown-agent', 'unknown-tool');
  expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(0);
});
