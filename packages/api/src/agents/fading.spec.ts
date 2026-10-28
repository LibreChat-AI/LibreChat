import { AGENT_FADING_TIER_VERSION } from '@librechat/data-schemas';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import {
  FADING_TIER_VERSION,
  createPruneMessages,
  resolveFadingCaps,
  seedFadingTier,
} from '@librechat/agents';
import type { IAgentFadingTier } from '@librechat/data-schemas';
import type { BaseMessage } from '@langchain/core/messages';
import {
  isAgentFadingTier,
  isCurrentAgentFadingTier,
  resolvePersistableFadingTier,
  resolvePersistableFadingTiers,
  resolveRunContextMeta,
  resolveRunFadingTiers,
} from './fading';

describe('isAgentFadingTier', () => {
  it('matches the actual SDK tier version', () => {
    expect(AGENT_FADING_TIER_VERSION).toBe(FADING_TIER_VERSION);
  });

  it('accepts a well-formed tier and rejects everything else', () => {
    expect(isAgentFadingTier({ v: 2, budgetTokens: 20_000, masked: true })).toBe(true);
    expect(isAgentFadingTier({ v: 1, budgetTokens: 20_000, masked: true })).toBe(true);
    expect(isCurrentAgentFadingTier({ v: 2, budgetTokens: 20_000, masked: true })).toBe(true);
    expect(isCurrentAgentFadingTier({ v: 1, budgetTokens: 20_000, masked: true })).toBe(false);
    expect(isAgentFadingTier({ v: 3, budgetTokens: 20_000, masked: true })).toBe(false);
    expect(isAgentFadingTier({ v: 2, budgetTokens: 0, masked: true })).toBe(false);
    expect(isAgentFadingTier({ v: 2, budgetTokens: 20_000, masked: 'yes' })).toBe(false);
    expect(isAgentFadingTier({ v: 2, budgetTokens: Number.NaN, masked: false })).toBe(false);
    expect(isAgentFadingTier(null)).toBe(false);
    expect(isAgentFadingTier(undefined)).toBe(false);
  });
});

describe('resolvePersistableFadingTier', () => {
  it('strips a valid tier to its fields and drops invalid input', () => {
    expect(
      resolvePersistableFadingTier({ v: 2, budgetTokens: 50_000, masked: true, extra: 1 }),
    ).toEqual({ v: 2, budgetTokens: 50_000, masked: true });
    expect(resolvePersistableFadingTier({ v: 1, budgetTokens: 50_000, masked: true })).toEqual({
      v: 1,
      budgetTokens: 50_000,
      masked: true,
    });
    expect(resolvePersistableFadingTier(undefined)).toBeUndefined();
    expect(resolvePersistableFadingTier({ v: 2, budgetTokens: -1, masked: true })).toBeUndefined();
  });
});

describe('resolvePersistableFadingTiers', () => {
  it('keeps only valid tiers, stripped to the compact shape, from own keys', () => {
    const snapshot = Object.fromEntries([
      ['agent-a', { v: 2, budgetTokens: 20_000, masked: true, latched: true }],
      ['agent-b', { v: 2, budgetTokens: 0, masked: false }],
      ['__proto__', { v: 2, budgetTokens: 10_000, masked: false, latched: true }],
    ]);
    expect(resolvePersistableFadingTiers(snapshot)).toEqual([
      { agentId: 'agent-a', v: 2, budgetTokens: 20_000, masked: true },
      { agentId: '__proto__', v: 2, budgetTokens: 10_000, masked: false },
    ]);
  });

  it('ignores inherited keys and yields nothing for an empty or invalid snapshot', () => {
    const inherited = Object.create({ ghost: { v: 2, budgetTokens: 20_000, masked: true } });
    expect(resolvePersistableFadingTiers(inherited)).toBeUndefined();
    expect(resolvePersistableFadingTiers({})).toBeUndefined();
    expect(resolvePersistableFadingTiers(null)).toBeUndefined();
    expect(resolvePersistableFadingTiers('agent-a')).toBeUndefined();
  });
});

describe('resolveRunFadingTiers', () => {
  it('rebuilds a prototype-safe record from persisted entries', () => {
    const tiers = resolveRunFadingTiers([
      { agentId: 'agent-a', v: 2, budgetTokens: 20_000, masked: true },
      { agentId: '__proto__', v: 2, budgetTokens: 10_000, masked: false },
    ]);

    expect(tiers).toBeDefined();
    expect(Object.getPrototypeOf(tiers)).toBeNull();
    expect(Object.keys(tiers ?? {})).toEqual(['agent-a', '__proto__']);
    expect(Object.prototype.hasOwnProperty.call(tiers, '__proto__')).toBe(true);
    expect(tiers?.['agent-a']).toEqual({ v: 2, budgetTokens: 20_000, masked: true });
    expect('budgetTokens' in {}).toBe(false);
  });

  it('rejects duplicate, malformed, or empty entry lists', () => {
    expect(
      resolveRunFadingTiers([
        { agentId: 'agent-a', v: 2, budgetTokens: 20_000, masked: true },
        { agentId: 'agent-a', v: 2, budgetTokens: 10_000, masked: true },
      ]),
    ).toBeUndefined();
    expect(
      resolveRunFadingTiers([{ agentId: '', v: 2, budgetTokens: 1, masked: true }]),
    ).toBeUndefined();
    expect(resolveRunFadingTiers([])).toBeUndefined();
    expect(resolveRunFadingTiers(undefined)).toBeUndefined();
  });

  it('keeps legacy entries readable but never seeds them into the v2 SDK', () => {
    const legacy = { agentId: 'old-agent', v: 1, budgetTokens: 5_000, masked: true };
    const current = { agentId: 'new-agent', v: 2, budgetTokens: 10_000, masked: false };
    expect(resolveRunFadingTiers([legacy])).toBeUndefined();
    const tiers = resolveRunFadingTiers([legacy, current]);
    expect(Object.getPrototypeOf(tiers)).toBeNull();
    expect(tiers).toEqual({ 'new-agent': { v: 2, budgetTokens: 10_000, masked: false } });
  });

  it('round-trips a run snapshot through the persisted entries unchanged', () => {
    const snapshot = {
      'agent-a': { v: 2 as const, budgetTokens: 20_000, masked: true, latched: true as const },
      'agent-b': { v: 2 as const, budgetTokens: 5_000, masked: false, latched: true as const },
    };
    const entries = resolvePersistableFadingTiers(snapshot);
    const restored = resolveRunFadingTiers(entries);
    expect(restored).toEqual({
      'agent-a': { v: 2, budgetTokens: 20_000, masked: true },
      'agent-b': { v: 2, budgetTokens: 5_000, masked: false },
    });
  });
});

describe('resolveRunContextMeta', () => {
  const fading = { v: 2, budgetTokens: 20_000, masked: true };
  const getEncoding = jest.fn(() => 'claude');

  beforeEach(() => getEncoding.mockClear());

  it('persists only compact tier and calibration metadata', () => {
    const meta = resolveRunContextMeta({
      calibrationRatio: 1.25,
      fadingTier: { ...fading, latched: true, messages: ['not persisted'] },
      fadingTiers: {
        'agent-a': { ...fading, latched: true, projection: { truncated: true } },
        'agent-b': { v: 2, budgetTokens: 5_000, masked: false, latched: true },
      },
      getEncoding,
    });

    expect(meta).toEqual({
      calibrationRatio: 1.25,
      encoding: 'claude',
      fading,
      fadingTiers: [
        { agentId: 'agent-a', v: 2, budgetTokens: 20_000, masked: true },
        { agentId: 'agent-b', v: 2, budgetTokens: 5_000, masked: false },
      ],
    });
    expect(Object.keys(meta ?? {})).toEqual([
      'calibrationRatio',
      'encoding',
      'fading',
      'fadingTiers',
    ]);
  });

  it('persists per-agent tiers alone when only a non-default agent latched one', () => {
    expect(
      resolveRunContextMeta({
        calibrationRatio: 1,
        fadingTier: undefined,
        fadingTiers: { 'agent-b': { v: 2, budgetTokens: 5_000, masked: true } },
        getEncoding,
      }),
    ).toEqual({
      calibrationRatio: 1,
      encoding: 'claude',
      fadingTiers: [{ agentId: 'agent-b', v: 2, budgetTokens: 5_000, masked: true }],
    });
  });

  it('persists a latched fading tier even at a neutral calibration ratio', () => {
    expect(resolveRunContextMeta({ calibrationRatio: 1, fadingTier: fading, getEncoding })).toEqual(
      { calibrationRatio: 1, encoding: 'claude', fading },
    );
  });

  it('persists calibration alone when the run exposes no tier', () => {
    expect(
      resolveRunContextMeta({ calibrationRatio: 1.2345, fadingTier: undefined, getEncoding }),
    ).toEqual({ calibrationRatio: 1.235, encoding: 'claude' });
  });

  it('persists nothing, without resolving the encoding, when there is nothing to keep', () => {
    expect(
      resolveRunContextMeta({ calibrationRatio: 0, fadingTier: { v: 2 }, getEncoding }),
    ).toBeUndefined();
    expect(getEncoding).not.toHaveBeenCalled();
  });
});

describe('persisted tier round trip through the SDK pruner', () => {
  const window = 20_000;
  const tokenCounter = (message: BaseMessage): number =>
    Math.ceil(JSON.stringify(message.content).length / 4);
  const countMap = (messages: BaseMessage[]): Record<string, number> =>
    Object.fromEntries(messages.map((message, index) => [String(index), tokenCounter(message)]));
  const serializeToolExchange = (context: BaseMessage[]): string =>
    JSON.stringify(
      context
        .filter((message) => message._getType() === 'tool' || message._getType() === 'ai')
        .map((message) => [message._getType(), message.content, message.additional_kwargs]),
    );
  /** Fresh instances per run: the pruner rewrites the messages it is handed, as the Graph's per-Run projection clone allows. */
  const makeTurnOne = (): BaseMessage[] => [
    new HumanMessage('Fetch the alpha report and summarize it.'),
    new AIMessage({
      content: '',
      tool_calls: [{ id: 'call-1', name: 'fetch_report', args: { name: 'alpha' } }],
    }),
    new ToolMessage({
      tool_call_id: 'call-1',
      name: 'fetch_report',
      content: Array.from(
        { length: 4_000 },
        (_, i) => `row ${i}: value ${(i * 7919) % 10007}`,
      ).join('\n'),
    }),
    new AIMessage('The alpha report lists 4000 rows.'),
  ];
  const prune = (
    messages: BaseMessage[],
    overrides: {
      calibrationRatio: number;
      instructionTokens: number;
      fadingTier?: IAgentFadingTier;
    },
  ) =>
    createPruneMessages({
      startIndex: messages.length,
      tokenCounter,
      maxTokens: window,
      indexTokenCountMap: countMap(messages),
      summarizationEnabled: true,
      calibrationRatio: overrides.calibrationRatio,
      getInstructionTokens: () => overrides.instructionTokens,
      ...(isCurrentAgentFadingTier(overrides.fadingTier)
        ? { fadingTier: overrides.fadingTier }
        : {}),
    })({ messages });

  it("reproduces the first run's projection bytes when the next run is seeded from contextMeta", () => {
    const turnOne = makeTurnOne();
    const first = prune(turnOne, { calibrationRatio: 1, instructionTokens: 12_000 });
    expect(first.fadingTier.v).toBe(2);
    expect(first.fadingTier.budgetTokens).toBeLessThan(window);

    const meta = resolveRunContextMeta({
      calibrationRatio: first.calibrationRatio ?? 1,
      fadingTier: first.fadingTier,
      getEncoding: () => 'claude',
    });
    expect(meta?.fading).toEqual({
      v: 2,
      budgetTokens: first.fadingTier.budgetTokens,
      masked: first.fadingTier.masked,
    });
    expect(resolveFadingCaps(seedFadingTier(window, meta?.fading))).toEqual(
      resolveFadingCaps(first.fadingTier),
    );

    const makeTurnTwo = (): BaseMessage[] => [
      ...makeTurnOne(),
      new HumanMessage('Thanks. Anything else?'),
      new AIMessage('No.'),
      new HumanMessage('Say ok.'),
    ];
    const firstBytes = serializeToolExchange(first.context);
    const legacySeed = prune(makeTurnTwo(), {
      calibrationRatio: 1,
      instructionTokens: 9_000,
      fadingTier: { v: 1, budgetTokens: first.fadingTier.budgetTokens, masked: true },
    });
    expect(legacySeed.fadingTier.v).toBe(2);
    expect(legacySeed.fadingTier.budgetTokens).toBeGreaterThan(first.fadingTier.budgetTokens);
    const drifted = { calibrationRatio: 1, instructionTokens: 9_000 };
    const seeded = prune(makeTurnTwo(), { ...drifted, fadingTier: meta?.fading });
    expect(serializeToolExchange(seeded.context.slice(0, turnOne.length))).toBe(firstBytes);
    expect(seeded.fadingTier.budgetTokens).toBe(first.fadingTier.budgetTokens);

    const recalibrated = prune(makeTurnTwo(), {
      calibrationRatio: 1.2,
      instructionTokens: 9_000,
      fadingTier: meta?.fading,
    });
    expect(serializeToolExchange(recalibrated.context.slice(0, turnOne.length))).toBe(firstBytes);

    const unseeded = prune(makeTurnTwo(), drifted);
    expect(unseeded.fadingTier.budgetTokens).toBeGreaterThan(first.fadingTier.budgetTokens);
    expect(serializeToolExchange(unseeded.context.slice(0, turnOne.length))).not.toBe(firstBytes);
  });
});
