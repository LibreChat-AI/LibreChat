const mockCreateRun = jest.fn();
const mockRuntimeCounter = jest.fn((counter) => counter);
const mockCountFormattedMessageTokens = jest.fn(
  (message) => JSON.stringify(message?.content ?? '').length,
);
const mockFormatAgentMessages = jest.fn(() => ({
  messages: [],
  indexTokenCountMap: {},
  summary: undefined,
  boundaryTokenAdjustment: undefined,
}));
const mockFormatInstructions = jest.fn().mockResolvedValue('');

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  createMetadataAggregator: () => ({ handleLLMEnd: jest.fn(), collected: [] }),
  formatAgentMessages: (...args) => mockFormatAgentMessages(...args),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  checkAccess: jest.fn(),
  withRetainedAnswerTokenCounter: (...args) => mockRuntimeCounter(...args),
  prepareRetainedAnswers: (input) =>
    jest.requireActual('@librechat/api').prepareRetainedAnswers({
      ...input,
      countTokens: (text) => mockCountFormattedMessageTokens({ role: 'user', content: text }),
    }),
  createRun: (...args) => mockCreateRun(...args),
  countFormattedMessageTokens: (...args) => mockCountFormattedMessageTokens(...args),
  countTokens: jest.fn((text) => Math.ceil(String(text ?? '').length / 4)),
  createCachedTokenCounter: jest.fn(async () => mockCountFormattedMessageTokens),
  getAgentCheckpointer: jest.fn(),
  hasDurableAgentInterruptCheckpoint: jest.fn().mockResolvedValue(true),
  initializeAgent: jest.fn(),
  isHITLEnabled: jest.fn(() => false),
  loadAgent: jest.fn(),
  maybePrewarmCodeSandbox: jest.fn(),
}));

jest.mock('~/server/services/Config', () => ({ getMCPServerTools: jest.fn() }));
jest.mock('~/server/services/MCP', () => ({
  resolveConfigServers: jest.fn().mockResolvedValue({}),
}));
jest.mock('~/models', () => ({
  bulkInsertTransactions: jest.fn(),
  getCacheMultiplier: jest.fn(),
  getAgent: jest.fn(),
  getMultiplier: jest.fn(),
  getFiles: jest.fn(),
  getMessages: jest.fn(),
  getRoleByName: jest.fn(),
  getUserMemories: jest.fn(),
  getFormattedMemories: jest.fn(),
  isAgentTriggerPrincipalActive: jest.fn().mockResolvedValue(true),
  spendStructuredTokens: jest.fn(),
  spendTokens: jest.fn(),
  updateBalance: jest.fn(),
}));
jest.mock('~/config', () => ({
  getMCPManager: jest.fn(() => ({ formatInstructionsForContext: mockFormatInstructions })),
}));

const { Constants, ContentTypes, EModelEndpoint } = require('librechat-data-provider');
const { getMessages } = require('~/models');
const AgentClient = require('../client');
const { applyRetainedAnswers, GenerationJobManager } = jest.requireActual('@librechat/api');
const { formatAgentMessages } = jest.requireActual('@librechat/agents');

async function buildPrompt(client, rows, parent) {
  const built = await client.buildMessages(rows, parent, {});
  const formatted = formatAgentMessages(built.prompt, client.indexTokenCountMap);
  const applied = applyRetainedAnswers({
    block: client.retainedAnswers?.block,
    ...formatted,
    tokenCounter: mockCountFormattedMessageTokens,
  });
  return {
    ...built,
    prompt: applied.messages,
    counts: applied.indexTokenCountMap,
    memoryMessages: formatted.messages,
  };
}

const ANSWER_LINE = 'Q: Which environment should I deploy to?\nA: staging';
const LATEST_TEXT = 'what is next?';

function askPart(request, output, id) {
  return {
    type: ContentTypes.TOOL_CALL,
    tool_call: {
      id,
      name: 'ask_user_question',
      args: JSON.stringify(request),
      output,
      progress: 1,
    },
  };
}

/** The text a formatted message carries, whether its content is a string or parts. */
function contentText(message) {
  const content = message?.content;
  if (typeof content === 'string') {
    return content;
  }
  return (content ?? [])
    .filter((part) => part?.type === ContentTypes.TEXT)
    .map((part) => part.text)
    .join('\n');
}

function latestUserMessage() {
  return {
    messageId: 'u3',
    parentMessageId: 'a2',
    sender: 'User',
    text: LATEST_TEXT,
    isCreatedByUser: true,
  };
}

/**
 * A branch whose answered question sits BEFORE a checkpoint summary: the prompt
 * builder's history walk stops at the summary, so the model no longer sees the
 * message that carried the answer.
 */
function compactedBranch() {
  return [
    {
      messageId: 'u1',
      parentMessageId: Constants.NO_PARENT,
      sender: 'User',
      text: 'deploy the app',
      isCreatedByUser: true,
    },
    {
      messageId: 'a1',
      parentMessageId: 'u1',
      sender: 'Agent',
      isCreatedByUser: false,
      content: [
        { type: ContentTypes.TEXT, text: 'Let me check.' },
        askPart(
          { questions: [{ id: 'environment', question: 'Which environment should I deploy to?' }] },
          JSON.stringify({ answers: { environment: 'staging' } }),
          'tc-1',
        ),
      ],
    },
    {
      messageId: 'u2',
      parentMessageId: 'a1',
      sender: 'User',
      text: 'go on',
      isCreatedByUser: true,
    },
    {
      messageId: 'a2',
      parentMessageId: 'u2',
      sender: 'Agent',
      isCreatedByUser: false,
      content: [
        { type: ContentTypes.SUMMARY, text: 'Earlier context, compacted.', tokenCount: 5 },
        { type: ContentTypes.TEXT, text: 'Deployed.' },
      ],
    },
    latestUserMessage(),
  ];
}

function makeClient(agentsConfig = {}) {
  const client = new AgentClient({
    req: {
      user: { id: 'user-123' },
      body: { endpoint: EModelEndpoint.agents },
      config: { endpoints: { [EModelEndpoint.agents]: agentsConfig } },
    },
    res: {},
    agent: {
      id: 'agent-123',
      endpoint: EModelEndpoint.openAI,
      provider: EModelEndpoint.openAI,
      instructions: 'Base agent instructions',
      model_parameters: { model: 'gpt-4' },
      tools: [],
    },
    endpoint: EModelEndpoint.agents,
    endpointTokenConfig: {},
    eventHandlers: {},
    contentParts: [],
    collectedUsage: [],
    artifactPromises: [],
  });
  client.conversationId = 'convo-123';
  client.responseMessageId = 'response-123';
  client.shouldSummarize = true;
  client.maxContextTokens = 4096;
  client.recordCollectedUsage = jest.fn().mockResolvedValue();
  return client;
}

describe('AgentClient retained answers', () => {
  afterAll(async () => {
    await GenerationJobManager.destroy();
  });

  const ROW_QUERY = [
    { conversationId: 'convo-123', user: 'user-123' },
    'messageId parentMessageId content isCreatedByUser isUserSubmitted userSubmittedPaths userSubmittedMessageFieldPaths',
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockFormatInstructions.mockResolvedValue('');
    getMessages.mockResolvedValue([]);
  });

  it('completes the branch the history read cut at the summary and quotes the answer in the user turn', async () => {
    const client = makeClient();
    client.user = 'user-123';
    client.processMemory = jest.fn();
    const rows = compactedBranch();
    getMessages.mockResolvedValue(rows);
    /** The real loader: one read of the conversation, then the summary-bounded walk. */
    const cut = await client.loadHistory('convo-123', 'u3');
    expect(cut.map((message) => message.messageId)).toEqual(['a2', 'u3']);
    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(client.loadedHistoryRows).toBe(rows);

    const { prompt, tokenCountMap, counts, memoryMessages } = await buildPrompt(client, cut, 'u3');

    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(client.loadedHistoryRows).toBeUndefined();
    expect(JSON.stringify(memoryMessages)).not.toContain(ANSWER_LINE);
    const text = prompt.map(contentText).join('\n');
    expect(text).toContain(ANSWER_LINE);
    expect(text.indexOf(ANSWER_LINE)).toBeLessThan(text.indexOf(LATEST_TEXT));
    expect(text.endsWith(LATEST_TEXT)).toBe(true);
    expect(client.options.agent.additional_instructions ?? '').not.toContain(ANSWER_LINE);
    expect(cut[1].text).toBe(LATEST_TEXT);
    expect(cut[1].content).toBeUndefined();
    expect(counts[prompt.length - 1]).toBe(tokenCountMap.u3);
    expect(contentText(memoryMessages[memoryMessages.length - 1])).not.toContain(ANSWER_LINE);
  });

  it.each(['cold', 'warm'])(
    'delivers the block through %s chatCompletion while memory receives the unmodified SDK transcript',
    async (continuation) => {
      const client = makeClient();
      client.processMemory = jest.fn();
      client.runMemory = jest.fn().mockResolvedValue();
      client.user = 'user-123';
      getMessages.mockResolvedValue(compactedBranch());
      const cut = await client.loadHistory('convo-123', 'u3');
      const built = await client.buildMessages(cut, 'u3', {});
      client.eventActorContinuation = continuation;
      mockFormatAgentMessages.mockImplementationOnce(formatAgentMessages);
      const processStream = jest.fn().mockResolvedValue();
      mockCreateRun.mockResolvedValueOnce({
        Graph: null,
        graphRunnable: { getState: jest.fn().mockResolvedValue({ values: { messages: [] } }) },
        processStream,
        getCalibrationRatio: jest.fn(() => 0),
        getInterrupt: jest.fn(() => undefined),
      });

      await client.chatCompletion({ payload: built.prompt });

      expect(mockCreateRun).toHaveBeenCalledTimes(1);
      const input = mockCreateRun.mock.calls[0][0];
      expect(input.messages.map(contentText).join('\n')).toContain(ANSWER_LINE);
      expect(mockRuntimeCounter).toHaveBeenCalledTimes(1);
      expect(input.tokenCounter).toBe(mockRuntimeCounter.mock.results[0].value);
      if (continuation === 'warm') {
        expect(input.indexTokenCountMap).toEqual({});
        expect(
          input.tokenCounter(
            input.messages.find((message) => message.id === 'librechat:retained-answers'),
          ),
        ).toBeGreaterThan(0);
      } else {
        expect(input.indexTokenCountMap[input.messages.length - 1]).toBe(built.tokenCountMap.u3);
      }
      expect(client.runMemory).toHaveBeenCalledTimes(1);
      expect(contentText(client.runMemory.mock.calls[0][0].at(-1))).not.toContain(ANSWER_LINE);
      expect(client.memoryPayload).toBeNull();
      expect(processStream).toHaveBeenCalledTimes(1);
      expect(processStream.mock.calls[0][0].messages.map(contentText).join('\n')).toContain(
        ANSWER_LINE,
      );
    },
  );

  it('passes the retained-aware runtime counter to checkpoint resumes', async () => {
    const client = makeClient();
    const job = await GenerationJobManager.createJob('convo-123', 'user-123', 'convo-123');
    client.jobCreatedAt = job.createdAt;
    const counter = jest.fn(() => 123);
    mockRuntimeCounter.mockReturnValueOnce(counter);
    const resume = jest.fn().mockResolvedValue();
    mockCreateRun.mockResolvedValueOnce({
      Graph: null,
      resume,
      processStream: jest.fn().mockResolvedValue(),
      getCalibrationRatio: jest.fn(() => 0),
      getInterrupt: jest.fn(() => undefined),
    });

    await client.resumeCompletion({
      resumeValue: { answer: 'staging' },
      streamId: 'convo-123',
      checkpointNamespace: 'retained-counter',
    });

    expect(mockRuntimeCounter).toHaveBeenCalledTimes(1);
    expect(mockCreateRun.mock.calls[0][0]).toEqual(
      expect.objectContaining({ messages: [], tokenCounter: counter }),
    );
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('reads nothing when the rows in memory already reach the branch root', async () => {
    const client = makeClient();
    client.shouldSummarize = false;
    const rows = compactedBranch();
    rows[3].content = [{ type: ContentTypes.TEXT, text: 'Deployed.' }];

    const { prompt } = await buildPrompt(client, rows, 'u3');

    expect(getMessages).not.toHaveBeenCalled();
    expect(
      contentText(prompt.find((message) => message.id === 'librechat:retained-answers')),
    ).toContain(ANSWER_LINE);
  });

  it('leaves the turn alone when the operator turned retained answers off', async () => {
    const client = makeClient({ askUserQuestion: { retainedAnswers: { enabled: false } } });

    const { prompt } = await buildPrompt(client, compactedBranch(), 'u3');

    expect(getMessages).not.toHaveBeenCalled();
    expect(contentText(prompt[prompt.length - 1])).toBe(LATEST_TEXT);
    expect(client.memoryPayload).toBeNull();
  });

  it('reads the stored branch for a warm event-actor turn that skipped history', async () => {
    const client = makeClient();
    client.eventActorContinuation = 'warm';
    getMessages.mockResolvedValue(compactedBranch());

    const { prompt } = await buildPrompt(client, [latestUserMessage()], 'u3');

    expect(getMessages).toHaveBeenCalledWith(...ROW_QUERY);
    expect(
      contentText(prompt.find((message) => message.id === 'librechat:retained-answers')),
    ).toContain(ANSWER_LINE);
  });

  it('leaves an array-form user row and its memory copy untouched', async () => {
    const client = makeClient();
    client.shouldSummarize = false;
    client.processMemory = jest.fn();
    const rows = compactedBranch();
    rows[3].content = [{ type: ContentTypes.TEXT, text: 'Deployed.' }];
    const shared = [{ type: ContentTypes.TEXT, text: LATEST_TEXT }];
    rows[4] = { ...rows[4], text: undefined, content: shared };

    const { prompt, memoryMessages } = await buildPrompt(client, rows, 'u3');

    expect(
      contentText(prompt.find((message) => message.id === 'librechat:retained-answers')),
    ).toContain(ANSWER_LINE);
    expect(shared).toEqual([{ type: ContentTypes.TEXT, text: LATEST_TEXT }]);
    expect(rows[4].content).toBe(shared);
    expect(contentText(memoryMessages[memoryMessages.length - 1])).toBe(LATEST_TEXT);
  });

  it('measures the block against a fresh count even when the stored count was calibrated', async () => {
    const client = makeClient();
    client.shouldSummarize = false;
    const rows = compactedBranch();
    rows[3].content = [{ type: ContentTypes.TEXT, text: 'Deployed.' }];
    rows[4].tokenCount = 5000;

    const { prompt, tokenCountMap, counts } = await buildPrompt(client, rows, 'u3');

    expect(tokenCountMap.u3).toBe(5000);
    const blockOnly = mockCountFormattedMessageTokens({
      role: 'user',
      content: [{ type: ContentTypes.TEXT, text: ANSWER_LINE }],
    });
    expect(counts[prompt.length - 1]).toBe(5000);
    expect(
      counts[prompt.findIndex((message) => message.id === 'librechat:retained-answers')],
    ).toBeGreaterThanOrEqual(blockOnly);
  });

  it('builds no memory copy when memory processing is inactive', async () => {
    const client = makeClient();
    client.shouldSummarize = false;
    const rows = compactedBranch();
    rows[3].content = [{ type: ContentTypes.TEXT, text: 'Deployed.' }];

    const { prompt } = await buildPrompt(client, rows, 'u3');

    expect(
      contentText(prompt.find((message) => message.id === 'librechat:retained-answers')),
    ).toContain(ANSWER_LINE);
    expect(client.memoryPayload).toBeNull();
  });

  it('quotes into the turn being continued when the leaf is the unfinished response', async () => {
    const client = makeClient();
    client.shouldSummarize = false;
    const rows = compactedBranch();
    rows[3].content = [{ type: ContentTypes.TEXT, text: 'Deployed.' }];
    rows.push({
      messageId: 'a3',
      parentMessageId: 'u3',
      sender: 'Agent',
      isCreatedByUser: false,
      content: [{ type: ContentTypes.TEXT, text: 'Next I will' }],
      unfinished: true,
    });

    const { prompt } = await buildPrompt(client, rows, 'a3');

    expect(prompt[prompt.length - 1].getType()).toBe('ai');
    expect(
      contentText(prompt.find((message) => message.id === 'librechat:retained-answers')),
    ).toContain(ANSWER_LINE);
    expect(contentText(prompt[prompt.length - 1])).not.toContain(ANSWER_LINE);
  });
});
