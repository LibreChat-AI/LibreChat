/** The counting itself is exercised in packages/api (it needs a loaded encoding,
 *  which this environment cannot load); here the resolver stands in so the WIRING
 *  is pinned: which content the save path hands it, and where its figure lands. */
const mockResolveRetainedToolTokens = jest.fn();
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  resolveRetainedToolTokens: (...args) => mockResolveRetainedToolTokens(...args),
}));

const AgentClient = require('../client');

/** Minimal post-(maybe-)summary snapshot. baseUsed = maxContextTokens(1000) -
 *  remainingContextTokens(700) = 300, so the marker (summaryUsedTokens) is 300. */
const snapshot = (summaryTokens) => ({
  runId: 'run-1',
  agentId: 'agent-1',
  breakdown: {
    maxContextTokens: 1000,
    instructionTokens: 50,
    systemMessageTokens: 50,
    dynamicInstructionTokens: 0,
    toolSchemaTokens: 0,
    summaryTokens,
    toolCount: 0,
    messageCount: 1,
    messageTokens: 20,
    availableForMessages: 900,
  },
  contextBudget: 1000,
  remainingContextTokens: 700,
  prePruneContextTokens: 300,
  effectiveInstructionTokens: 50,
  calibrationRatio: 1,
});

const primary = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
const summarizationUsage = { ...primary, usage_type: 'summarization' };
const primaryFor = (runId, output_tokens) => ({
  input_tokens: 10,
  output_tokens,
  total_tokens: 10 + output_tokens,
  provider: 'openAI',
  runId,
});

const toolPart = (id, name, output) => ({
  type: 'tool_call',
  tool_call: { id, name, args: '{"path":"a"}', output },
});

function buildMeta({
  snap,
  latestUsageIndex,
  usageEvents,
  stepLimitReached = false,
  latestToolCallIds,
  contentParts,
  maxRetainedToolCountChars,
}) {
  const self = {
    collectedThoughtSignatures: null,
    usageEmitSink: usageEvents,
    stepLimitReached,
    contentParts,
    getEncoding: () => 'o200k_base',
    options: {
      req: { config: { endpoints: { agents: { maxRetainedToolCountChars } } } },
    },
    contextUsageSink: snap
      ? { latest: snap, count: 1, latestUsageIndex, latestToolCallIds }
      : { latest: null, count: 0 },
  };
  return AgentClient.prototype.buildResponseMetadata.call(self);
}

describe('AgentClient.buildResponseMetadata — snapshot persistence + summary marker', () => {
  beforeEach(() => {
    mockResolveRetainedToolTokens.mockReset();
  });

  it('persists the snapshot when a primary usage follows it (normal turn)', () => {
    const meta = buildMeta({ snap: snapshot(0), latestUsageIndex: 0, usageEvents: [primary] });
    expect(meta.contextUsage).toBeDefined();
    expect(meta.summaryUsedTokens).toBeUndefined();
  });

  it('persists the post-summary snapshot when the only pre-primary usage is the summarization', () => {
    /** A summarized turn: the summarization usage precedes the post-summary
     *  snapshot (index 1), then the model's primary usage follows it. The old
     *  count guard miscounted and dropped this; the new guard keeps it. The
     *  marker subtracts the summarization output (5): the generated summary is in
     *  the snapshot baseline (summaryTokens) AND the response tokenCount, so
     *  300 − 5 = 295 keeps the client estimate from counting it twice. */
    const meta = buildMeta({
      snap: snapshot(80),
      latestUsageIndex: 1,
      usageEvents: [summarizationUsage, primary],
    });
    expect(meta.contextUsage).toBeDefined();
    expect(meta.summaryUsedTokens).toBe(295);
  });

  it('still emits the summary marker when the final call emitted no usage', () => {
    /** Interrupted summarized turn: no primary usage follows the latest snapshot,
     *  so the snapshot is (correctly) not persisted — but the coarse marker
     *  survives so the client estimate still caps the discarded history. The
     *  summarization output (5) is subtracted (300 − 5 = 295). */
    const meta = buildMeta({
      snap: snapshot(80),
      latestUsageIndex: 1,
      usageEvents: [summarizationUsage],
    });
    expect(meta.contextUsage).toBeUndefined();
    expect(meta.summaryUsedTokens).toBe(295);
  });

  it('drops the snapshot and emits no marker when the final call had no usage and no summary', () => {
    const meta = buildMeta({ snap: snapshot(0), latestUsageIndex: 1, usageEvents: [primary] });
    expect(meta.contextUsage).toBeUndefined();
    expect(meta.summaryUsedTokens).toBeUndefined();
  });

  it('does not persist the snapshot when only a parallel run produced post-snapshot usage', () => {
    /** A snapshot (run-1) → B snapshot (run-1 is latest) but the only following
     *  usage belongs to a sibling run (run-2). The guard must NOT persist run-1's
     *  snapshot with run-2's output — it falls back to the per-message estimate. */
    const meta = buildMeta({
      snap: snapshot(0),
      latestUsageIndex: 0,
      usageEvents: [primaryFor('run-2', 99)],
    });
    expect(meta.contextUsage).toBeUndefined();
  });

  it('persists with the snapshot run output when its own primary usage follows', () => {
    const meta = buildMeta({
      snap: snapshot(0),
      latestUsageIndex: 0,
      usageEvents: [primaryFor('run-2', 99), primaryFor('run-1', 7)],
    });
    expect(meta.contextUsage).toBeDefined();
    expect(meta.contextUsage.completedOutputTokens).toBe(7);
  });

  it('subtracts earlier tool-loop output from the summary marker (interrupted turn)', () => {
    /** Multi-call summarized turn stopped before the final usage: the earlier
     *  call (output 40) is baked into baseUsed (300), so the marker is 300 − 40 =
     *  260. No primary follows the snapshot, so the full snapshot is not persisted
     *  and the client uses this marker — which must not double-count the 40 that
     *  the response tokenCount also carries. */
    const meta = buildMeta({
      snap: snapshot(80),
      latestUsageIndex: 1,
      usageEvents: [primaryFor('run-1', 40)],
    });
    expect(meta.contextUsage).toBeUndefined();
    expect(meta.summaryUsedTokens).toBe(260);
  });

  it('subtracts only this run’s earlier output, not a parallel run’s', () => {
    const meta = buildMeta({
      snap: snapshot(80),
      latestUsageIndex: 2,
      usageEvents: [primaryFor('run-2', 999), primaryFor('run-1', 40), primaryFor('run-1', 5)],
    });
    /** baseUsed 300 − run-1's earlier 40 = 260; run-2's 999 is ignored. */
    expect(meta.summaryUsedTokens).toBe(260);
    /** run-1's own primary follows the snapshot → snapshot persisted with output 5. */
    expect(meta.contextUsage.completedOutputTokens).toBe(5);
  });

  /** A turn that stops at the tool-call limit keeps the results of the tools its
   *  final call ran. The snapshot describing that call precedes them and no further
   *  call is made, so the counted figure has to ride along or the client's gauge
   *  misses the retained result until the next turn. */
  it('hands the resolver this snapshot’s call boundary and persists its figure', () => {
    mockResolveRetainedToolTokens.mockReturnValue(180);
    const contentParts = [
      toolPart('call_1', 'grep', 'the result the snapshot already counts'),
      toolPart('call_2', 'read_file', 'the retained result'),
    ];
    const latestToolCallIds = new Set(['call_1']);
    const meta = buildMeta({
      snap: snapshot(0),
      latestUsageIndex: 0,
      usageEvents: [primary],
      stepLimitReached: true,
      latestToolCallIds,
      contentParts,
      maxRetainedToolCountChars: 1_048_576,
    });
    expect(mockResolveRetainedToolTokens).toHaveBeenCalledWith({
      stoppedAtToolLimit: true,
      contentParts,
      /** The calls the snapshot already saw; only the rest are retained. */
      priorToolCallIds: latestToolCallIds,
      encoding: 'o200k_base',
      /** The deployment's ceiling on the tokenization this costs. */
      maxCountChars: 1_048_576,
    });
    expect(meta.contextUsage.retainedToolTokens).toBe(180);
  });

  it('reports a turn that did not stop at the tool-call limit as such', () => {
    mockResolveRetainedToolTokens.mockReturnValue(undefined);
    const meta = buildMeta({
      snap: snapshot(0),
      latestUsageIndex: 0,
      usageEvents: [primary],
      latestToolCallIds: new Set(),
      contentParts: [toolPart('call_1', 'read_file', 'a result the next call re-counted')],
    });
    expect(mockResolveRetainedToolTokens).toHaveBeenCalledWith(
      expect.objectContaining({ stoppedAtToolLimit: false }),
    );
    /** Nothing to add, so the blob stays exactly as it was before this change. */
    expect(Object.prototype.hasOwnProperty.call(meta.contextUsage, 'retainedToolTokens')).toBe(
      false,
    );
  });
});
