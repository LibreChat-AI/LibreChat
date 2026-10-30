import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createModels,
  createMethods,
  createChannelFeedbackStorage,
  runAsSystem,
  tenantStorage,
} from '@librechat/data-schemas';
import type {
  ChannelFeedbackActor,
  ChannelReplyMapping,
  ChannelReactionEvent,
} from 'librechat-data-provider';
import type { ChannelFeedbackStorage } from '@librechat/data-schemas';
import type { ChannelFeedbackDependencies } from './feedback';
import { createChannelFeedbackService, normalizeChannelRating } from './feedback';

let mongo: MongoMemoryReplSet;
let service: ReturnType<typeof createChannelFeedbackService>;
let deps: ChannelFeedbackDependencies;
let clock: number;
let enabled: boolean;
const actor: ChannelFeedbackActor = {
  tenantId: 'tenant-a',
  channelId: 'channel-a',
  channelRevision: 'rev-a',
  teamId: 'T1',
  agentId: 'agent-a',
};
const mapping: ChannelReplyMapping = {
  ...actor,
  externalMessageKey: 'C1:123.456',
  runId: 'run-a',
  responseId: 'response-a',
  messageId: 'response-a',
  conversationId: 'conversation-a',
  principalId: 'user-a',
  traceId: 'trace-a',
  sampled: true,
  destinationIds: ['tenant-destination'],
  centralTraceExportEnabled: false,
};
const scoped = (test: () => Promise<void>) => () =>
  tenantStorage.run({ tenantId: actor.tenantId }, test);
const event = (
  id: string,
  time: number,
  overrides: Partial<ChannelReactionEvent> = {},
): ChannelReactionEvent => ({
  eventId: id,
  eventTimestampUs: time,
  externalMessageKey: mapping.externalMessageKey,
  externalUserId: 'U1',
  reaction: '+1',
  action: 'added',
  ...overrides,
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ['--nounixsocket'] }],
  });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  await Promise.all(
    ['ChannelReply', 'ChannelFeedback', 'ChannelFeedbackEvent'].map((name) =>
      mongoose.models[name].init(),
    ),
  );
}, 60_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(() =>
    Promise.all(
      [
        'ChannelReply',
        'ChannelFeedback',
        'ChannelFeedbackEvent',
        'AgentChannel',
        'ChannelScope',
        'ResponseScope',
        'Message',
      ].map((name) => mongoose.models[name].deleteMany({})),
    ),
  );
  await tenantStorage.run({ tenantId: actor.tenantId }, async () => {
    await createMethods(mongoose).createAgentChannel({
      tenantId: actor.tenantId,
      channelId: actor.channelId,
      agentId: actor.agentId,
      revision: actor.channelRevision,
      createdBy: mapping.principalId,
      type: 'slack',
      status: 'active',
      credentialMode: 'shared',
      slack: { teamId: actor.teamId, appId: 'A1', botUserId: 'BOT' },
    });
    await mongoose.models.Message.create({
      tenantId: actor.tenantId,
      user: mapping.principalId,
      messageId: mapping.messageId,
      conversationId: mapping.conversationId,
      isCreatedByUser: false,
      sender: 'Agent',
      endpoint: 'agents',
      model: actor.agentId,
      text: 'answer',
    });
  });
  clock = 1000;
  enabled = true;
  deps = {
    storage: createChannelFeedbackStorage(mongoose),
    canRecord: async () => enabled,
    resolveReply: async (_actor, key) => ({ ...mapping, externalMessageKey: key }),
    sendScore: jest.fn().mockResolvedValue(undefined),
    maxConflictRetries: 10,
    exportTimeoutMs: 500,
    exportLeaseMs: 1000,
    exportRetryMs: 2000,
    now: () => clock,
  };
  service = createChannelFeedbackService(deps);
  await tenantStorage.run({ tenantId: actor.tenantId }, () =>
    service.mapReply(actor, mapping.externalMessageKey),
  );
});

it(
  'normalizes supported ratings and ignores unrelated/status reactions without invoking an agent',
  scoped(async () => {
    expect(normalizeChannelRating('thumbsup::skin-tone-3')).toBe('thumbsUp');
    expect(normalizeChannelRating('-1')).toBe('thumbsDown');
    expect(
      await service.record(actor, event('decorative', 100, { reaction: 'hourglass' })),
    ).toMatchObject({ ok: true, value: { ignored: true } });
    expect(
      await mongoose.models.ChannelFeedbackEvent.countDocuments({ tenantId: actor.tenantId }),
    ).toBe(0);
  }),
);

it(
  'deduplicates concurrent receipts, rejects mutated retries and isolates actors and browser score IDs',
  scoped(async () => {
    await Promise.all([
      service.record(actor, event('e1', 100)),
      service.record(actor, event('e1', 100)),
    ]);
    expect(
      await mongoose.models.ChannelFeedbackEvent.countDocuments({ tenantId: actor.tenantId }),
    ).toBe(1);
    const ledger = (await deps.storage.pendingChannelFeedbackExports(actor.tenantId, clock, 10))[0];
    expect(ledger.revision).toBe(1);
    expect(await service.record(actor, event('e1', 101, { reaction: '-1' }))).toEqual({
      ok: false,
      error: { code: 'event_conflict' },
    });
    await service.record(actor, event('e2', 102, { externalUserId: 'U2', reaction: '-1' }));
    const records = await deps.storage.pendingChannelFeedbackExports(actor.tenantId, clock, 10);
    expect(new Set(records.map((record) => record.scoreId)).size).toBe(2);
    expect(
      records.every(
        (record) =>
          record.scoreId.startsWith('channel-feedback-') && !record.scoreId.includes('U1'),
      ),
    ).toBe(true);
    await service.flush(actor.tenantId, 10);
    expect(deps.sendScore).toHaveBeenCalledTimes(2);
    expect(deps.sendScore).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationIds: ['tenant-destination'],
        sampled: true,
        centralTraceExportEnabled: false,
      }),
      expect.objectContaining({ runId: mapping.runId, principalId: mapping.principalId }),
    );
  }),
);

it(
  'orders reactions per message so old removals and overflow chunks do not erase newer votes',
  scoped(async () => {
    await service.mapReply(actor, 'C1:123.457');
    await service.record(actor, event('e1', 100));
    await service.record(actor, event('e2', 200, { externalMessageKey: 'C1:123.457' }));
    expect(await service.record(actor, event('e3', 300, { action: 'removed' }))).toMatchObject({
      ok: true,
      value: { feedback: { rating: 'thumbsUp' } },
    });
    expect(
      await service.record(
        actor,
        event('old', 150, { action: 'removed', externalMessageKey: 'C1:123.457' }),
      ),
    ).toMatchObject({ ok: true, value: { feedback: { rating: 'thumbsUp' } } });
    expect(
      await service.record(
        actor,
        event('e4', 400, { action: 'removed', externalMessageKey: 'C1:123.457' }),
      ),
    ).toMatchObject({ ok: true, value: { feedback: null } });
  }),
);

it(
  'rejects stale revision, foreign mappings, unsafe timestamps and disabled feedback',
  scoped(async () => {
    expect(await service.record({ ...actor, channelRevision: 'stale' }, event('e1', 100))).toEqual({
      ok: false,
      error: { code: 'mapping_not_found' },
    });
    expect(
      await service.mapReply({ ...actor, teamId: 'other' }, mapping.externalMessageKey),
    ).toEqual({ ok: false, error: { code: 'mapping_not_found' } });
    expect(await service.record(actor, event('e2', Number.MAX_SAFE_INTEGER + 1))).toEqual({
      ok: false,
      error: { code: 'invalid_reaction' },
    });
    enabled = false;
    expect(await service.record(actor, event('e3', 100))).toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
  }),
);

it(
  'persists failed exports for retry and does not acknowledge a newer revision with an older send',
  scoped(async () => {
    await service.record(actor, event('e1', 100));
    jest.mocked(deps.sendScore).mockRejectedValueOnce(new Error('external service unavailable'));
    await expect(service.flush(actor.tenantId, 10)).rejects.toThrow('external service unavailable');
    expect(
      await deps.storage.pendingChannelFeedbackExports(actor.tenantId, clock, 10),
    ).toHaveLength(0);
    clock += 2001;
    jest.mocked(deps.sendScore).mockImplementationOnce(async () => {
      await service.record(actor, event('e2', 200, { reaction: '-1' }));
    });
    await service.flush(actor.tenantId, 10);
    const pending = await deps.storage.pendingChannelFeedbackExports(actor.tenantId, clock, 10);
    expect(pending).toHaveLength(1);
    expect(pending[0].rating).toBe('thumbsDown');
    await service.flush(actor.tenantId, 10);
    expect(
      await deps.storage.pendingChannelFeedbackExports(actor.tenantId, clock, 10),
    ).toHaveLength(0);
  }),
);

it(
  'recovers an admitted event after projection interruption using the same durable receipt',
  scoped(async () => {
    const original = deps.storage.withAuthority.bind(deps.storage);
    let interrupted = true;
    const scopedAuthority: ChannelFeedbackStorage['withAuthority'] = <T>(
      source: ChannelReplyMapping,
      work: (storage: ChannelFeedbackStorage) => Promise<T>,
    ): Promise<T> =>
      original(source, (active) => {
        if (!interrupted) return work(active);
        interrupted = false;
        return work({
          ...active,
          markChannelFeedbackEvent: async () => {
            throw new Error('database interrupted');
          },
        });
      });
    jest.spyOn(deps.storage, 'withAuthority').mockImplementation(scopedAuthority);
    await expect(service.record(actor, event('e1', 100))).rejects.toThrow('database interrupted');
    await service.recover(actor.tenantId, 10);
    expect(await deps.storage.pendingChannelFeedbackEvents(actor.tenantId, 10)).toHaveLength(0);
    expect(
      (await deps.storage.pendingChannelFeedbackExports(actor.tenantId, clock, 10))[0].revision,
    ).toBe(1);
  }),
);

it.each(['current', 'legacy'] as const)(
  'keeps distinct skin-tone slots and canonical aliases (%s)',
  (mode) =>
    tenantStorage.run({ tenantId: actor.tenantId }, async () => {
      await service.record(actor, event('tone-two', 100, { reaction: 'thumbsup::skin-tone-2' }));
      await service.record(actor, event('tone-three', 200, { reaction: 'thumbsup::skin-tone-3' }));
      if (mode === 'legacy') {
        const record = (
          await deps.storage.pendingChannelFeedbackExports(actor.tenantId, clock, 10)
        )[0];
        const { reaction: _identity, ...collapsed } = record.votes.find(
          (vote) => vote.eventId === 'tone-three',
        )!;
        await mongoose.models.ChannelFeedback.updateOne(
          { tenantId: actor.tenantId, key: record.key },
          { $set: { votes: [collapsed] } },
        );
      }
      expect(
        await service.record(
          actor,
          event('remove-two', 300, { reaction: '+1::skin-tone-2', action: 'removed' }),
        ),
      ).toMatchObject({ ok: true, value: { feedback: { rating: 'thumbsUp' } } });
      const record = (
        await deps.storage.pendingChannelFeedbackExports(actor.tenantId, clock, 10)
      )[0];
      expect(record.votes).toHaveLength(2);
      expect(record.votes.find((vote) => vote.reaction === 'thumbsup::skin-tone-2')?.active).toBe(
        false,
      );
      expect(record.votes.find((vote) => vote.reaction === 'thumbsup::skin-tone-3')?.active).toBe(
        true,
      );
    }),
);

it(
  'prevents a delayed exporter from overwriting a newer vote after lease takeover',
  scoped(async () => {
    await service.record(actor, event('positive', 100));
    let enter!: () => void;
    let release!: (allowed: boolean) => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    let first = true;
    deps.canRecord = async () => {
      if (!first) return true;
      first = false;
      enter();
      return gate;
    };
    const old = service.flush(actor.tenantId, 10).then(
      () => undefined,
      (error) => error,
    );
    await entered;
    clock += 2001;
    await service.record(actor, event('negative', 200, { reaction: '-1' }));
    await createChannelFeedbackService(deps).flush(actor.tenantId, 10);
    release(true);
    expect(await old).toMatchObject({ message: 'Channel feedback export timed out' });
    expect(deps.sendScore).toHaveBeenCalledTimes(1);
    expect(jest.mocked(deps.sendScore).mock.calls[0][0].feedback).toEqual({ rating: 'thumbsDown' });
    const records = await mongoose.models.ChannelFeedback.find({ tenantId: actor.tenantId }).lean();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ rating: 'thumbsDown', revision: 2, exportStatus: 'sent' });
  }),
);

it(
  'bounds an uncooperative policy lookup and retries its durable receipt later',
  scoped(async () => {
    await service.record(actor, event('positive', 100));
    deps.exportTimeoutMs = 15;
    deps.canRecord = () => new Promise<boolean>(() => {});
    const bounded = createChannelFeedbackService(deps);
    await expect(bounded.flush(actor.tenantId, 10)).rejects.toThrow('timed out');
    expect(deps.sendScore).not.toHaveBeenCalled();
    expect(
      await deps.storage.pendingChannelFeedbackExports(actor.tenantId, clock, 10),
    ).toHaveLength(0);
    clock += 2001;
    deps.canRecord = async () => true;
    await bounded.flush(actor.tenantId, 10);
    expect(deps.sendScore).toHaveBeenCalledTimes(1);
  }),
);
