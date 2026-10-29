import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createAgentApiKeyMethods } from './agentApiKey';
import { createModels } from '~/models';
import { hashToken } from '~/crypto';

let server: MongoMemoryServer;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  createModels(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

it('preserves ordinary key issuance and the legacy hash on standalone MongoDB', async () => {
  const methods = createAgentApiKeyMethods(mongoose);
  const userId = new mongoose.Types.ObjectId();
  const created = await methods.createAgentApiKey({ userId, name: 'ordinary' });
  expect(await methods.validateAgentApiKey(created.key)).toMatchObject({ userId });
  expect(
    await mongoose.models.AgentApiKey.findOne({ keyHash: await hashToken(created.key) }).lean(),
  ).not.toBeNull();
});
