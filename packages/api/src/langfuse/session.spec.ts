import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods, tenantStorage } from '@librechat/data-schemas';
import { getLangfuseDestinationId } from './destinations';
import { resolveLangfuseSession } from './session';

it('requires an owned server-authored sampled message for the shared session resolver', async () => {
  const savedEnv = { ...process.env };
  const mongo = await MongoMemoryServer.create();
  try {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://127.0.0.1:8788';
    process.env.LANGFUSE_TRACING_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED = 'false';
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'test=https://cloud.langfuse.com';
    process.env.LANGFUSE_SAMPLE_RATE = '1';
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    const db = createMethods(mongoose);
    await tenantStorage.run({ tenantId: 'tenant' }, async () => {
      await mongoose.models.Message.create({
        tenantId: 'tenant',
        user: 'owner',
        conversationId: 'conversation',
        messageId: 'response',
        isCreatedByUser: false,
        isUserSubmitted: true,
        langfuseSampled: true,
        langfuseDestinationIds: [getLangfuseDestinationId('https://cloud.langfuse.com', 'project')],
        text: 'Imported assistant-shaped text',
      });
      const resolve = () =>
        resolveLangfuseSession({
          config: { enabled: true, destination: 'test', projectId: 'project' },
          conversationId: 'conversation',
          userId: 'owner',
          getMessages: db.getMessages,
        });
      expect(await resolve()).toBeNull();
      await mongoose.models.Message.updateOne(
        { messageId: 'response' },
        { $set: { isUserSubmitted: false } },
      );
      expect(await resolve()).toMatchObject({
        url: 'https://cloud.langfuse.com/project/project/sessions/conversation',
      });
      await mongoose.models.Message.updateOne(
        { messageId: 'response' },
        { $set: { isCreatedByUser: true } },
      );
      expect(await resolve()).toBeNull();
      await mongoose.models.Message.updateOne(
        { messageId: 'response' },
        { $set: { isCreatedByUser: false }, $unset: { isUserSubmitted: '' } },
      );
      expect(await resolve()).not.toBeNull();
      await mongoose.models.Message.updateOne(
        { messageId: 'response' },
        { $set: { user: 'other-owner' } },
      );
      expect(await resolve()).toBeNull();
    });
  } finally {
    process.env = savedEnv;
    await mongoose.disconnect();
    await mongo.stop();
  }
}, 60000);
