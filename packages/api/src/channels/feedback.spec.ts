import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createModels,
  createChannelFeedbackStorage,
  runAsSystem,
  tenantStorage,
} from '@librechat/data-schemas';
import type {
  ChannelFeedbackActor,
  ChannelReplyMapping,
  ChannelReactionEvent,
} from 'librechat-data-provider';
import type { ChannelFeedbackDependencies } from './feedback';
import { createChannelFeedbackService, normalizeChannelRating } from './feedback';

let mongo: MongoMemoryServer;
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
  messageId: 'message-a',
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
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
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
      ['ChannelReply', 'ChannelFeedback', 'ChannelFeedbackEvent'].map((name) =>
        mongoose.models[name].deleteMany({}),
      ),
    ),
  );
  clock = 1000;
  enabled = true;
  deps = {
    storage: createChannelFeedbackStorage(mongoose),
    canRecord: async () => enabled,
    resolveReply: async (_actor, runId, key) =>
      runId === mapping.runId ? { ...mapping, externalMessageKey: key } : null,
    sendScore: jest.fn().mockResolvedValue(undefined),
    maxConflictRetries: 10,
    exportTimeoutMs: 500,
    exportLeaseMs: 1000,
    exportRetryMs: 2000,
    now: () => clock,
  };
  service = createChannelFeedbackService(deps);
  await tenantStorage.run({ tenantId: actor.tenantId }, () =>
    service.mapReply(actor, mapping.runId, mapping.externalMessageKey),
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
    await service.mapReply(actor, mapping.runId, 'C1:123.457');
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
      await service.mapReply(
        { ...actor, teamId: 'other' },
        mapping.runId,
        mapping.externalMessageKey,
      ),
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
    const original = deps.storage.markChannelFeedbackEvent.bind(deps.storage);
    const mark = jest
      .spyOn(deps.storage, 'markChannelFeedbackEvent')
      .mockRejectedValueOnce(new Error('database interrupted'));
    await expect(service.record(actor, event('e1', 100))).rejects.toThrow('database interrupted');
    mark.mockImplementation(original);
    await service.recover(actor.tenantId, 10);
    expect(await deps.storage.pendingChannelFeedbackEvents(actor.tenantId, 10)).toHaveLength(0);
    expect(
      (await deps.storage.pendingChannelFeedbackExports(actor.tenantId, clock, 10))[0].revision,
    ).toBe(1);
  }),
);
