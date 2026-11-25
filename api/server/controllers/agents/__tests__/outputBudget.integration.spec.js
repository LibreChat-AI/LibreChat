const { ChatGenerationChunk } = require('@langchain/core/outputs');
const { HumanMessage, AIMessageChunk } = require('@langchain/core/messages');
const { Run, Providers, FakeChatModel, createContentAggregator } = require('@librechat/agents');
const { settleOutputTruncation } = require('@librechat/api');
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

/**
 * Streams one Gemini turn the way the Google stream adapter shapes it: thoughts ride in
 * `additional_kwargs.reasoning`, and the candidate's raw `finishReason` arrives as generation info
 * on the last chunk, which LangChain merges into the message's `response_metadata`.
 */
class GeminiBudgetFakeModel extends FakeChatModel {
  constructor({ text, finishReason }) {
    super({ responses: [''] });
    this.answer = text;
    this.finishReason = finishReason;
  }

  async *_streamResponseChunks() {
    yield new ChatGenerationChunk({
      text: '',
      message: new AIMessageChunk({
        content: '',
        additional_kwargs: { reasoning: 'Working through the problem step by step.' },
      }),
    });
    yield new ChatGenerationChunk({
      text: this.answer,
      message: new AIMessageChunk({
        content: this.answer,
        usage_metadata: { input_tokens: 40, output_tokens: 512, total_tokens: 552 },
      }),
      generationInfo: { index: 0, finishReason: this.finishReason },
    });
  }
}

function createMockRes() {
  return { headersSent: true, writableEnded: false, write: () => true };
}

const runConfig = {
  configurable: { thread_id: 'output-budget-thread', user_id: 'user-1' },
  streamMode: 'values',
  version: 'v2',
};

function createHandlers(truncationSink) {
  const { aggregateContent, contentParts } = createContentAggregator();
  const handlers = getDefaultHandlers({
    res: createMockRes(),
    aggregateContent,
    toolEndCallback: () => {},
    collectedUsage: [],
    truncationSink,
  });
  return { handlers, contentParts };
}

async function runGeminiTurn({ text, finishReason, truncationSink }) {
  const { handlers, contentParts } = createHandlers(truncationSink);
  const run = await Run.create({
    runId: 'output-budget-response',
    graphConfig: {
      type: 'standard',
      llmConfig: { provider: Providers.OPENAI, model: 'gpt-4o-mini', streaming: true },
      instructions: 'You are a helpful assistant.',
    },
    returnContent: true,
    customHandlers: handlers,
  });
  run.Graph.overrideModel = new GeminiBudgetFakeModel({ text, finishReason });
  await run.processStream({ messages: [new HumanMessage('Prove the conjecture.')] }, runConfig);
  return contentParts;
}

/** Two parallel agents on one model: the first call runs out of budget, the second answers later. */
class ParallelAgentsFakeModel extends FakeChatModel {
  constructor() {
    super({ responses: [''] });
    this.calls = 0;
  }

  async *_streamResponseChunks() {
    this.calls += 1;
    const exhausted = this.calls === 1;
    if (!exhausted) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const text = exhausted ? '' : 'Full answer from the second agent.';
    yield new ChatGenerationChunk({
      text,
      message: new AIMessageChunk({
        content: text,
        usage_metadata: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
      }),
      generationInfo: { index: 0, finishReason: exhausted ? 'MAX_TOKENS' : 'STOP' },
    });
  }
}

describe('Gemini output budget through the agents pipeline (issue #18649)', () => {
  it.each(['MAX_TOKENS', 'CONTINUATION'])(
    'records a %s turn that wrote no answer and settles it into the code-only error part',
    async (finishReason) => {
      const truncationSink = {};
      const contentParts = await runGeminiTurn({ text: '', finishReason, truncationSink });
      expect(Object.values(truncationSink.calls)).toEqual(['exhausted']);

      expect(settleOutputTruncation(truncationSink, contentParts)).toBeUndefined();
      expect(contentParts.at(-1)).toEqual({
        type: 'error',
        error: JSON.stringify({ type: 'output_budget_exhausted' }),
      });
    },
  );

  it('settles an answer cut off mid-way as a length finish', async () => {
    const truncationSink = {};
    const contentParts = await runGeminiTurn({
      text: 'The proof begins with',
      finishReason: 'MAX_TOKENS',
      truncationSink,
    });
    expect(settleOutputTruncation(truncationSink, contentParts)).toEqual({
      finish_reason: 'length',
    });
  });

  it('leaves a completed turn unstamped', async () => {
    const truncationSink = {};
    const contentParts = await runGeminiTurn({
      text: 'Done.',
      finishReason: 'STOP',
      truncationSink,
    });
    expect(Object.values(truncationSink.calls)).toEqual(['complete']);
    expect(settleOutputTruncation(truncationSink, contentParts)).toBeUndefined();
  });

  it('lets a parallel agent finish its answer when another one runs out of budget, and reports both', async () => {
    const truncationSink = {};
    const { handlers, contentParts } = createHandlers(truncationSink);
    const agent = (agentId) => ({
      agentId,
      provider: Providers.OPENAI,
      clientOptions: { model: 'gpt-4o-mini', streaming: true },
      instructions: `You are ${agentId}.`,
    });
    const run = await Run.create({
      runId: 'output-budget-parallel',
      graphConfig: { type: 'multi-agent', agents: [agent('A'), agent('B')], edges: [] },
      returnContent: true,
      customHandlers: handlers,
    });
    run.Graph.overrideModel = new ParallelAgentsFakeModel();

    await run.processStream({ messages: [new HumanMessage('Question')] }, runConfig);

    expect(contentParts.filter((part) => part?.type === 'text').map((part) => part.text)).toEqual([
      'Full answer from the second agent.',
    ]);
    /** The agent that ran out of budget still gets its notice beside the other's answer. */
    expect(Object.values(truncationSink.calls).sort()).toEqual(['complete', 'exhausted']);
    expect(settleOutputTruncation(truncationSink, contentParts)).toBeUndefined();
    expect(contentParts.filter((part) => part?.type === 'error')).toHaveLength(1);
  });
});
