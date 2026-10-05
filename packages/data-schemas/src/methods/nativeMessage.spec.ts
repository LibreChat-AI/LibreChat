import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { FileContext } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { MediaOwnerScope } from '~/types/media';
import type { IMessage } from '~/types/message';
import { createMessageMethods, CLIENT_MESSAGE_SELECT } from './message';
import { createNativeMessageMethods } from './nativeMessage';
import { createModels } from '~/models';

describe('Message-owned native replay', () => {
  let mongo: MongoMemoryServer;
  const scope: MediaOwnerScope = {
    ownerId: new mongoose.Types.ObjectId().toString(),
    tenantId: null,
  };
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const fileId = randomUUID();
  const content = [
    { type: 'text', text: 'Signed caption', native_media: { continuationRef: `${messageId}:0` } },
    {
      type: 'image_file',
      image_file: { file_id: fileId },
      native_media: { continuationRef: `${messageId}:1` },
    },
  ];
  const metadata = {
    nativeSignatures: {
      '0': { text: 'Signed caption', thoughtSignature: 'text-secret' },
      '1': { mimeType: 'image/png', thoughtSignature: 'image-secret' },
    },
    usage: { total: 1 },
  };
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });
  beforeEach(async () => {
    await Promise.all([
      mongoose.models.Message.deleteMany({}),
      mongoose.models.File.deleteMany({}),
    ]);
    await mongoose.models.File.create({
      file_id: fileId,
      user: scope.ownerId,
      context: FileContext.image_generation,
      filename: 'image.png',
      filepath: '/images/owner/image.png',
      type: 'image/png',
      bytes: 20,
      source: 'local',
    });
    await createMessageMethods(mongoose).saveMessage(
      { userId: scope.ownerId },
      { messageId, conversationId, isCreatedByUser: false, content, metadata },
    );
  });
  const read = (owner = scope, conversation = conversationId) =>
    createNativeMessageMethods(mongoose).getNativeMessageParts({
      scope: owner,
      conversationId: conversation,
      references: [
        { continuationRef: `${messageId}:0` },
        { continuationRef: `${messageId}:1`, fileId },
      ],
      limit: 2,
    });
  it('loads ordered Message signatures and owned Files in one query each and hides metadata from clients', async () => {
    const messages = jest.spyOn(mongoose.models.Message, 'find');
    const files = jest.spyOn(mongoose.models.File, 'find');
    expect(await read()).toMatchObject([
      { kind: 'text', text: 'Signed caption', thoughtSignature: 'text-secret' },
      { kind: 'image', file: { file_id: fileId }, thoughtSignature: 'image-secret' },
    ]);
    expect(messages).toHaveBeenCalledTimes(1);
    expect(files).toHaveBeenCalledTimes(1);
    messages.mockRestore();
    files.mockRestore();
    const publicMessage = await mongoose.models.Message.findOne({ messageId })
      .select(CLIENT_MESSAGE_SELECT)
      .lean<Pick<IMessage, 'metadata'>>();
    expect(publicMessage?.metadata).toEqual({ usage: { total: 1 } });
  });
  it('isolates both owner and tenant, validates File identity and expiry', async () => {
    expect(await read({ ...scope, ownerId: new mongoose.Types.ObjectId().toString() })).toEqual([
      null,
      null,
    ]);
    expect(await read({ ...scope, tenantId: 'another-tenant' })).toEqual([null, null]);
    await mongoose.models.File.updateOne({ file_id: fileId }, { $set: { expiredAt: new Date(0) } });
    expect(await read()).toMatchObject([{ kind: 'text' }, null]);
    await mongoose.models.Message.updateOne({ messageId }, { $set: { expiredAt: new Date(0) } });
    expect(await read()).toEqual([null, null]);
  });
  it('lets a saved fork carry replay metadata with its Message and ordinary File, without retainers', async () => {
    const fork = randomUUID();
    await createMessageMethods(mongoose).bulkSaveMessages([
      {
        user: scope.ownerId,
        conversationId: fork,
        messageId: randomUUID(),
        isCreatedByUser: false,
        content,
        metadata,
      },
    ]);
    await createMessageMethods(mongoose).deleteMessages({ user: scope.ownerId, conversationId });
    expect(await read(scope, fork)).toMatchObject([{ kind: 'text' }, { kind: 'image' }]);
    expect(await mongoose.models.MediaJob.countDocuments()).toBe(0);
  });
  it('atomically removes only the edited signature in the existing Message update', async () => {
    const edited = [{ ...content[0], text: 'User edited caption' }, content[1]];
    await createMessageMethods(mongoose).updateMessage(scope.ownerId, {
      messageId,
      content: edited,
      userSubmittedPaths: ['/content/0/text'],
    });
    const stored = await mongoose.models.Message.findOne({ messageId }).lean<
      Pick<IMessage, 'metadata'>
    >();
    expect(stored?.metadata).toEqual({
      ...metadata,
      nativeSignatures: { '1': metadata.nativeSignatures['1'] },
    });
    expect(await read()).toMatchObject([null, { kind: 'image' }]);
  });
});
