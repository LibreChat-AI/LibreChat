import { Providers } from '@librechat/agents';
import {
  planInstructions,
  buildAdditionalInstructions,
  sdkMovesDynamicInstructions,
} from './instructionPlan';

describe('buildAdditionalInstructions', () => {
  it('places dynamic tool context after static additional instructions', () => {
    const result = buildAdditionalInstructions(
      'Artifacts prompt',
      'Conversation Date & Time: 2025-01-01T00:00:00.000Z',
    );

    expect(result).toBe('Artifacts prompt\nConversation Date & Time: 2025-01-01T00:00:00.000Z');
  });

  it('keeps the static prefix identical when only the dynamic context changes', () => {
    const first = buildAdditionalInstructions('Artifacts prompt', 'Time: 1');
    const second = buildAdditionalInstructions('Artifacts prompt', 'Time: 2');

    expect(first.startsWith('Artifacts prompt\n')).toBe(true);
    expect(second.startsWith('Artifacts prompt\n')).toBe(true);
  });

  it('handles missing additional instructions and empty dynamic context', () => {
    expect(buildAdditionalInstructions(undefined, 'Time: 1')).toBe('Time: 1');
    expect(buildAdditionalInstructions('Artifacts prompt', '')).toBe('Artifacts prompt');
    expect(buildAdditionalInstructions(undefined, '')).toBe('');
  });
});

describe('sdkMovesDynamicInstructions', () => {
  it.each([Providers.ANTHROPIC, Providers.OPENROUTER])(
    'is true for %s with promptCache enabled',
    (provider) => {
      expect(sdkMovesDynamicInstructions(provider, { promptCache: true })).toBe(true);
    },
  );

  it.each([Providers.ANTHROPIC, Providers.OPENROUTER])(
    'is false for %s without promptCache',
    (provider) => {
      expect(sdkMovesDynamicInstructions(provider, {})).toBe(false);
      expect(sdkMovesDynamicInstructions(provider, { promptCache: false })).toBe(false);
      expect(sdkMovesDynamicInstructions(provider, { promptCache: 'true' })).toBe(false);
      expect(sdkMovesDynamicInstructions(provider, undefined)).toBe(false);
    },
  );

  it.each([Providers.OPENAI, Providers.BEDROCK, Providers.GOOGLE, Providers.AZURE, 'custom'])(
    'is false for %s even with promptCache',
    (provider) => {
      expect(sdkMovesDynamicInstructions(provider, { promptCache: true })).toBe(false);
    },
  );

  it('is false without a provider', () => {
    expect(sdkMovesDynamicInstructions(undefined, { promptCache: true })).toBe(false);
  });
});

describe('planInstructions', () => {
  const STABLE = 'Static artifacts prompt.';
  const VOLATILE = 'Memory: prefers metric units.';
  const RUNTIME = 'Conversation started: 2026-03-09 23:00 +03:00 (Mon)';
  const QUEUED_KEY = 'queued_files';
  const base = {
    isSubagent: false,
    provider: Providers.ANTHROPIC,
    clientOptions: { promptCache: true },
    toolInstructions: 'Tool guide.',
    instructions: 'Base instructions.',
    additionalInstructions: `${VOLATILE}\n\n${STABLE}`,
    dynamicContextMap: { web_search: RUNTIME, [QUEUED_KEY]: 'queued.csv' },
    oneTurnContextKey: QUEUED_KEY,
    split: {
      stable: STABLE,
      volatile: VOLATILE,
      source: `${VOLATILE}\n\n${STABLE}`,
    },
  };

  it('puts dynamic tool context ahead of additional instructions when stableContext is off', () => {
    const plan = planInstructions({ ...base, stableContext: false });
    expect(plan.instructions).toBe('Tool guide.\nBase instructions.');
    expect(plan.additionalInstructions).toBe(`${RUNTIME}\nqueued.csv\n${VOLATILE}\n\n${STABLE}`);
  });

  it('merges the stable part and keeps the volatile and one-turn parts moved', () => {
    const plan = planInstructions({ ...base, stableContext: true });
    expect(plan.instructions).toBe(`Tool guide.\nBase instructions.\n\n${STABLE}\n${RUNTIME}`);
    expect(plan.additionalInstructions).toBe(`${VOLATILE}\n\nqueued.csv`);
  });

  it('does not merge for a subagent, an uncached provider, or a stale split', () => {
    for (const override of [
      { isSubagent: true },
      { provider: Providers.OPENAI },
      { clientOptions: {} },
      { additionalInstructions: `${VOLATILE}\n\n${STABLE}\n\nAdded later.` },
    ]) {
      const plan = planInstructions({ ...base, stableContext: true, ...override });
      expect(plan.instructions).toBe('Tool guide.\nBase instructions.');
      expect(plan.additionalInstructions).toContain(RUNTIME);
      expect(plan.additionalInstructions).toContain('queued.csv');
    }
  });

  it('treats all additional instructions as stable when no split was recorded', () => {
    const plan = planInstructions({
      ...base,
      stableContext: true,
      additionalInstructions: STABLE,
      split: undefined,
    });
    expect(plan.instructions).toBe(`Tool guide.\nBase instructions.\n\n${STABLE}\n${RUNTIME}`);
    expect(plan.additionalInstructions).toBe('queued.csv');
  });

  it('keeps a split whose stable part is empty from duplicating the volatile part', () => {
    const plan = planInstructions({
      ...base,
      stableContext: true,
      additionalInstructions: VOLATILE,
      split: { volatile: VOLATILE, source: VOLATILE },
    });
    expect(plan.instructions).toBe(`Tool guide.\nBase instructions.\n\n${RUNTIME}`);
    expect(plan.additionalInstructions).toBe(`${VOLATILE}\n\nqueued.csv`);
  });
});
