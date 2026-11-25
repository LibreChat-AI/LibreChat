import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';

jest.spyOn(console, 'log').mockImplementation();

function createInMemoryManager(): GenerationJobManagerClass {
  const manager = new GenerationJobManagerClass();
  manager.configure({
    jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
  });
  manager.initialize();
  return manager;
}

const makeSnapshot = (messageTokens: number) => ({
  runId: 'run-1',
  agentId: 'agent-1',
  breakdown: {
    maxContextTokens: 200000,
    instructionTokens: 1500,
    systemMessageTokens: 1000,
    dynamicInstructionTokens: 0,
    toolSchemaTokens: 500,
    summaryTokens: 0,
    toolCount: 3,
    messageCount: 4,
    messageTokens,
    availableForMessages: 188500,
  },
  contextBudget: 190000,
  effectiveInstructionTokens: 1500,
  prePruneContextTokens: messageTokens,
  remainingContextTokens: 190000 - 1500 - messageTokens,
  calibrationRatio: 1.05,
});

describe('GenerationJobManager usage resume state', () => {
  let manager: GenerationJobManagerClass | undefined;

  afterEach(async () => {
    await manager?.destroy();
    manager = undefined;
  });

  test('accumulates persisted token usage events in resume state', async () => {
    manager = createInMemoryManager();
    const streamId = `usage-resume-${Date.now()}`;
    await manager.createJob(streamId, 'user-1', streamId);

    const firstUsage = {
      input_tokens: 1200,
      output_tokens: 300,
      input_token_details: { cache_creation: 100, cache_read: 800 },
      model: 'claude-3-5-sonnet',
      provider: 'anthropic',
    };
    const secondUsage = {
      input_tokens: 1600,
      output_tokens: 120,
      model: 'claude-3-5-sonnet',
      provider: 'anthropic',
      usage_type: 'summarization',
    };

    await manager.emitChunk(streamId, { event: 'on_token_usage', data: firstUsage });
    await manager.emitChunk(streamId, { event: 'on_token_usage', data: secondUsage });

    const resumeState = await manager.getResumeState(streamId);
    expect(resumeState?.collectedUsage).toEqual([firstUsage, secondUsage]);
  });

  test('omits collected usage when none was recorded', async () => {
    manager = createInMemoryManager();
    const streamId = `usage-resume-empty-${Date.now()}`;
    await manager.createJob(streamId, 'user-1', streamId);

    const resumeState = await manager.getResumeState(streamId);
    expect(resumeState?.collectedUsage).toBeUndefined();
    expect(resumeState?.contextUsage).toBeUndefined();
  });

  test('restores final primary call details without replaying usage', async () => {
    manager = createInMemoryManager();
    const streamId = `context-call-resume-${Date.now()}`;
    await manager.createJob(streamId, 'user-1', streamId);
    await manager.emitChunk(streamId, { event: 'on_context_usage', data: makeSnapshot(9000) });
    const primary = {
      runId: 'run-1',
      input_tokens: 10000,
      output_tokens: 300,
      input_token_details: { cache_creation: 100, cache_read: 800 },
      model: 'primary-model',
      provider: 'anthropic',
    };
    await manager.emitChunk(streamId, { event: 'on_token_usage', data: primary });
    await manager.emitChunk(streamId, {
      event: 'on_token_usage',
      data: { ...primary, runId: 'other-run', model: 'other-model' },
    });
    await manager.emitChunk(streamId, {
      event: 'on_token_usage',
      data: { ...primary, usage_type: 'subagent', model: 'child-model' },
    });

    const resumeState = await manager.getResumeState(streamId);
    expect(resumeState?.contextUsage).toMatchObject({
      model: 'primary-model',
      provider: 'anthropic',
      resumedOutputTokens: 300,
      cacheRead: 800,
      cacheWrite: 100,
      remainingContextTokens: 180000,
      breakdown: { messageTokens: 8500 },
    });
    expect(resumeState?.contextUsage?.completedOutputTokens).toBeUndefined();
    expect(resumeState?.collectedUsage).toHaveLength(3);

    await manager.emitChunk(streamId, { event: 'on_context_usage', data: makeSnapshot(12000) });
    const midCall = await manager.getResumeState(streamId);
    expect(midCall?.contextUsage).toEqual(makeSnapshot(12000));
    await manager.emitChunk(streamId, {
      event: 'on_token_usage',
      data: { ...primary, input_token_details: {}, model: 'next-model' },
    });
    const nextCall = await manager.getResumeState(streamId);
    expect(nextCall?.contextUsage).toMatchObject({
      cacheRead: 0,
      cacheWrite: 0,
      model: 'next-model',
    });
  });

  test('persists the latest context usage snapshot for resume', async () => {
    manager = createInMemoryManager();
    const streamId = `context-resume-${Date.now()}`;
    await manager.createJob(streamId, 'user-1', streamId);

    await manager.emitChunk(streamId, { event: 'on_context_usage', data: makeSnapshot(4000) });
    await manager.emitChunk(streamId, { event: 'on_context_usage', data: makeSnapshot(9000) });

    const resumeState = await manager.getResumeState(streamId);
    expect(resumeState?.contextUsage).toEqual(makeSnapshot(9000));
  });
});
