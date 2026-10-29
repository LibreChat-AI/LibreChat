import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IMessage } from '~/types';
import { createMessageMethods } from './message';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let Message: mongoose.Model<IMessage>;
let getBranchReasoningOverride: ReturnType<
  typeof createMessageMethods
>['getBranchReasoningOverride'];

const user = 'user-1';
const conversationId = 'convo-1';
const high = { key: 'reasoning_effort', value: 'high' } as NonNullable<
  IMessage['reasoningOverride']
>;
const low = { key: 'reasoning_effort', value: 'low' } as NonNullable<IMessage['reasoningOverride']>;

const turn = (
  messageId: string,
  parentMessageId: string,
  isCreatedByUser: boolean,
  reasoningOverride?: IMessage['reasoningOverride'],
) => ({
  messageId,
  parentMessageId,
  conversationId,
  user,
  isCreatedByUser,
  text: messageId,
  ...(reasoningOverride != null && { reasoningOverride }),
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  Object.assign(mongoose.models, createModels(mongoose));
  Message = mongoose.models.Message;
  getBranchReasoningOverride = createMessageMethods(mongoose).getBranchReasoningOverride;
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Message.deleteMany({});
});

describe('getBranchReasoningOverride', () => {
  it('returns the level of the nearest user message on the branch that carries one', async () => {
    await Message.insertMany([
      turn('u1', '00000000-0000-0000-0000-000000000000', true, high),
      turn('a1', 'u1', false),
      turn('u2', 'a1', true),
      turn('a2', 'u2', false),
    ]);

    await expect(
      getBranchReasoningOverride({ user, conversationId, parentMessageId: 'a2' }),
    ).resolves.toEqual(high);
  });

  it('follows the branch, not the newest message in the conversation', async () => {
    await Message.insertMany([
      turn('u1', '00000000-0000-0000-0000-000000000000', true, high),
      turn('a1', 'u1', false),
      turn('u2', 'a1', true, low),
      turn('a2', 'u2', false),
      turn('u2b', 'a1', true),
      turn('a2b', 'u2b', false),
    ]);

    await expect(
      getBranchReasoningOverride({ user, conversationId, parentMessageId: 'a2b' }),
    ).resolves.toEqual(high);
  });

  it('returns null when no user message on the branch carries a level', async () => {
    await Message.insertMany([
      turn('u1', '00000000-0000-0000-0000-000000000000', true),
      turn('a1', 'u1', false),
    ]);

    await expect(
      getBranchReasoningOverride({ user, conversationId, parentMessageId: 'a1' }),
    ).resolves.toBeNull();
  });

  it('answers with a single read of the conversation', async () => {
    await Message.insertMany([
      turn('u1', '00000000-0000-0000-0000-000000000000', true, high),
      turn('a1', 'u1', false),
      turn('u2', 'a1', true),
      turn('a2', 'u2', false),
    ]);
    const find = jest.spyOn(Message, 'find');

    await getBranchReasoningOverride({ user, conversationId, parentMessageId: 'a2' });

    expect(find).toHaveBeenCalledTimes(1);
    find.mockRestore();
  });

  it("does not read another user's messages", async () => {
    await Message.insertMany([
      { ...turn('u1', '00000000-0000-0000-0000-000000000000', true, high), user: 'user-2' },
      { ...turn('a1', 'u1', false), user: 'user-2' },
    ]);

    await expect(
      getBranchReasoningOverride({ user, conversationId, parentMessageId: 'a1' }),
    ).resolves.toBeNull();
  });
});
