import mongoose from 'mongoose';
import { EModelEndpoint } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import { resolveStoredResponse } from './storage';

const conversationId = '10000000-0000-4000-8000-000000000001';
const owner = 'owner-user';

let mongod: MongoMemoryServer;
let db: ReturnType<typeof createMethods>;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongod.getUri());
  createModels(mongoose);
  db = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

it('stores a response under an independent message ID and admits it only after the conversation commit', async () => {
  const context = { userId: owner };
  const input = await db.saveMessage(context, {
    messageId: 'input-one',
    conversationId,
    isCreatedByUser: true,
    text: 'first',
    sender: 'User',
    endpoint: EModelEndpoint.agents,
  });
  expect(input).toBeTruthy();
  const pending = await db.saveMessage(context, {
    messageId: 'resp_one',
    conversationId,
    isCreatedByUser: false,
    text: 'first answer',
    sender: 'Agent',
    endpoint: EModelEndpoint.agents,
    finish_reason: 'pending_storage',
  });
  expect(pending).toBeTruthy();
  expect(await resolveStoredResponse(owner, 'resp_one', db)).toBeNull();

  const conversation = await db.saveConvo(context, {
    conversationId,
    agent_id: 'agent-one',
    endpoint: EModelEndpoint.agents,
  });
  expect(conversation).toBeTruthy();
  expect((await db.getConvo(owner, conversationId))?.messages).toHaveLength(2);
  expect(await resolveStoredResponse(owner, 'resp_one', db)).toBeNull();

  await db.updateMessage(owner, { messageId: 'resp_one', finish_reason: 'stop' });
  const stored = await resolveStoredResponse(owner, 'resp_one', db);
  expect(stored?.conversation.conversationId).toBe(conversationId);
  expect(stored?.message?.text).toBe('first answer');
  expect(await resolveStoredResponse('another-user', 'resp_one', db)).toBeNull();
  expect(await resolveStoredResponse(owner, 'resp_missing', db)).toBeNull();

  await db.saveMessage(context, {
    messageId: 'resp_failed',
    conversationId,
    isCreatedByUser: false,
    text: 'uncommitted',
    sender: 'Agent',
    endpoint: EModelEndpoint.agents,
    finish_reason: 'pending_storage',
  });
  expect(await resolveStoredResponse(owner, 'resp_failed', db)).toBeNull();
});
