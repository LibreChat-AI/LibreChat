/**
 * Provider payload stability across the turns of a conversation.
 *
 * Builds each turn through the real `createRun` and the provider chat model
 * classes, captures the serialized request right before it would leave the
 * process, and aborts it there: fetch-based clients (OpenAI and OpenAI-
 * compatible endpoints, Anthropic, Google) through a mocked global `fetch`,
 * Bedrock through an injected runtime client whose `send` records the command
 * input. No request reaches the network.
 *
 * Covered: OpenAI, an OpenAI-compatible custom endpoint (vLLM), Anthropic with
 * and without prompt caching, OpenRouter with prompt caching, Bedrock with
 * prompt caching, and Google. With Anthropic-format prompt caching the SDK
 * carries the dynamic system tail as a user message ahead of the newest user
 * message, so that carrier is excluded from the history comparison; cache
 * markers move to the newest messages every turn and are not prompt content,
 * so they are stripped before comparing histories.
 *
 * The history goes through the same helpers `AgentClient.buildMessages` uses
 * (`buildUserMessageContextUpdates`, `prependContextText`), and the per-chat
 * system context through the same builders as agent initialization, so a
 * change to any of them that moves bytes inside a cached prefix fails here.
 */
import { tool } from '@langchain/core/tools';
import { formatAgentMessages, formatMessage, Providers } from '@librechat/agents';
import { replaceSpecialVars } from 'librechat-data-provider';
import { buildWebSearchContext, buildWebSearchDynamicContext } from '~/tools/toolkits/web';
import { buildUserMessageContextUpdates, AGENT_TEMPORAL_INSTRUCTIONS_KEY } from '../contextUpdates';
import { prependContextText } from '../client';
import { createRun } from '../run';

jest.setTimeout(30000);

const TIMEZONE = 'Africa/Nairobi';
const CAPTURED = 'request captured before network';

interface Conversation {
  startedAt: string;
  /** One entry per turn: when the turn started. */
  turnStarts: string[];
}

/** A: turns 1 and 2 on Monday evening, turn 3 after local midnight (Nairobi, UTC+3). */
const CONVERSATION_A: Conversation = {
  startedAt: '2026-03-09T20:00:00.000Z',
  turnStarts: ['2026-03-09T20:00:00.000Z', '2026-03-09T20:30:00.000Z', '2026-03-09T21:30:00.000Z'],
};
const CONVERSATION_B: Conversation = {
  startedAt: '2026-04-02T07:15:00.000Z',
  turnStarts: ['2026-04-02T07:15:00.000Z'],
};

const lookupTool = tool(async () => 'ok', {
  name: 'lookup_order',
  description: 'Looks up an order by its identifier.',
  schema: {
    type: 'object',
    properties: { orderId: { type: 'string', description: 'Order identifier' } },
    required: ['orderId'],
  },
});

function buildHistory(conversation: Conversation, turn: number, includeTimestamps: boolean) {
  const ordered: Array<Record<string, unknown>> = [];
  for (let i = 0; i < turn; i++) {
    const isCurrent = i === turn - 1;
    ordered.push({
      messageId: `u${i + 1}`,
      isCreatedByUser: true,
      sender: 'User',
      text: `Question ${i + 1}`,
      /** Stored rows carry the turn start (see `createdAtOnInsert`); the current one is unsaved. */
      ...(isCurrent ? {} : { createdAt: conversation.turnStarts[i] }),
    });
    if (!isCurrent) {
      ordered.push({
        messageId: `a${i + 1}`,
        isCreatedByUser: false,
        sender: 'Assistant',
        text: `Answer ${i + 1}`,
        createdAt: conversation.turnStarts[i],
      });
    }
  }
  const updates = buildUserMessageContextUpdates({
    messages: ordered,
    conversationStartedAt: conversation.startedAt,
    currentTurnStartedAt: conversation.turnStarts[turn - 1],
    timezone: TIMEZONE,
    trackDateChanges: true,
    includeTimestamps,
  });
  const formatted = ordered.map((message, index) => {
    const formattedMessage = formatMessage({ message: message as never });
    prependContextText(formattedMessage as never, updates.get(index), '\n\n');
    return formattedMessage;
  });
  return formatAgentMessages(formatted as never, {}).messages;
}

type ProviderCase = {
  name: string;
  provider: string;
  endpoint?: string;
  modelParameters: Record<string, unknown>;
};

type Captured = { system: unknown; tools: unknown; messages: unknown[] };

const RUNTIME_CONTEXT_MARKER = 'Conversation started:';

function isCachePointBlock(value: unknown): boolean {
  return (
    value != null &&
    typeof value === 'object' &&
    Object.keys(value).length === 1 &&
    'cachePoint' in value
  );
}

function stripCacheMarkers(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => !isCachePointBlock(item)).map(stripCacheMarkers);
  }
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'cache_control')
        .map(([key, nested]) => [key, stripCacheMarkers(nested)]),
    );
  }
  return value;
}

const serialize = (value: unknown) => JSON.stringify(stripCacheMarkers(value));

async function captureTurn(
  providerCase: ProviderCase,
  conversation: Conversation,
  turn: number,
  includeTimestamps = false,
): Promise<Captured> {
  let captured: Captured | undefined;
  const now = conversation.startedAt;
  const agent = {
    id: 'agent_stable',
    name: 'Stable Agent',
    provider: providerCase.provider,
    endpoint: providerCase.endpoint ?? providerCase.provider,
    instructions: 'You are a careful support assistant.',
    additional_instructions: 'Answer in the language of the user.',
    toolContextMap: { web_search: buildWebSearchContext() },
    dynamicToolContextMap: {
      web_search: buildWebSearchDynamicContext(now, TIMEZONE),
      [AGENT_TEMPORAL_INSTRUCTIONS_KEY]: replaceSpecialVars({
        text: 'Today is {{current_date}}.',
        now,
        timezone: TIMEZONE,
      }),
    },
    tools: [lookupTool],
    maxContextTokens: 100000,
    model_parameters: { ...providerCase.modelParameters },
  };

  const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const raw = request ? await request.clone().text() : String(init?.body ?? '{}');
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (providerCase.provider === Providers.GOOGLE) {
      captured = {
        system: body.systemInstruction,
        tools: body.tools,
        messages: body.contents as unknown[],
      };
    } else if (providerCase.provider === Providers.ANTHROPIC) {
      captured = { system: body.system, tools: body.tools, messages: body.messages as unknown[] };
    } else {
      const messages = body.messages as Array<{ role: string }>;
      captured = {
        system: messages.filter((message) => message.role === 'system'),
        tools: body.tools,
        messages: messages.filter((message) => message.role !== 'system'),
      };
    }
    throw new Error(CAPTURED);
  });
  if (providerCase.provider === Providers.BEDROCK) {
    agent.model_parameters.client = {
      send: async (command: { input: Record<string, unknown> }) => {
        captured = {
          system: command.input.system,
          tools: command.input.toolConfig,
          messages: command.input.messages as unknown[],
        };
        throw new Error(CAPTURED);
      },
      config: {},
      destroy: () => undefined,
      middlewareStack: { add: () => undefined, use: () => undefined },
    };
  }

  try {
    const messages = buildHistory(conversation, turn, includeTimestamps);
    const runId = `stability-${providerCase.name}-${turn}-${Math.random()}`;
    const run = await createRun({
      agents: [agent] as never,
      messages,
      runId,
      signal: new AbortController().signal,
      streaming: false,
      streamUsage: false,
    });
    await run
      .processStream({ messages }, { configurable: { thread_id: runId }, version: 'v2' })
      .catch(() => undefined);
  } finally {
    fetchMock.mockRestore();
  }
  if (captured == null) {
    throw new Error(`No request captured for ${providerCase.name}`);
  }
  return captured;
}

const PROVIDERS: ProviderCase[] = [
  {
    name: 'openAI',
    provider: Providers.OPENAI,
    modelParameters: { model: 'gpt-4.1', apiKey: 'test-key', maxRetries: 0 },
  },
  {
    name: 'custom OpenAI-compatible (vLLM)',
    provider: Providers.OPENAI,
    endpoint: 'vLLM',
    modelParameters: {
      model: 'local-model',
      apiKey: 'test-key',
      maxRetries: 0,
      configuration: { baseURL: 'https://vllm.invalid/v1' },
    },
  },
  {
    name: 'anthropic',
    provider: Providers.ANTHROPIC,
    modelParameters: { model: 'claude-sonnet-4-5', apiKey: 'test-key', maxRetries: 0 },
  },
  {
    name: 'anthropic with promptCache',
    provider: Providers.ANTHROPIC,
    modelParameters: {
      model: 'claude-sonnet-4-5',
      apiKey: 'test-key',
      maxRetries: 0,
      promptCache: true,
    },
  },
  {
    name: 'openrouter with promptCache',
    provider: Providers.OPENROUTER,
    modelParameters: {
      model: 'anthropic/claude-sonnet-4.5',
      apiKey: 'test-key',
      maxRetries: 0,
      promptCache: true,
    },
  },
  {
    name: 'bedrock with promptCache',
    provider: Providers.BEDROCK,
    modelParameters: {
      model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxRetries: 0,
      promptCache: true,
    },
  },
  {
    name: 'google',
    provider: Providers.GOOGLE,
    modelParameters: { model: 'gemini-2.5-flash', apiKey: 'test-key', maxRetries: 0 },
  },
];

describe('prompt prefix stability', () => {
  describe.each(PROVIDERS.map((providerCase) => [providerCase.name, providerCase] as const))(
    '%s',
    (_name, providerCase) => {
      let turns: Captured[];
      let otherConversation: Captured;

      beforeAll(async () => {
        turns = [];
        for (let turn = 1; turn <= CONVERSATION_A.turnStarts.length; turn++) {
          turns.push(await captureTurn(providerCase, CONVERSATION_A, turn));
        }
        otherConversation = await captureTurn(providerCase, CONVERSATION_B, 1);
      });

      it('keeps tools and system identical across the turns of a conversation', () => {
        for (const turn of turns.slice(1)) {
          expect(JSON.stringify(turn.tools)).toBe(JSON.stringify(turns[0].tools));
          expect(JSON.stringify(turn.system)).toBe(JSON.stringify(turns[0].system));
        }
        expect(JSON.stringify(turns[0].tools)).toContain('lookup_order');
        expect(JSON.stringify(turns[0])).toContain(
          `${RUNTIME_CONTEXT_MARKER} 2026-03-09 23:00 +03:00 (Mon)`,
        );
      });

      it('starts each turn with the previous turn history, newest user message included', () => {
        for (let i = 1; i < turns.length; i++) {
          const previous = turns[i - 1].messages.filter(
            (message) => !JSON.stringify(message).includes(RUNTIME_CONTEXT_MARKER),
          );
          const next = turns[i].messages.slice(0, previous.length);
          expect(serialize(next)).toBe(serialize(previous));
        }
      });

      it('announces the date change only in the first message after local midnight', () => {
        const lastUserText = (captured: Captured) =>
          JSON.stringify(captured.messages[captured.messages.length - 1]);
        expect(lastUserText(turns[0])).not.toContain('<context_update>');
        expect(lastUserText(turns[1])).not.toContain('<context_update>');
        expect(lastUserText(turns[2])).toContain('Current date changed to: 2026-03-10 (Tue)');
      });

      it('shares tools and the static system prefix with another conversation', () => {
        expect(JSON.stringify(otherConversation.tools)).toBe(JSON.stringify(turns[0].tools));
        const system = JSON.stringify(turns[0].system);
        const otherSystem = JSON.stringify(otherConversation.system);
        const runtimeContextIndex = system.indexOf(RUNTIME_CONTEXT_MARKER);
        if (runtimeContextIndex < 0) {
          /** The per-chat tail travels in the history; the whole system block is shared. */
          expect(otherSystem).toBe(system);
          return;
        }
        expect(otherSystem).not.toBe(system);
        expect(otherSystem.slice(0, runtimeContextIndex)).toBe(
          system.slice(0, runtimeContextIndex),
        );
      });
    },
  );

  it('renders send-time stamps identically on the turn and on later turns', async () => {
    const [openAI] = PROVIDERS;
    const turns: Captured[] = [];
    for (let turn = 1; turn <= CONVERSATION_A.turnStarts.length; turn++) {
      turns.push(await captureTurn(openAI, CONVERSATION_A, turn, true));
    }
    for (let i = 1; i < turns.length; i++) {
      const previous = turns[i - 1].messages;
      expect(JSON.stringify(turns[i].messages.slice(0, previous.length))).toBe(
        JSON.stringify(previous),
      );
    }
    expect(JSON.stringify(turns[2].messages)).toContain(
      'Message sent: 2026-03-09 23:30:00 +03:00 (Mon)',
    );
    expect(JSON.stringify(turns[2].messages[4])).toContain(
      'Current date changed to: 2026-03-10 (Tue)\\nMessage sent: 2026-03-10 00:30:00 +03:00 (Tue)',
    );
  });
});
