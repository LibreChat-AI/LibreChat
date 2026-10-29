import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { configCapability, SystemCapabilities } from '@librechat/data-schemas';
import type {
  ChannelRunRecord,
  ChannelSummaryRow,
  IMessage,
  SystemCapability,
} from '@librechat/data-schemas';
import type { ChannelRunSnapshot, ResponseAccounting } from 'librechat-data-provider';
import type { ChannelSummaryTraceDependencies } from './summary';
import type { CapabilityUser } from '~/middleware/capabilities';
import type { ChannelMessage } from './types';
import { createChannelSummaryService, createChannelSummaryTraceResolver } from './summary';
import { getLangfuseDestinationId } from '~/langfuse/destinations';

function priced(amount = '0.1'): ResponseAccounting {
  return {
    status: 'available',
    currency: 'USD',
    amount,
    basis: 'application_billing',
    coverage: 'complete',
    reason: 'priced',
    calls: [],
  };
}
function snapshot(overrides: Partial<ChannelRunSnapshot> = {}): ChannelRunSnapshot {
  return {
    status: 'completed',
    text: 'Private answer must not appear in summary',
    elapsedMs: 10,
    responseId: 'response',
    usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    accounting: priced(),
    ...overrides,
  };
}
function run(sequence = 1): ChannelRunRecord {
  return {
    tenantId: 'tenant',
    channelId: 'channel',
    agentId: 'agent',
    laneId: 'actor-lane',
    runId: 'run',
    sequence,
    state: 'executing',
    receivedAt: 1,
    payloadHash: 'hash',
    leaseEpoch: 1,
    leaseExpiresAt: 100,
    receipts: [],
    cancellationRequested: false,
    principal: { userId: 'user', channelRevision: 'revision', linkId: 'link', linkRevision: 'r1' },
    admission: {
      eventId: 'event',
      externalChannelId: 'C1',
      externalThreadKey: 'C1:123',
      externalMessageKey: 'C1:124',
      input: 'Private input must not appear in summary',
      actor: { teamId: 'T1', appId: 'A1', externalUserId: 'U1' },
    },
    execution: { requestId: 'request', conversationId: 'conversation', parentMessageId: 'parent' },
  };
}
function service(rows: ChannelSummaryRow[] = [], trace?: ChannelSummaryTraceDependencies) {
  return createChannelSummaryService({
    storage: {
      async *priorMetrics() {
        yield* rows;
      },
    },
    trace,
  });
}

describe('actor-lane summary', () => {
  it('adds current exactly once to prior attempts with exact decimal arithmetic', async () => {
    const result = await service([
      { sequence: 2, snapshot: snapshot({ status: 'cancelled', accounting: priced('0.2') }) },
      { sequence: 1, snapshot: snapshot({ status: 'failed', accounting: priced('0.3') }) },
    ]).summarize(run(3), snapshot());
    expect(result).toEqual({
      version: 1,
      scope: 'actor_lane',
      throughSequence: 3,
      includesCurrent: true,
      priorRuns: 2,
      expectedRuns: 3,
      observedRuns: 3,
      costUSD: { coverage: 'complete', coveredRuns: 3, value: '0.6', basis: 'application_billing' },
      elapsedMs: { coverage: 'complete', coveredRuns: 3, value: 30 },
      tokens: {
        coverage: 'complete',
        coveredRuns: 3,
        value: { inputTokens: 6, outputTokens: 9, totalTokens: 15 },
      },
    });
    expect(JSON.stringify(result)).not.toContain('Private');
  });
  it('retains all 18 fraction digits and amounts beyond Decimal128 precision', async () => {
    const result = await service([
      {
        sequence: 1,
        snapshot: snapshot({
          accounting: priced('10000000000000000000000000000000000.000000000000000001'),
        }),
      },
    ]).summarize(run(2), snapshot({ accounting: priced('0.000000000000000002') }));
    expect(result.costUSD.value).toBe('10000000000000000000000000000000000.000000000000000003');
  });
  it('marks truncated or missing prior sequence coverage partial without claiming a total', async () => {
    const result = await service([{ sequence: 999, snapshot: snapshot() }]).summarize(
      run(1001),
      snapshot(),
    );
    expect(result).toMatchObject({ expectedRuns: 1001, observedRuns: 2, priorRuns: 1 });
    expect(result.costUSD).toEqual({
      coverage: 'partial',
      coveredRuns: 2,
      knownValue: '0.2',
      basis: 'application_billing',
    });
    expect(result.elapsedMs).toEqual({ coverage: 'partial', coveredRuns: 2, knownValue: 20 });
    expect(result.tokens.value).toBeUndefined();
  });
  it('keeps unavailable or running/legacy snapshots as coverage gaps, never invented zeros', async () => {
    const result = await service([
      { sequence: 1 },
      { sequence: 2, snapshot: snapshot({ status: 'running' }) },
    ]).summarize(run(3), snapshot({ usage: undefined, accounting: undefined }));
    expect(result.costUSD).toEqual({ coverage: 'unavailable', coveredRuns: 0 });
    expect(result.tokens).toEqual({ coverage: 'unavailable', coveredRuns: 0 });
    expect(result.elapsedMs).toEqual({ coverage: 'partial', coveredRuns: 1, knownValue: 10 });
  });
  it('does not mix provider-invoice and application-billing costs', async () => {
    const result = await service([
      {
        sequence: 1,
        snapshot: snapshot({ accounting: { ...priced(), basis: 'provider_reported' } }),
      },
    ]).summarize(run(2), snapshot());
    expect(result.costUSD).toEqual({ coverage: 'unavailable', coveredRuns: 0 });
    expect(result.tokens.coverage).toBe('complete');
  });
  it.each(['-1', 'NaN', '1e3', '0.1234567890123456789', ''])(
    'rejects malformed amount %s',
    async (amount) => {
      const result = await service().summarize(run(), snapshot({ accounting: priced(amount) }));
      expect(result.costUSD).toEqual({ coverage: 'unavailable', coveredRuns: 0 });
    },
  );
  it('accepts actual priced zero but does not convert missing usage to a zero token total', async () => {
    const result = await service().summarize(
      run(),
      snapshot({ accounting: priced('0'), usage: undefined }),
    );
    expect(result.costUSD.value).toBe('0');
    expect(result.tokens.coverage).toBe('unavailable');
  });
  it('suppresses partial cost amounts and invalid numeric totals independently', async () => {
    const result = await service([
      { sequence: 1, snapshot: snapshot({ elapsedMs: Number.MAX_SAFE_INTEGER }) },
    ]).summarize(
      run(2),
      snapshot({
        accounting: { ...priced('900'), status: 'unavailable', coverage: 'partial' },
        usage: { inputTokens: -1, outputTokens: 3, totalTokens: 2 },
      }),
    );
    expect(result.costUSD).toEqual({
      coverage: 'partial',
      coveredRuns: 1,
      knownValue: '0.1',
      basis: 'application_billing',
    });
    expect(result.elapsedMs.coverage).toBe('unavailable');
    expect(result.tokens).toMatchObject({ coverage: 'partial', coveredRuns: 1 });
  });
  it('reuses frozen summary without new reads on retry', async () => {
    const frozen = await service().summarize(run(), snapshot());
    const priorMetrics = jest.fn(async function* () {
      yield* [];
      throw new Error('must not read');
    });
    const result = await createChannelSummaryService({ storage: { priorMetrics } }).summarize(
      { ...run(), snapshot: { ...snapshot(), summary: frozen } },
      snapshot({ accounting: priced('999') }),
    );
    expect(result).toBe(frozen);
    expect(priorMetrics).not.toHaveBeenCalled();
  });
  it('propagates storage outages instead of returning complete empty history', async () => {
    const storage = {
      async *priorMetrics(): AsyncIterable<ChannelSummaryRow> {
        yield* [];
        throw new Error('database unavailable');
      },
    };
    await expect(
      createChannelSummaryService({ storage }).summarize(run(), snapshot()),
    ).rejects.toThrow('database unavailable');
  });
});

it('normalizes an actual Mongo lean ObjectId without assuming an id virtual', async () => {
  const mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  const connection = await mongoose.createConnection(mongo.getUri()).asPromise();
  try {
    const User = connection.model(
      'SummaryUser',
      new mongoose.Schema({ tenantId: String, role: String }),
    );
    const saved = await User.create({ tenantId: 'tenant', role: 'ADMIN' });
    const lean = await User.findById(saved._id).lean();
    expect(lean).not.toHaveProperty('id');
    const getHeldCapabilities = jest.fn(
      async (_user: CapabilityUser) =>
        new Set([SystemCapabilities.ACCESS_ADMIN, SystemCapabilities.MANAGE_CONFIGS]),
    );
    const resolver = createChannelSummaryTraceResolver({
      findUser: async () => lean,
      getHeldCapabilities,
      getConfig: async () => undefined,
      getMessages: async () => [],
      getMessage: async () => null,
    });
    const owned = run();
    owned.principal.userId = saved._id.toString();
    expect(await resolver.canViewSession(owned)).toBe(true);
    expect(getHeldCapabilities.mock.calls[0]?.[0]).toMatchObject({
      id: saved._id.toString(),
      tenantId: 'tenant',
    });
    expect(await resolver.canViewSession(run())).toBe(false);
  } finally {
    await connection.close();
    await mongo.stop();
  }
}, 60000);

describe('authorized saved session provenance', () => {
  const url = 'https://cloud.langfuse.com/project/project/sessions/conversation';
  let message: ChannelMessage;
  let trace: ChannelSummaryTraceDependencies;
  beforeEach(() => {
    message = {
      user: 'user',
      tenantId: 'tenant',
      messageId: 'response',
      conversationId: 'conversation',
      isCreatedByUser: false,
      langfuseSampled: true,
      langfuseDestinationIds: ['destination'],
    };
    trace = {
      canViewSession: jest.fn(async () => true),
      getMessage: jest.fn(async () => message),
      resolveSession: jest.fn(async () => ({ url, destinationId: 'destination' })),
    };
  });
  it('includes only a saved current assistant response in the authorized configured destination', async () => {
    expect((await service([], trace).summarize(run(), snapshot())).session).toEqual({ url });
    expect(trace.getMessage).toHaveBeenCalledWith({
      tenantId: 'tenant',
      user: 'user',
      conversationId: 'conversation',
      messageId: 'response',
    });
  });
  it.each([
    { user: 'other' },
    { tenantId: 'other' },
    { messageId: 'previous-response' },
    { conversationId: 'other' },
    { isCreatedByUser: true },
    { langfuseSampled: false },
    { langfuseDestinationIds: [] },
    { langfuseDestinationIds: ['new-destination'] },
  ])('omits mismatched provenance %j', async (override) => {
    Object.assign(message, override);
    expect((await service([], trace).summarize(run(), snapshot())).session).toBeUndefined();
  });
  it('fails closed on current authorization denial/outage without discarding metrics', async () => {
    for (const canViewSession of [
      async () => false,
      async () => {
        throw new Error('sensitive diagnostic');
      },
    ]) {
      const result = await service([], { ...trace, canViewSession }).summarize(run(), snapshot());
      expect(result.session).toBeUndefined();
      expect(result.costUSD.value).toBe('0.1');
    }
    expect(trace.getMessage).not.toHaveBeenCalled();
  });
  it.each([
    'http://127.0.0.1:8788',
    'https://127.0.0.1',
    'https://[::1]',
    'https://10.0.0.1',
    'https://trace.internal',
    'https://localhost',
    'https://trace.local',
    'https://trace.test',
    'https://user:secret@cloud.langfuse.com',
    'https://cloud.langfuse.com?token=secret',
    'https://cloud.langfuse.com#secret',
    'javascript:secret',
    'not a URL',
  ])('never emits nonpublic or credential-bearing UI URL %s', async (unsafe) => {
    trace.resolveSession = async () => ({ url: unsafe, destinationId: 'destination' });
    expect((await service([], trace).summarize(run(), snapshot())).session).toBeUndefined();
  });
  it('uses the real configured session resolver and current capabilities without external HTTP', async () => {
    const savedEnv = { ...process.env };
    try {
      process.env.LANGFUSE_FANOUT_ENABLED = 'true';
      process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://127.0.0.1:8788';
      process.env.LANGFUSE_TRACING_ENABLED = 'true';
      process.env.LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED = 'false';
      process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'test=https://cloud.langfuse.com';
      process.env.LANGFUSE_SAMPLE_RATE = '1';
      message.langfuseDestinationIds = [
        getLangfuseDestinationId('https://cloud.langfuse.com', 'project'),
      ];
      const Message = mongoose.model<IMessage>(
        'SummaryMessage',
        new mongoose.Schema<IMessage>({ messageId: String }),
      );
      const getMessages = jest.fn(async () => [new Message({ messageId: 'response' })]);
      const deps = {
        findUser: async () => ({ id: 'user', tenantId: 'tenant', role: 'ADMIN' }),
        getHeldCapabilities: async () =>
          new Set([SystemCapabilities.ACCESS_ADMIN, configCapability('langfuse')]),
        getConfig: async () => ({ enabled: true, destination: 'test', projectId: 'project' }),
        getMessage: async () => message,
        getMessages,
      };
      const typed = createChannelSummaryTraceResolver(deps);
      expect((await service([], typed).summarize(run(), snapshot())).session).toEqual({ url });
      expect(getMessages).toHaveBeenCalledWith(
        {
          user: 'user',
          conversationId: 'conversation',
          langfuseSampled: true,
          langfuseDestinationIds: message.langfuseDestinationIds[0],
        },
        '_id',
        { sort: false, limit: 1 },
      );
      for (const held of [
        new Set([SystemCapabilities.ACCESS_ADMIN]),
        new Set([configCapability('langfuse')]),
        new Set<SystemCapability>(),
      ]) {
        expect(
          await createChannelSummaryTraceResolver({
            ...deps,
            getHeldCapabilities: async () => held,
          }).canViewSession(run()),
        ).toBe(false);
      }
      expect(
        await createChannelSummaryTraceResolver({
          ...deps,
          findUser: async () => ({ id: 'user', tenantId: 'other', role: 'ADMIN' }),
        }).canViewSession(run()),
      ).toBe(false);
      expect(
        (
          await service(
            [],
            createChannelSummaryTraceResolver({ ...deps, getConfig: async () => undefined }),
          ).summarize(run(), snapshot())
        ).session,
      ).toBeUndefined();
    } finally {
      process.env = savedEnv;
    }
  });
});
