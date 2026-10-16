const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { ChatGenerationChunk } = require('@langchain/core/outputs');
const { AIMessageChunk, HumanMessage } = require('@langchain/core/messages');
const { createModels, createMethods, CLIENT_MESSAGE_SELECT } = require('@librechat/data-schemas');
const { attachProviderItems } = require('@librechat/api');
const {
  Run,
  Providers,
  GraphEvents,
  FakeChatModel,
  createContentAggregator,
  formatAgentMessages,
} = require('@librechat/agents');

const USER_ID = new mongoose.Types.ObjectId().toString();
const TOKEN_COUNT = 777;

const fixtures = {
  anthropic: {
    provider: Providers.ANTHROPIC,
    model: 'claude-sonnet-5',
    secret: 'anthropic-signed-thinking',
    chunks: [
      new AIMessageChunk({
        content: [
          {
            type: 'thinking',
            thinking: 'Anthropic summary.',
            signature: 'anthropic-signed-thinking',
          },
        ],
      }),
      new AIMessageChunk({ content: 'Anthropic answer.' }),
    ],
  },
  bedrock: {
    provider: Providers.BEDROCK,
    model: 'global.anthropic.claude-sonnet-5-v1:0',
    secret: 'bedrock-signed-thinking',
    chunks: [
      new AIMessageChunk({
        content: [
          {
            type: 'reasoning_content',
            reasoningText: {
              text: 'Bedrock summary.',
              signature: 'bedrock-signed-thinking',
            },
          },
        ],
      }),
      new AIMessageChunk({ content: 'Bedrock answer.' }),
    ],
  },
};

const withinProviderSwitches = [
  {
    name: 'anthropic',
    kind: 'model',
    target: { provider: Providers.ANTHROPIC, model: 'claude-opus-5' },
  },
  {
    name: 'bedrock',
    kind: 'model',
    target: {
      provider: Providers.BEDROCK,
      model: 'global.anthropic.claude-opus-5-v1:0',
    },
  },
];

const crossProviderSwitches = Object.entries(fixtures).flatMap(([name, fixture]) =>
  Object.entries(fixtures)
    .filter(([, target]) => target.provider !== fixture.provider)
    .map(([targetName, target]) => ({
      name,
      kind: `provider (${name} to ${targetName})`,
      target,
    })),
);

class ProviderResponseModel extends FakeChatModel {
  constructor(chunks) {
    super({ responses: [''] });
    this.chunks = chunks;
  }

  async *_streamResponseChunks(_messages, _options, runManager) {
    for (const chunk of this.chunks) {
      const text = typeof chunk.content === 'string' ? chunk.content : '';
      yield new ChatGenerationChunk({ text, message: chunk });
      void runManager?.handleLLMNewToken(text);
    }
  }
}

function createAggregationHandlers(aggregateContent) {
  return Object.fromEntries(
    [GraphEvents.ON_RUN_STEP, GraphEvents.ON_MESSAGE_DELTA, GraphEvents.ON_REASONING_DELTA].map(
      (event) => [
        event,
        {
          handle: (receivedEvent, data) => aggregateContent({ event: receivedEvent, data }),
        },
      ],
    ),
  );
}

function containsSecret(value, secret) {
  return JSON.stringify(value).includes(secret);
}

describe('reasoning replay across the MongoDB boundary', () => {
  jest.setTimeout(60000);

  let mongoServer;
  let methods;
  let modelNames;
  let mixedConversationId;
  const persisted = {};

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    const models = createModels(mongoose);
    modelNames = Object.keys(models);
    Object.assign(mongoose.models, models);
    methods = createMethods(mongoose);

    for (const [name, fixture] of Object.entries(fixtures)) {
      persisted[name] = await capturePersistAndReload(name, fixture);
    }
    mixedConversationId = await persistMixedProviderConversation();
  });

  afterAll(async () => {
    for (const collection of Object.values(mongoose.connection.collections)) {
      await collection.deleteMany({});
    }
    for (const modelName of modelNames ?? []) {
      delete mongoose.models[modelName];
    }
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoServer?.stop();
  });

  async function capturePersistAndReload(name, fixture) {
    const { contentParts, aggregateContent } = createContentAggregator();
    const run = await Run.create({
      runId: `reasoning-replay-${name}`,
      graphConfig: {
        type: 'standard',
        agents: [
          {
            agentId: `agent-${name}`,
            provider: fixture.provider,
            clientOptions: { model: fixture.model, streamUsage: false },
            instructions: 'Answer.',
            providerReasoningReplay: true,
          },
        ],
      },
      returnContent: true,
      skipCleanup: true,
      customHandlers: createAggregationHandlers(aggregateContent),
    });

    run.Graph.overrideModel = new ProviderResponseModel(fixture.chunks);
    await run.processStream(
      { messages: [new HumanMessage(`mock ${name} request`)] },
      {
        configurable: { thread_id: `reasoning-replay-${name}` },
        streamMode: 'values',
        version: 'v2',
      },
    );

    expect(containsSecret(contentParts, fixture.secret)).toBe(true);

    const conversationId = uuidv4();
    const messageId = uuidv4();
    await methods.saveMessage(
      { userId: USER_ID },
      {
        messageId,
        conversationId,
        parentMessageId: uuidv4(),
        isCreatedByUser: false,
        sender: 'Agent',
        endpoint: 'agents',
        model: 'mock-agent',
        text: '',
        content: contentParts,
        tokenCount: TOKEN_COUNT,
      },
    );

    /** The signed blocks sit in a field of their own, out of the content and ordinary reads. */
    const messages = await methods.getMessages({ user: USER_ID, conversationId });
    expect(messages).toHaveLength(1);
    expect(containsSecret(messages[0], fixture.secret)).toBe(false);
    const [row] = await methods.getMessages(
      { user: USER_ID, conversationId },
      CLIENT_MESSAGE_SELECT,
    );
    expect(containsSecret(row, fixture.secret)).toBe(false);
    const [history] = await methods.getMessages(
      { user: USER_ID, conversationId },
      '+providerItems',
    );
    expect(containsSecret(history.providerItems, fixture.secret)).toBe(true);
    return { conversationId, messageId, content: messages[0].content };
  }

  /** The history as `AgentClient` builds it: rows read with their provider items, put back on their parts. */
  function toPayload(rows) {
    return rows.map((message) => {
      const { content, messageId, text, isCreatedByUser } = attachProviderItems(message);
      return { role: isCreatedByUser ? 'user' : 'assistant', messageId, text, content };
    });
  }

  async function reloadPayload(name) {
    const { conversationId } = persisted[name];
    return toPayload(
      await methods.getMessages({ user: USER_ID, conversationId }, '+providerItems'),
    );
  }

  async function persistMixedProviderConversation() {
    const conversationId = uuidv4();
    let parentMessageId = uuidv4();
    for (const [index, [name, fixture]] of Object.entries(fixtures).entries()) {
      const messageId = uuidv4();
      const [source] = await methods.getMessages(
        { user: USER_ID, conversationId: persisted[name].conversationId },
        '+providerItems',
      );
      await methods.saveMessage(
        { userId: USER_ID },
        {
          messageId,
          conversationId,
          parentMessageId,
          isCreatedByUser: false,
          sender: 'Agent',
          endpoint: fixture.provider,
          model: fixture.model,
          text: '',
          /** Rebuilt as the run produced it: the replay on its think part. */
          content: attachProviderItems(source).content,
          tokenCount: TOKEN_COUNT,
          createdAt: new Date(Date.now() + index * 1000),
        },
      );
      parentMessageId = messageId;
    }
    return conversationId;
  }

  function format(payload, target) {
    return formatAgentMessages(payload, { 0: TOKEN_COUNT }, undefined, undefined, {
      replayProviderReasoning: { provider: target.provider, model: target.model },
    });
  }

  test.each(Object.entries(fixtures))(
    'replays %s reasoning after persistence for the same endpoint and model',
    async (name, fixture) => {
      const payload = await reloadPayload(name);
      const result = format(payload, fixture);

      expect(containsSecret(result.messages, fixture.secret)).toBe(true);
      /** The blocks are not part of the stored weight, so it is recounted. */
      expect(result.indexTokenCountMap).toEqual({});
    },
  );

  test.each(Object.entries(fixtures))(
    'sends %s reasoning only when the replay option is set',
    async (name, fixture) => {
      const payload = await reloadPayload(name);
      const result = formatAgentMessages(payload, { 0: TOKEN_COUNT });

      expect(containsSecret(result.messages, fixture.secret)).toBe(false);
      expect(result.indexTokenCountMap).toEqual({ 0: TOKEN_COUNT });
    },
  );

  test.each([...withinProviderSwitches, ...crossProviderSwitches])(
    'strips $name replay on a $kind switch and restores it when switching back',
    async ({ name, target }) => {
      const fixture = fixtures[name];
      const switched = format(await reloadPayload(name), target);

      expect(containsSecret(switched.messages, fixture.secret)).toBe(false);

      const restored = format(await reloadPayload(name), fixture);
      expect(containsSecret(restored.messages, fixture.secret)).toBe(true);

      const stored = await methods.getMessages(
        { user: USER_ID, conversationId: persisted[name].conversationId },
        '+providerItems',
      );
      expect(containsSecret(stored[0].providerItems, fixture.secret)).toBe(true);
    },
  );

  test('does not replay reasoning whose text was edited after it was saved', async () => {
    const name = 'anthropic';
    const fixture = fixtures[name];
    const { conversationId, messageId } = persisted[name];
    const [row] = await methods.getMessages({ user: USER_ID, conversationId }, '+providerItems');
    const edited = row.content.map((part) =>
      part.type === 'think' ? { ...part, think: `${part.think} (edited)` } : part,
    );
    await methods.updateMessage(USER_ID, { messageId, content: edited });

    const rows = await methods.getMessages({ user: USER_ID, conversationId }, '+providerItems');
    expect(JSON.stringify(rows[0].content)).toContain('(edited)');
    /** The stored blocks are still there; they just no longer match the edited text. */
    expect(containsSecret(rows[0].providerItems, fixture.secret)).toBe(true);
    const result = format(toPayload(rows), fixture);

    expect(containsSecret(result.messages, fixture.secret)).toBe(false);

    await methods.updateMessage(USER_ID, { messageId, content: row.content });
  });

  test('selects only compatible replay from a mixed-provider conversation reloaded from MongoDB', async () => {
    const mixedMessages = await methods.getMessages(
      { user: USER_ID, conversationId: mixedConversationId },
      '+providerItems',
    );
    expect(mixedMessages).toHaveLength(Object.keys(fixtures).length);
    const payload = toPayload(mixedMessages).map((message) => ({ ...message, role: 'assistant' }));
    const tokenMap = {};
    for (const index of payload.keys()) {
      tokenMap[index] = TOKEN_COUNT;
    }

    for (const [activeName, activeFixture] of Object.entries(fixtures)) {
      const result = formatAgentMessages(payload, tokenMap, undefined, undefined, {
        replayProviderReasoning: {
          provider: activeFixture.provider,
          model: activeFixture.model,
        },
      });
      for (const [name, fixture] of Object.entries(fixtures)) {
        expect(containsSecret(result.messages, fixture.secret)).toBe(name === activeName);
      }
    }
  });
});
