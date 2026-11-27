/**
 * Live host-layer verification: real Anthropic run through the actual
 * getDefaultHandlers pipeline, asserting the SSE usage/context events the
 * client consumes and their resume persistence.
 *
 * Run with:
 * RUN_USAGE_LIVE_TESTS=1 ANTHROPIC_API_KEY=... npx jest usageEvents.live --runInBand
 */
const { HumanMessage } = require('@langchain/core/messages');
const { Run, Providers, GraphEvents } = require('@librechat/agents');
const { GenerationJobManager } = require('@librechat/api');
const { getDefaultHandlers } = require('~/server/controllers/agents/callbacks');

jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'mock-nanoid'),
}));

jest.mock('~/server/services/Files/Citations', () => ({
  processFileCitations: jest.fn(),
}));

jest.mock('~/server/services/Files/Code/process', () => ({
  processCodeOutput: jest.fn(),
  runPreviewFinalize: jest.fn(),
}));

jest.mock('~/server/services/Files/process', () => ({
  saveBase64Image: jest.fn(),
}));

const shouldRunLive =
  process.env.RUN_USAGE_LIVE_TESTS === '1' &&
  process.env.ANTHROPIC_API_KEY != null &&
  process.env.ANTHROPIC_API_KEY !== '';

const describeIfLive = shouldRunLive ? describe : describe.skip;
const modelName = process.env.ANTHROPIC_USAGE_LIVE_MODEL ?? 'claude-haiku-4-5';
const hasContextUsageEvent = GraphEvents.ON_CONTEXT_USAGE != null;

const charCounter = (msg) => {
  const content = msg.content;
  if (typeof content === 'string') {
    return Math.ceil(content.length / 4) + 3;
  }
  if (Array.isArray(content)) {
    let length = 3;
    for (const part of content) {
      if (typeof part === 'string') {
        length += Math.ceil(part.length / 4);
      } else if (typeof part?.text === 'string') {
        length += Math.ceil(part.text.length / 4);
      }
    }
    return length;
  }
  return 3;
};

function createMockRes() {
  const events = [];
  return {
    events,
    headersSent: true,
    writableEnded: false,
    write(payload) {
      for (const line of String(payload).split('\n')) {
        if (line.startsWith('data: ')) {
          events.push(JSON.parse(line.slice(6)));
        }
      }
      return true;
    },
  };
}

describeIfLive('live usage events through the host pipeline', () => {
  jest.setTimeout(120000);

  afterAll(async () => {
    await GenerationJobManager.destroy();
  });

  test('streams real provider usage and persists it for resume', async () => {
    const streamId = `usage-live-${Date.now()}`;
    await GenerationJobManager.createJob(streamId, 'user-live', 'convo-live');

    /** streamId mode routes events through the job emitter — capture them
     *  as a subscribed resumable client would, not via res.write */
    const res = createMockRes();
    await GenerationJobManager.subscribe(streamId, (event) => {
      res.events.push(event);
    });
    const collectedUsage = [];
    const handlers = getDefaultHandlers({
      res,
      aggregateContent: () => {},
      toolEndCallback: () => {},
      collectedUsage,
      streamId,
    });

    const run = await Run.create({
      runId: 'usage-live-response',
      graphConfig: {
        type: 'standard',
        llmConfig: {
          provider: Providers.ANTHROPIC,
          model: modelName,
          apiKey: process.env.ANTHROPIC_API_KEY,
          temperature: 0,
          maxTokens: 64,
          streaming: true,
          streamUsage: true,
        },
        instructions: 'You are concise. Reply with one short sentence.',
        maxContextTokens: 8000,
      },
      returnContent: true,
      customHandlers: handlers,
      tokenCounter: charCounter,
      indexTokenCountMap: {},
    });

    await run.processStream(
      { messages: [new HumanMessage('Say hello in five words or fewer.')] },
      {
        configurable: { thread_id: 'usage-live-thread', user_id: 'user-live' },
        streamMode: 'values',
        version: 'v2',
      },
    );

    const usageEvents = res.events.filter((e) => e.event === 'on_token_usage');
    expect(usageEvents).toHaveLength(1);
    const usage = usageEvents[0].data;
    expect(usage.input_tokens).toBeGreaterThan(0);
    expect(usage.output_tokens).toBeGreaterThan(0);
    expect(usage.provider).toBe(Providers.ANTHROPIC);
    expect(usage.model).toBe(modelName);
    expect(collectedUsage).toHaveLength(1);
    expect(usage.input_tokens).toBe(collectedUsage[0].input_tokens);

    if (hasContextUsageEvent) {
      const contextEvents = res.events.filter((e) => e.event === 'on_context_usage');
      expect(contextEvents).toHaveLength(1);
      const snapshot = contextEvents[0].data;
      expect(snapshot.breakdown.maxContextTokens).toBe(8000);
      const estimatedUsed = snapshot.contextBudget - snapshot.remainingContextTokens;
      expect(estimatedUsed).toBeGreaterThan(0);
      expect(estimatedUsed / usage.input_tokens).toBeGreaterThan(0.2);
      expect(estimatedUsed / usage.input_tokens).toBeLessThan(5);
    }

    const resumeState = await GenerationJobManager.getResumeState(streamId);
    expect(resumeState.collectedUsage).toHaveLength(1);
    expect(resumeState.collectedUsage[0].input_tokens).toBe(usage.input_tokens);
    if (hasContextUsageEvent) {
      expect(resumeState.contextUsage.breakdown.maxContextTokens).toBe(8000);
    }
  });
});
