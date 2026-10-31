import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { ChannelReplyMapping } from 'librechat-data-provider';
import type { ChannelFeedbackLedger, ChannelFeedbackEventRecord } from '~/models/channelFeedback';
import { createChannelFeedbackStorage, ChannelFeedbackAuthorityError } from './channelFeedback';
import { closeResponseScopes, eraseResponseRecords } from './responseScope';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { createModels } from '~/models';
import { createMethods } from './index';

let mongo: MongoMemoryReplSet;
let db: ReturnType<typeof createMethods>;
let storage: ReturnType<typeof createChannelFeedbackStorage>;
const tenantId = 'feedback-fence-tenant';
const userId = new mongoose.Types.ObjectId().toString();
const otherUserId = new mongoose.Types.ObjectId().toString();
const scope = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId }, work);
const mapping: ChannelReplyMapping = {
  tenantId,
  channelId: 'channel',
  channelRevision: 'v1',
  teamId: 'T1',
  agentId: 'agent',
  externalMessageKey: 'C1:reply',
  runId: 'run',
  responseId: 'response',
  messageId: 'response',
  conversationId: 'conversation',
  principalId: userId,
  traceId: 'trace',
  sampled: true,
  destinationIds: ['destination'],
  centralTraceExportEnabled: false,
};
const ledger = (source = mapping): ChannelFeedbackLedger => ({
  tenantId: source.tenantId,
  key: source.runId,
  mapping: source,
  externalUserId: 'U1',
  scoreId: `feedback-${source.runId}`,
  votes: [],
  revision: 0,
  rating: null,
  exportStatus: 'pending',
  retryAtMs: 0,
});
const event = (source = mapping): ChannelFeedbackEventRecord => ({
  tenantId: source.tenantId,
  channelId: source.channelId,
  eventId: source.runId,
  digest: source.runId,
  ledgerKey: source.runId,
  mapping: source,
  rating: 'thumbsUp',
  processed: false,
  event: {
    eventId: source.runId,
    eventTimestampUs: 1,
    externalMessageKey: source.externalMessageKey,
    externalUserId: 'U1',
    reaction: 'thumbsup',
    action: 'added',
  },
});
async function message(source = mapping) {
  return mongoose.models.Message.create({
    tenantId: source.tenantId === '_' ? undefined : source.tenantId,
    user: source.principalId,
    conversationId: source.conversationId,
    messageId: source.messageId,
    isCreatedByUser: false,
    sender: 'Agent',
    endpoint: 'agents',
    model: source.agentId,
    text: 'retained answer',
  });
}
async function persist(source = mapping) {
  await storage.putChannelReply(source);
  await storage.admitChannelFeedbackEvent(event(source));
  await storage.ensureChannelFeedback(ledger(source));
}
async function assertEmpty(source = mapping) {
  expect(
    await mongoose.models.ChannelReply.countDocuments({
      tenantId: source.tenantId,
      principalId: source.principalId,
      conversationId: source.conversationId,
    }),
  ).toBe(0);
  for (const name of ['ChannelFeedbackEvent', 'ChannelFeedback'])
    expect(
      await mongoose.models[name].countDocuments({
        tenantId: source.tenantId,
        'mapping.principalId': source.principalId,
        'mapping.conversationId': source.conversationId,
      }),
    ).toBe(0);
}
async function assertRetired(source = mapping) {
  await expect(storage.putChannelReply(source)).rejects.toBeInstanceOf(
    ChannelFeedbackAuthorityError,
  );
  await expect(storage.admitChannelFeedbackEvent(event(source))).rejects.toBeInstanceOf(
    ChannelFeedbackAuthorityError,
  );
  await expect(storage.ensureChannelFeedback(ledger(source))).rejects.toBeInstanceOf(
    ChannelFeedbackAuthorityError,
  );
  expect(await storage.isAuthorityCurrent(source)).toBe(false);
  await assertEmpty(source);
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ['--nounixsocket'] }],
  });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  db = createMethods(mongoose);
  storage = createChannelFeedbackStorage(mongoose);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(() =>
    Promise.all(
      [
        'User',
        'Message',
        'StoredResponse',
        'ResponseScope',
        'AgentChannel',
        'ChannelScope',
        'ChannelRun',
        'ChannelLane',
        'ChannelIdentity',
        'ChannelReply',
        'ChannelFeedbackEvent',
        'ChannelFeedback',
        'AgentApiKey',
      ].map((name) => mongoose.models[name].deleteMany({})),
    ),
  );
  await scope(async () => {
    await mongoose.models.User.create([
      { _id: userId, tenantId, email: 'feedback-owner@example.test' },
      { _id: otherUserId, tenantId, email: 'feedback-other@example.test' },
    ]);
    await db.createAgentChannel({
      tenantId,
      channelId: mapping.channelId,
      agentId: mapping.agentId,
      revision: mapping.channelRevision,
      createdBy: userId,
      type: 'slack',
      status: 'active',
      credentialMode: 'shared',
      slack: { teamId: mapping.teamId, appId: 'A1', botUserId: 'BOT' },
    });
    await message();
  });
});

it('erases all owner feedback and rejects delayed standalone writes after actual account deletion', () =>
  scope(async () => {
    await persist();
    expect(await storage.isAuthorityCurrent(mapping)).toBe(true);
    expect((await db.deleteUserById(userId)).deletedCount).toBe(1);
    await assertRetired();
    expect(await mongoose.models.User.exists({ _id: otherUserId })).not.toBeNull();
  }));

it('closes one conversation without erasing or blocking another conversation', () =>
  scope(async () => {
    const other = {
      ...mapping,
      conversationId: 'other-conversation',
      responseId: 'other-response',
      messageId: 'other-response',
      runId: 'other-run',
      externalMessageKey: 'C1:other',
    };
    await message(other);
    await persist();
    await persist(other);
    await closeResponseScopes(mongoose, { userId, tenantId }, [mapping.conversationId]);
    await eraseResponseRecords(mongoose, { userId, tenantId }, [mapping.conversationId]);
    await assertRetired();
    expect(await storage.isAuthorityCurrent(other)).toBe(true);
    expect(await storage.getChannelFeedback(tenantId, other.runId)).not.toBeNull();
  }));

it('erases other principals feedback when the owning channel creator is deleted', () =>
  scope(async () => {
    const other = { ...mapping, principalId: otherUserId };
    await mongoose.models.Message.deleteMany({ user: userId });
    await message(other);
    await persist(other);
    await db.deleteUserById(userId);
    await assertRetired(other);
    expect(await mongoose.models.User.exists({ _id: otherUserId })).not.toBeNull();
  }));

it('deletes channel feedback only after closing its canonical admission fence', () =>
  scope(async () => {
    await persist();
    expect(await db.deleteAgentChannel(mapping.channelId, userId)).toEqual({ status: 'deleted' });
    await assertRetired();
  }));

it('serializes accepted projection against erasure and cannot recreate data on a delayed retry', () =>
  scope(async () => {
    await storage.putChannelReply(mapping);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = storage.withAuthority(mapping, async (active) => {
      await active.ensureChannelFeedback(ledger());
      enter();
      await gate;
      await active.admitChannelFeedbackEvent(event());
    });
    await entered;
    const erase = (async () => {
      await closeResponseScopes(mongoose, { userId, tenantId }, [mapping.conversationId]);
      await eraseResponseRecords(mongoose, { userId, tenantId }, [mapping.conversationId]);
    })();
    release();
    await write;
    await erase;
    expect(await storage.isAuthorityCurrent(mapping)).toBe(false);
    await assertRetired();
  }));

it('rolls back a projection whose retained message expires before transaction completion', () =>
  scope(async () => {
    const expiresAt = Date.now() + 60000;
    await mongoose.models.Message.updateOne(
      { messageId: mapping.messageId, user: userId },
      { $set: { expiredAt: new Date(expiresAt) } },
    );
    let clock: jest.SpyInstance | undefined;
    try {
      await expect(
        storage.withAuthority(mapping, async (active) => {
          await active.ensureChannelFeedback(ledger());
          clock = jest.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
        }),
      ).rejects.toBeInstanceOf(ChannelFeedbackAuthorityError);
    } finally {
      clock?.mockRestore();
    }
    expect(await storage.getChannelFeedback(tenantId, mapping.runId)).toBeNull();
  }));

it('supports the default application tenant while keeping explicit private partitions', async () =>
  tenantStorage.run({ tenantId: undefined }, async () => {
    const defaultUserId = new mongoose.Types.ObjectId().toString();
    await mongoose.models.User.create({
      _id: defaultUserId,
      email: 'default-feedback@example.test',
    });
    const source = {
      ...mapping,
      principalId: defaultUserId,
      tenantId: '_',
      channelId: 'default-channel',
      conversationId: 'default-conversation',
    };
    await db.createAgentChannel({
      channelId: source.channelId,
      agentId: source.agentId,
      revision: source.channelRevision,
      createdBy: source.principalId,
      type: 'slack',
      status: 'active',
      credentialMode: 'shared',
      slack: { teamId: source.teamId, appId: 'A1', botUserId: 'BOT' },
    });
    await message(source);
    await persist(source);
    expect(await storage.isAuthorityCurrent(source)).toBe(true);
    await closeResponseScopes(mongoose, { userId: source.principalId }, [source.conversationId]);
    await eraseResponseRecords(mongoose, { userId: source.principalId }, [source.conversationId]);
    await assertRetired(source);
  }));

it('propagates database outages and rejects foreign tenant context without claiming absence', () =>
  scope(async () => {
    await expect(
      tenantStorage.run({ tenantId: 'other' }, () => storage.putChannelReply(mapping)),
    ).rejects.toThrow('authenticated scope');
    const outage = jest.spyOn(mongoose.models.Message, 'findOne').mockImplementationOnce(() => {
      throw new Error('message store unavailable');
    });
    try {
      await expect(storage.putChannelReply(mapping)).rejects.toThrow('message store unavailable');
    } finally {
      outage.mockRestore();
    }
  }));

it('rebuilds canonical votes without merging skin tones and uses the latest event on ties', () =>
  scope(async () => {
    const inputs = [
      { id: 'base-a-add', reaction: '+1', action: 'added', at: 20 },
      { id: 'base-z-remove', reaction: 'thumbsup', action: 'removed', at: 20 },
      { id: 'tone-two', reaction: '+1::skin-tone-2', action: 'added', at: 30 },
      { id: 'tone-three', reaction: 'thumbsup::skin-tone-3', action: 'added', at: 40 },
      { id: 'down', reaction: '-1', action: 'added', at: 50 },
    ] as const;
    for (const input of inputs) {
      const record = event();
      await storage.admitChannelFeedbackEvent({
        ...record,
        eventId: input.id,
        digest: input.id,
        rating: input.reaction === '-1' ? 'thumbsDown' : 'thumbsUp',
        event: {
          ...record.event,
          eventId: input.id,
          reaction: input.reaction,
          action: input.action,
          eventTimestampUs: input.at,
        },
      });
    }
    const ids = inputs.map((input) => input.id);
    const votes = await storage.rebuildVotes(tenantId, mapping.runId, ids);
    expect(votes).toHaveLength(4);
    expect(votes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reaction: 'thumbsup', active: false, eventId: 'base-z-remove' }),
        expect.objectContaining({ reaction: 'thumbsup::skin-tone-2', active: true }),
        expect.objectContaining({ reaction: 'thumbsup::skin-tone-3', active: true }),
        expect.objectContaining({ reaction: 'thumbsdown', rating: 'thumbsDown', active: true }),
      ]),
    );
    expect(await storage.rebuildVotes(tenantId, mapping.runId, [...ids, 'missing'])).toBeNull();
  }));

it('erases imported-conversation feedback while preserving another owner in that conversation', () =>
  scope(async () => {
    const other = {
      ...mapping,
      principalId: otherUserId,
      responseId: 'other-response',
      messageId: 'other-response',
      runId: 'other-run',
      externalMessageKey: 'C1:other-owner',
    };
    await message(other);
    await persist();
    await persist(other);
    await db.deleteImportedConversations({
      user: userId,
      tenantId,
      conversationIds: [mapping.conversationId],
    });
    await assertRetired();
    expect(await storage.isAuthorityCurrent(other)).toBe(true);
    expect(await storage.getChannelFeedback(tenantId, other.runId)).not.toBeNull();
  }));
