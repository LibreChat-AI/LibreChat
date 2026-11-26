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
let getBranchLinks: ReturnType<typeof createMessageMethods>['getBranchLinks'];

const user = 'user-1';
const conversationId = 'convo-1';
const root = '00000000-0000-0000-0000-000000000000';
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
  getBranchLinks = createMessageMethods(mongoose).getBranchLinks;
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await Message.deleteMany({});
});

describe('getBranchLinks', () => {
  it('returns the link fields of every message on every branch', async () => {
    await Message.insertMany([
      turn('u1', root, true, high),
      turn('a1', 'u1', false),
      turn('u2', 'a1', true, low),
      turn('a2', 'u2', false),
      turn('u2b', 'a1', true),
      turn('a2b', 'u2b', false),
    ]);

    const rows = await getBranchLinks({ user, conversationId });

    expect(rows.map((row) => row.messageId).sort()).toEqual(['a1', 'a2', 'a2b', 'u1', 'u2', 'u2b']);
    expect(rows.find((row) => row.messageId === 'u2')).toEqual({
      messageId: 'u2',
      parentMessageId: 'a1',
      isCreatedByUser: true,
      reasoningOverride: low,
    });
  });

  it('projects to the link fields: no id, text or ownership leaves the read', async () => {
    await Message.insertMany([turn('u1', root, true), turn('a1', 'u1', false)]);

    const rows = await getBranchLinks({ user, conversationId });

    expect(rows.find((row) => row.messageId === 'a1')).toEqual({
      messageId: 'a1',
      parentMessageId: 'u1',
      isCreatedByUser: false,
    });
  });

  it('answers with a single read of the conversation', async () => {
    await Message.insertMany([
      turn('u1', root, true, high),
      turn('a1', 'u1', false),
      turn('u2', 'a1', true),
      turn('a2', 'u2', false),
    ]);
    const find = jest.spyOn(Message, 'find');

    await getBranchLinks({ user, conversationId });

    expect(find).toHaveBeenCalledTimes(1);
    find.mockRestore();
  });

  it("does not read another user's messages", async () => {
    await Message.insertMany([
      { ...turn('u1', root, true, high), user: 'user-2' },
      { ...turn('a1', 'u1', false), user: 'user-2' },
    ]);

    await expect(getBranchLinks({ user, conversationId })).resolves.toEqual([]);
  });

  it("does not read another conversation's messages", async () => {
    await Message.insertMany([
      turn('u1', root, true),
      { ...turn('u9', root, true), conversationId: 'convo-2' },
    ]);

    const rows = await getBranchLinks({ user, conversationId });

    expect(rows.map((row) => row.messageId)).toEqual(['u1']);
  });
});
