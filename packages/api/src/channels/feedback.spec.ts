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

it.each(['map', 'record'] as const)(
  'rejects principal opt-out before any durable %s admission',
  (action) =>
    scoped(async () => {
      await mongoose.models.ChannelReply.deleteMany({});
      deps.canRecord = async (source) => !('principalId' in source);
      const result =
        action === 'map'
          ? await service.mapReply(actor, mapping.externalMessageKey)
          : await service.record(actor, event('opted-out', 1));
      expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      for (const name of ['ChannelReply', 'ChannelFeedbackEvent', 'ChannelFeedback'])
        expect(await mongoose.models[name].countDocuments({})).toBe(0);
    })(),
);

it(
  'rotates rejected recovery receipts even when retry delays expire between polls',
  scoped(async () => {
    for (let index = 0; index < 3; index++) {
      const input = event(`recover-${index}`, index + 1, { externalMessageKey: `C1:${index}` });
      await deps.storage.admitChannelFeedbackEvent({
        tenantId: actor.tenantId,
        channelId: actor.channelId,
        eventId: input.eventId,
        digest: input.eventId,
        ledgerKey: input.eventId,
        event: input,
        mapping: { ...mapping, externalMessageKey: input.externalMessageKey },
        rating: 'thumbsUp',
        processed: false,
      });
    }
    deps.canRecord = async (source) =>
      !('externalMessageKey' in source) || source.externalMessageKey === 'C1:2';
    expect(await service.recover(actor.tenantId, 2)).toBe(0);
    clock += deps.exportRetryMs + 60000;
    expect(await service.recover(actor.tenantId, 2)).toBe(1);
    deps.canRecord = async () => true;
    clock += deps.exportRetryMs + 1;
    expect(await service.recover(actor.tenantId, 2)).toBe(2);
  }),
);

it(
  'backs unclaimable export rows off without starving a later live source',
  scoped(async () => {
    const live = {
      ...mapping,
      runId: 'live-run',
      messageId: 'live-response',
      responseId: 'live-response',
    };
    await mongoose.models.Message.create({
      tenantId: actor.tenantId,
      user: mapping.principalId,
      messageId: live.messageId,
      conversationId: live.conversationId,
      isCreatedByUser: false,
      sender: 'Agent',
      endpoint: 'agents',
      model: actor.agentId,
      text: 'answer',
    });
    for (let index = 0; index < 3; index++) {
      const source = index < 2 ? mapping : live;
      await deps.storage.ensureChannelFeedback({
        tenantId: actor.tenantId,
        key: `export-${index}`,
        mapping: source,
        externalUserId: 'U1',
        scoreId: `score-${index}`,
        votes: [],
        revision: 1,
        rating: 'thumbsUp',
        exportStatus: 'pending',
        retryAtMs: 0,
      });
    }
    await mongoose.models.Message.updateOne(
      { messageId: mapping.messageId },
      { $set: { expiredAt: new Date(0) } },
    );
    expect(await service.flush(actor.tenantId, 2)).toBe(0);
    expect(await service.flush(actor.tenantId, 2)).toBe(1);
    expect(deps.sendScore).toHaveBeenCalledTimes(1);
  }),
);

it(
  'retains only current checkpoints plus a bounded obsolete receipt window across GC and replay',
  scoped(async () => {
    for (let index = 0; index < 20; index++)
      await service.record(
        actor,
        event(`toggle-${index}`, index + 1, { action: index % 2 ? 'removed' : 'added' }),
      );
    const rows = await mongoose.models.ChannelFeedbackEvent.find({
      tenantId: actor.tenantId,
    }).lean();
    expect(rows.filter((row) => row.receiptExpiresAt instanceof Date)).toHaveLength(19);
    const first = await mongoose.models.ChannelFeedbackEvent.findOne({ eventId: 'toggle-0' }).lean<{
      receiptExpiresAt: Date;
    }>();
    expect(first?.receiptExpiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86400000);
    await service.record(actor, event('toggle-0', 1));
    expect(
      (
        await mongoose.models.ChannelFeedbackEvent.findOne({ eventId: 'toggle-0' }).lean<{
          receiptExpiresAt: Date;
        }>()
      )?.receiptExpiresAt,
    ).toEqual(first?.receiptExpiresAt);
    const key = (await mongoose.models.ChannelFeedback.findOne({}).lean<{ key: string }>())!.key;
    await service.flush(actor.tenantId, 10);
    const before = (await deps.storage.getChannelFeedback(actor.tenantId, key))!;
    await mongoose.connection.db!.admin().command({ setParameter: 1, ttlMonitorSleepSecs: 1 });
    await mongoose.models.ChannelFeedbackEvent.collection.updateMany(
      { eventId: { $ne: 'toggle-19' } },
      { $set: { receiptExpiresAt: new Date(0) } },
    );
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await mongoose.models.ChannelFeedbackEvent.countDocuments({})) === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(await mongoose.models.ChannelFeedbackEvent.countDocuments({})).toBe(1);
    expect(
      await mongoose.models.ChannelFeedbackEvent.findOne({ eventId: 'toggle-19' }).lean(),
    ).not.toHaveProperty('receiptExpiresAt');
    await service.record(actor, event('toggle-0', 1));
    await service.flush(actor.tenantId, 10);
    expect(await deps.storage.getChannelFeedback(actor.tenantId, key)).toMatchObject({
      revision: before.revision,
      votes: before.votes,
      rating: before.rating,
    });
    expect(deps.sendScore).toHaveBeenCalledTimes(1);
  }),
  30000,
);

it(
  'persists one score timestamp through next-day updates, retry and process restart',
  scoped(async () => {
    await service.record(actor, event('first-day', 1));
    await service.flush(actor.tenantId, 10);
    const first = jest.mocked(deps.sendScore).mock.calls[0][0];
    expect(first.scoreTimestamp).toEqual(expect.any(String));
    clock += 86400000;
    await service.record(actor, event('second-day', 2, { reaction: 'thumbsdown' }));
    service = createChannelFeedbackService(deps);
    jest.mocked(deps.sendScore).mockRejectedValueOnce(new Error('provider outage'));
    await expect(service.flush(actor.tenantId, 10)).rejects.toThrow('provider outage');
    clock += deps.exportRetryMs + 1;
    await service.flush(actor.tenantId, 10);
    const calls = jest.mocked(deps.sendScore).mock.calls.map(([input]) => input);
    expect(new Set(calls.map((input) => input.scoreId)).size).toBe(1);
    expect(calls.map((input) => input.scoreTimestamp)).toEqual([
      first.scoreTimestamp,
      first.scoreTimestamp,
      first.scoreTimestamp,
    ]);
  }),
);

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

it.each(['current'] as const)(
  'keeps distinct skin-tone slots and canonical aliases (%s)',
  (_mode) =>
    tenantStorage.run({ tenantId: actor.tenantId }, async () => {
      await service.record(actor, event('tone-two', 100, { reaction: 'thumbsup::skin-tone-2' }));
      await service.record(actor, event('tone-three', 200, { reaction: 'thumbsup::skin-tone-3' }));
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
