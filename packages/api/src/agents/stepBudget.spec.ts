import type { PostToolBatchHookInput, PostToolBatchHookOutput } from '@librechat/agents';
import { createStepBudgetHook, remainingToolRounds, buildBudgetNotice } from './stepBudget';

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

function batch(toolNames: string[] = ['search']): PostToolBatchHookInput {
  return {
    hook_event_name: 'PostToolBatch',
    runId: 'run-1',
    entries: toolNames.map((toolName, index) => ({
      toolName,
      toolInput: {},
      toolUseId: `t${index}`,
      status: 'success',
    })),
  };
}

const signal = new AbortController().signal;

/** Drives `rounds` tool batches through one hook and returns each round's context. */
async function drain(recursionLimit: number, rounds: number): Promise<Array<string | undefined>> {
  const hook = createStepBudgetHook({ recursionLimit });
  const emitted: Array<string | undefined> = [];
  for (let i = 0; i < rounds; i++) {
    const output: PostToolBatchHookOutput = await hook(batch(), signal);
    emitted.push(output.additionalContext);
  }
  return emitted;
}

describe('remainingToolRounds', () => {
  it('reserves a step for the final answer so a budget is never spent entirely on tools', () => {
    /** 50 steps: round 24 ends on step 48, leaving step 49 to answer. */
    expect(remainingToolRounds(50, 24)).toBe(0);
    expect(remainingToolRounds(50, 23)).toBe(1);
  });

  it('never reports negative headroom once the budget is already overspent', () => {
    expect(remainingToolRounds(50, 25)).toBe(0);
    expect(remainingToolRounds(50, 400)).toBe(0);
  });

  it('reports no headroom for a limit too small to afford a round plus an answer', () => {
    expect(remainingToolRounds(2, 0)).toBe(0);
    expect(remainingToolRounds(3, 1)).toBe(0);
  });

  it('decreases by exactly one round per round spent', () => {
    const start = remainingToolRounds(101, 0);
    expect(start - remainingToolRounds(101, 1)).toBe(1);
    expect(remainingToolRounds(101, 1) - remainingToolRounds(101, 2)).toBe(1);
  });
});

describe('createStepBudgetHook', () => {
  it('stays silent while the budget is ample, so an ordinary turn never sees a notice', async () => {
    const emitted = await drain(50, 20);
    expect(emitted.every((context) => context === undefined)).toBe(true);
  });

  it('counts rounds, not calls: a parallel batch costs one round', async () => {
    const hook = createStepBudgetHook({ recursionLimit: 9 });

    /** 9 steps affords 4 rounds; one batch of three calls must consume only one. */
    expect(await hook(batch(['a', 'b', 'c']), signal)).toEqual({
      additionalContext: buildBudgetNotice(3),
    });
  });

  it('counts down over the final rounds instead of repeating one warning', async () => {
    const emitted = await drain(50, 24);
    const warnings = emitted.filter((context): context is string => context != null);

    expect(warnings).toEqual([
      buildBudgetNotice(3),
      buildBudgetNotice(2),
      buildBudgetNotice(1),
      buildBudgetNotice(0),
    ]);
    expect(new Set(warnings).size).toBe(warnings.length);
  });

  it('tells the model to stop calling tools once nothing is left for a result', async () => {
    const emitted = await drain(50, 24);
    const last = emitted[emitted.length - 1];

    expect(last).toContain('no tool-calling budget left');
    expect(last).toContain('Do not call any more tools');
  });

  it('warns from the very first round when the configured limit is tiny', async () => {
    /** 7 steps affords 3 rounds, so round 1 already sits inside the warning band. */
    const emitted = await drain(7, 1);
    expect(emitted[0]).toBe(buildBudgetNotice(2));
  });

  it('keeps warning after the budget is blown rather than falling silent', async () => {
    const emitted = await drain(50, 30);
    expect(emitted.slice(24).every((context) => context === buildBudgetNotice(0))).toBe(true);
  });

  it('tracks each run independently', async () => {
    const first = createStepBudgetHook({ recursionLimit: 7 });
    const second = createStepBudgetHook({ recursionLimit: 7 });

    /** Spends the first run's whole budget. */
    await first(batch(), signal);
    await first(batch(), signal);
    expect(await first(batch(), signal)).toEqual({ additionalContext: buildBudgetNotice(0) });

    /** The second run must still see a full budget, not the first run's tally. */
    expect(await second(batch(), signal)).toEqual({ additionalContext: buildBudgetNotice(2) });
  });

  it('does not count an empty batch against the budget', async () => {
    const hook = createStepBudgetHook({ recursionLimit: 7 });

    expect(await hook(batch([]), signal)).toEqual({});
    expect(await hook(batch(), signal)).toEqual({ additionalContext: buildBudgetNotice(2) });
  });

  it('does not count a subagent-scoped batch against the parent budget', async () => {
    const hook = createStepBudgetHook({ recursionLimit: 7 });

    expect(await hook({ ...batch(), agentId: 'child' }, signal)).toEqual({});
    expect(await hook(batch(), signal)).toEqual({ additionalContext: buildBudgetNotice(2) });
  });
});

describe('buildBudgetNotice', () => {
  it('hedges the estimate, because unseen graph nodes can also spend steps', () => {
    expect(buildBudgetNotice(3)).toContain('about 3 more tool-calling rounds');
  });

  it('drops the hedge when exactly one round remains', () => {
    expect(buildBudgetNotice(1)).toContain('1 more tool-calling round left');
    expect(buildBudgetNotice(1)).not.toContain('about');
  });
});
