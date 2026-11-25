import type { TContextUsageEvent, TTokenUsageEvent } from './runs';
import { promptTokensFromUsage, outputTokensFromUsage, reconcileContextUsage } from './runs';

describe('promptTokensFromUsage', () => {
  it('adds cache reads/writes for additive providers (Bedrock)', () => {
    const event: TTokenUsageEvent = {
      input_tokens: 53702,
      input_token_details: { cache_read: 2071, cache_creation: 0 },
      provider: 'bedrock',
    };
    expect(promptTokensFromUsage(event)).toBe(55773);
  });

  it('treats input_tokens as the full prompt for Anthropic (cache-inclusive)', () => {
    const event: TTokenUsageEvent = {
      input_tokens: 55773,
      input_token_details: { cache_read: 2071, cache_creation: 0 },
      provider: 'anthropic',
    };
    expect(promptTokensFromUsage(event)).toBe(55773);
  });

  it('treats input_tokens as the full prompt for subset providers (OpenAI)', () => {
    const event: TTokenUsageEvent = {
      input_tokens: 1000,
      input_token_details: { cache_read: 200, cache_creation: 100 },
      provider: 'openAI',
    };
    expect(promptTokensFromUsage(event)).toBe(1000);
  });

  it('handles missing fields', () => {
    expect(promptTokensFromUsage({ provider: 'anthropic' })).toBe(0);
  });
  it('ignores malformed numeric usage fields', () => {
    expect(
      promptTokensFromUsage({
        input_tokens: Number.NaN,
        input_token_details: { cache_read: Number.POSITIVE_INFINITY, cache_creation: '4' as never },
        provider: 'bedrock',
      }),
    ).toBe(0);
  });

  it('accepts the activity-label usage bucket emitted on the wire', () => {
    /** Type-level pin: the backend emits this literal for fast-model header
     *  calls, so the union must be able to represent the actual payload. */
    const event: TTokenUsageEvent = {
      input_tokens: 120,
      output_tokens: 9,
      usage_type: 'activity-label',
      runId: 'msg-1:1700000000000',
      seq: -1,
    };
    expect(promptTokensFromUsage(event)).toBe(120);
  });

  it('accepts the reasoning-label usage bucket emitted on the wire', () => {
    const event: TTokenUsageEvent = {
      input_tokens: 85,
      output_tokens: 7,
      usage_type: 'reasoning-label',
      runId: 'msg-1:1700000000000',
      seq: -2,
    };
    expect(promptTokensFromUsage(event)).toBe(85);
  });

  it('uses the magnitude heuristic when the provider is absent (cache ≤ input ⇒ included)', () => {
    /** OpenAI-compatible/custom payload with no provider: cache already folded
     *  into input_tokens, so it must NOT be re-added. */
    const event: TTokenUsageEvent = {
      input_tokens: 1000,
      input_token_details: { cache_read: 400, cache_creation: 0 },
    };
    expect(promptTokensFromUsage(event)).toBe(1000);
  });

  it('adds cache when provider is absent and cache exceeds input (additive shape)', () => {
    const event: TTokenUsageEvent = {
      input_tokens: 100,
      input_token_details: { cache_read: 900, cache_creation: 0 },
    };
    expect(promptTokensFromUsage(event)).toBe(1000);
  });
});

describe('outputTokensFromUsage', () => {
  it('repairs omitted reasoning while excluding additive prompt-cache tokens', () => {
    expect(
      outputTokensFromUsage({
        provider: 'bedrock',
        input_tokens: 200,
        output_tokens: 30,
        total_tokens: 450,
        input_token_details: { cache_read: 100, cache_creation: 50 },
      }),
    ).toBe(100);
    expect(
      outputTokensFromUsage({
        provider: 'bedrock',
        input_tokens: 200,
        output_tokens: 30,
        total_tokens: 380,
        input_token_details: { cache_read: 100, cache_creation: 50 },
      }),
    ).toBe(30);
    expect(outputTokensFromUsage({ output_tokens: NaN, total_tokens: Infinity })).toBe(0);
  });
});

describe('reconcileContextUsage', () => {
  /** The exact over-reporting case from a real web-search + summarization turn:
   *  calibrationRatio pinned at 5 inflated messageTokens to 187471 → used 213375,
   *  while the provider's real prompt for that call was 55773. */
  const inflatedSnapshot: TContextUsageEvent = {
    runId: 'run-1',
    breakdown: {
      maxContextTokens: 250000,
      instructionTokens: 4205,
      systemMessageTokens: 384,
      dynamicInstructionTokens: 1525,
      toolSchemaTokens: 2296,
      summaryTokens: 1938,
      toolCount: 1,
      messageCount: 2,
      messageTokens: 187471,
      availableForMessages: 233295,
    },
    contextBudget: 237500,
    remainingContextTokens: 24125,
    calibrationRatio: 5,
  };

  it('reconciles the inflated estimate to the real prompt tokens', () => {
    const result = reconcileContextUsage(inflatedSnapshot, 55773);
    /** used = budget − remaining = real prompt, down from the inflated 213375 */
    expect(237500 - (result.remainingContextTokens ?? 0)).toBe(55773);
    /** only messageTokens is corrected; instructions/summary stay raw */
    expect(result.breakdown.messageTokens).toBe(55773 - 4205 - 1938);
    expect(result.breakdown.instructionTokens).toBe(4205);
    expect(result.breakdown.summaryTokens).toBe(1938);
    /** rows still sum to the real total */
    expect(
      result.breakdown.messageTokens +
        result.breakdown.instructionTokens +
        result.breakdown.summaryTokens,
    ).toBe(55773);
  });

  it('clamps messageTokens to zero when the prompt is smaller than the overhead', () => {
    const result = reconcileContextUsage(inflatedSnapshot, 3000);
    expect(result.breakdown.messageTokens).toBe(0);
    expect(result.remainingContextTokens).toBe(237500 - 3000);
  });

  it('rescales toolMessageTokens proportionally to the corrected messageTokens', () => {
    const snapshot: TContextUsageEvent = {
      ...inflatedSnapshot,
      breakdown: { ...inflatedSnapshot.breakdown, toolMessageTokens: 46868 },
    };
    const result = reconcileContextUsage(snapshot, 55773);
    const messageTokens = 55773 - 4205 - 1938;
    const toolMessageTokens = Math.round((46868 / 187471) * messageTokens);
    expect(result.breakdown.messageTokens).toBe(messageTokens);
    expect(result.breakdown.toolMessageTokens).toBe(toolMessageTokens);
    /** the split stays a subset of the corrected total */
    expect(result.breakdown.toolMessageTokens).toBeLessThanOrEqual(result.breakdown.messageTokens);
    /** rows still sum to the real total */
    expect(
      result.breakdown.messageTokens +
        result.breakdown.instructionTokens +
        result.breakdown.summaryTokens,
    ).toBe(55773);
  });

  it('rescales toolMessageTokenCounts with the reconciled total', () => {
    const snapshot: TContextUsageEvent = {
      ...inflatedSnapshot,
      breakdown: {
        ...inflatedSnapshot.breakdown,
        toolMessageTokens: 46868,
        toolMessageTokenCounts: { grep: 40000, read_file: 6868, zero: 0 },
      },
    };
    const result = reconcileContextUsage(snapshot, 55773);
    const factor = result.breakdown.toolMessageTokens! / 46868;
    expect(result.breakdown.toolMessageTokenCounts?.grep).toBe(Math.round(40000 * factor));
    expect(result.breakdown.toolMessageTokenCounts?.read_file).toBe(Math.round(6868 * factor));
  });

  it('rescales toolMessageTokenCounts without rounding past the total', () => {
    const snapshot: TContextUsageEvent = {
      ...inflatedSnapshot,
      breakdown: {
        ...inflatedSnapshot.breakdown,
        messageTokens: 10,
        toolMessageTokens: 10,
        toolMessageTokenCounts: { first: 5, second: 5 },
      },
    };
    const result = reconcileContextUsage(snapshot, 4205 + 1938 + 1);
    expect(result.breakdown.toolMessageTokens).toBe(1);
    expect(
      Object.values(result.breakdown.toolMessageTokenCounts ?? {}).reduce(
        (total, count) => total + count,
        0,
      ),
    ).toBeLessThanOrEqual(result.breakdown.toolMessageTokens ?? 0);
  });

  it('sanitizes malformed counts and preserves prototype-sensitive names', () => {
    const counts = JSON.parse('{"__proto__":2,"constructor":2,"invalid":"3"}') as Record<
      string,
      number
    >;
    const snapshot: TContextUsageEvent = {
      ...inflatedSnapshot,
      breakdown: {
        ...inflatedSnapshot.breakdown,
        messageTokens: 10,
        toolMessageTokens: 4,
        toolMessageTokenCounts: counts,
      },
    };
    const result = reconcileContextUsage(snapshot, 4205 + 1938 + 10);
    const resultCounts = result.breakdown.toolMessageTokenCounts;
    expect(resultCounts?.['__proto__']).toBe(2);
    expect(resultCounts?.constructor).toBe(2);
    expect(resultCounts?.invalid).toBeUndefined();
    expect(Object.keys(resultCounts ?? {})).toEqual(['__proto__', 'constructor']);
  });

  it('keeps a supplied zero tool split distinct from an absent split', () => {
    const snapshot: TContextUsageEvent = {
      ...inflatedSnapshot,
      breakdown: { ...inflatedSnapshot.breakdown, toolMessageTokens: 0 },
    };
    const result = reconcileContextUsage(snapshot, 55773);
    expect(result.breakdown.toolMessageTokens).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(result.breakdown, 'toolMessageTokens')).toBe(true);
  });

  it('keeps toolMessageTokenCounts absent when the tool total is absent', () => {
    const snapshot: TContextUsageEvent = {
      ...inflatedSnapshot,
      breakdown: { ...inflatedSnapshot.breakdown, toolMessageTokenCounts: { grep: 100 } },
    };
    const result = reconcileContextUsage(snapshot, 55773);
    expect(result.breakdown.toolMessageTokenCounts).toBeUndefined();
  });

  it('keeps toolMessageTokens absent on snapshots without the field (older SDK)', () => {
    const result = reconcileContextUsage(inflatedSnapshot, 55773);
    expect(result.breakdown.toolMessageTokens).toBeUndefined();
  });

  it('does not mutate the snapshot while sanitizing malformed values', () => {
    const snapshot: TContextUsageEvent = {
      ...inflatedSnapshot,
      breakdown: {
        ...inflatedSnapshot.breakdown,
        toolMessageTokens: Number.NaN,
        toolMessageTokenCounts: { grep: Number.POSITIVE_INFINITY },
      },
    };
    const result = reconcileContextUsage(snapshot, 55773);
    expect(snapshot.breakdown.toolMessageTokens).toBeNaN();
    expect(snapshot.breakdown.toolMessageTokenCounts?.grep).toBe(Infinity);
    expect(result.breakdown.toolMessageTokens).toBeUndefined();
    expect(result.breakdown.toolMessageTokenCounts).toBeUndefined();
  });

  it('clamps an over-sized tool share to the corrected messageTokens', () => {
    const snapshot: TContextUsageEvent = {
      ...inflatedSnapshot,
      breakdown: { ...inflatedSnapshot.breakdown, toolMessageTokens: 187471 },
    };
    const result = reconcileContextUsage(snapshot, 6144);
    expect(result.breakdown.messageTokens).toBe(1);
    expect(result.breakdown.toolMessageTokens).toBe(1);
  });

  it('is a no-op for an unusable prompt count', () => {
    expect(reconcileContextUsage(inflatedSnapshot, 0)).toBe(inflatedSnapshot);
    expect(reconcileContextUsage(inflatedSnapshot, -5)).toBe(inflatedSnapshot);
    expect(reconcileContextUsage(inflatedSnapshot, NaN)).toBe(inflatedSnapshot);
  });

  it('end-to-end: promptTokensFromUsage feeds reconcileContextUsage (followup turn)', () => {
    const followupSnapshot: TContextUsageEvent = {
      ...inflatedSnapshot,
      breakdown: { ...inflatedSnapshot.breakdown, messageTokens: 30480 },
      remainingContextTokens: 202815,
    };
    const usage: TTokenUsageEvent = {
      input_tokens: 9875, // cache-inclusive (Anthropic): 7804 fresh + 2071 read
      input_token_details: { cache_read: 2071, cache_creation: 0 },
      provider: 'anthropic',
    };
    const result = reconcileContextUsage(followupSnapshot, promptTokensFromUsage(usage));
    expect(237500 - (result.remainingContextTokens ?? 0)).toBe(9875);
    expect(result.breakdown.messageTokens).toBe(9875 - 4205 - 1938);
  });
});
