import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IConversation } from '..';
import type { IConversationTag } from '~/schema/conversationTag';
import { createConversationTagMethods, decrementTagCounts } from './conversationTag';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let ConversationTag: mongoose.Model<IConversationTag>;
let Conversation: mongoose.Model<IConversation>;
let deleteConversationTag: ReturnType<typeof createConversationTagMethods>['deleteConversationTag'];

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();

  // Register models
  const models = createModels(mongoose);
  Object.assign(mongoose.models, models);

  ConversationTag = mongoose.models.ConversationTag;
  Conversation = mongoose.models.Conversation;

  // Create methods from factory
  const methods = createConversationTagMethods(mongoose);
  deleteConversationTag = methods.deleteConversationTag;

  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await ConversationTag.deleteMany({});
  await Conversation.deleteMany({});
});

describe('ConversationTag model - $pullAll operations', () => {
  const userId = new mongoose.Types.ObjectId().toString();

  describe('deleteConversationTag', () => {
    it('should remove the tag from all conversations that have it', async () => {
      await ConversationTag.create({ tag: 'work', user: userId, position: 1 });

      await Conversation.create([
        { conversationId: 'conv1', user: userId, endpoint: 'openAI', tags: ['work', 'important'] },
        { conversationId: 'conv2', user: userId, endpoint: 'openAI', tags: ['work'] },
        { conversationId: 'conv3', user: userId, endpoint: 'openAI', tags: ['personal'] },
      ]);

      await deleteConversationTag(userId, 'work');

      const convos = await Conversation.find({ user: userId }).sort({ conversationId: 1 }).lean();
      expect(convos[0].tags).toEqual(['important']);
      expect(convos[1].tags).toEqual([]);
      expect(convos[2].tags).toEqual(['personal']);
    });

    it('should delete the tag document itself', async () => {
      await ConversationTag.create({ tag: 'temp', user: userId, position: 1 });

      const result = await deleteConversationTag(userId, 'temp');

      expect(result).toBeDefined();
      expect(result!.tag).toBe('temp');

      const remaining = await ConversationTag.find({ user: userId }).lean();
      expect(remaining).toHaveLength(0);
    });

    it('should return null when the tag does not exist', async () => {
      const result = await deleteConversationTag(userId, 'nonexistent');
      expect(result).toBeNull();
    });

    it('should adjust positions of tags after the deleted one', async () => {
      await ConversationTag.create([
        { tag: 'first', user: userId, position: 1 },
        { tag: 'second', user: userId, position: 2 },
        { tag: 'third', user: userId, position: 3 },
      ]);

      await deleteConversationTag(userId, 'first');

      const tags = await ConversationTag.find({ user: userId }).sort({ position: 1 }).lean();
      expect(tags).toHaveLength(2);
      expect(tags[0].tag).toBe('second');
      expect(tags[0].position).toBe(1);
      expect(tags[1].tag).toBe('third');
      expect(tags[1].position).toBe(2);
    });

    it('should not affect conversations of other users', async () => {
      const otherUser = new mongoose.Types.ObjectId().toString();

      await ConversationTag.create({ tag: 'shared-name', user: userId, position: 1 });
      await ConversationTag.create({ tag: 'shared-name', user: otherUser, position: 1 });

      await Conversation.create([
        { conversationId: 'mine', user: userId, endpoint: 'openAI', tags: ['shared-name'] },
        { conversationId: 'theirs', user: otherUser, endpoint: 'openAI', tags: ['shared-name'] },
      ]);

      await deleteConversationTag(userId, 'shared-name');

      const myConvo = await Conversation.findOne({ conversationId: 'mine' }).lean();
      const theirConvo = await Conversation.findOne({ conversationId: 'theirs' }).lean();

      expect(myConvo?.tags).toEqual([]);
      expect(theirConvo?.tags).toEqual(['shared-name']);
    });

    it('should handle duplicate tags in conversations correctly', async () => {
      await ConversationTag.create({ tag: 'dup', user: userId, position: 1 });

      const conv = await Conversation.create({
        conversationId: 'conv-dup',
        user: userId,
        endpoint: 'openAI',
        tags: ['dup', 'other', 'dup'],
      });

      await deleteConversationTag(userId, 'dup');

      const updated = await Conversation.findById(conv._id).lean();
      expect(updated?.tags).toEqual(['other']);
    });
  });
});

describe('decrementTagCounts', () => {
  const userId = new mongoose.Types.ObjectId().toString();

  const readCount = async (tag: string, user: string = userId) =>
    (await ConversationTag.findOne({ user, tag }).lean())?.count;

  it('decrements once per tag occurrence', async () => {
    await ConversationTag.create({ tag: 'work', user: userId, position: 1, count: 5 });

    await decrementTagCounts(mongoose, userId, ['work', 'work']);

    expect(await readCount('work')).toBe(3);
  });

  it('decrements an exact count down to zero', async () => {
    await ConversationTag.create({ tag: 'work', user: userId, position: 1, count: 2 });

    await decrementTagCounts(mongoose, userId, ['work', 'work']);

    expect(await readCount('work')).toBe(0);
  });

  it('clamps at zero when the decrement exceeds the current count', async () => {
    await ConversationTag.create({ tag: 'work', user: userId, position: 1, count: 1 });

    await decrementTagCounts(mongoose, userId, ['work', 'work', 'work']);

    expect(await readCount('work')).toBe(0);
  });

  it('leaves a zero count at zero', async () => {
    await ConversationTag.create({ tag: 'empty', user: userId, position: 1, count: 0 });

    await decrementTagCounts(mongoose, userId, ['empty']);

    expect(await readCount('empty')).toBe(0);
  });

  it('clamps pre-existing negative drift to zero', async () => {
    await ConversationTag.create({ tag: 'drift', user: userId, position: 1, count: -3 });

    await decrementTagCounts(mongoose, userId, ['drift']);

    expect(await readCount('drift')).toBe(0);
  });

  it('treats a missing count as zero', async () => {
    await ConversationTag.collection.insertOne({ tag: 'legacy', user: userId, position: 1 });

    await decrementTagCounts(mongoose, userId, ['legacy']);

    expect(await readCount('legacy')).toBe(0);
  });

  it('converges to zero under concurrent decrements exceeding the count', async () => {
    await ConversationTag.create({ tag: 'race', user: userId, position: 1, count: 3 });

    await Promise.all([
      decrementTagCounts(mongoose, userId, ['race', 'race']),
      decrementTagCounts(mongoose, userId, ['race', 'race']),
    ]);

    expect(await readCount('race')).toBe(0);
  });

  it("leaves other users' tags untouched", async () => {
    const otherUserId = new mongoose.Types.ObjectId().toString();
    await ConversationTag.create({ tag: 'work', user: userId, position: 1, count: 4 });
    await ConversationTag.create({ tag: 'work', user: otherUserId, position: 1, count: 4 });

    await decrementTagCounts(mongoose, userId, ['work']);

    expect(await readCount('work')).toBe(3);
    expect(await readCount('work', otherUserId)).toBe(4);
  });

  it('ignores empty and unknown tags without throwing', async () => {
    await expect(decrementTagCounts(mongoose, userId, ['', 'nonexistent'])).resolves.not.toThrow();
  });
});
