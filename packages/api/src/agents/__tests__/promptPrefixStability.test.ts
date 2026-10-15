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
 * Runs with `endpoints.agents.promptCache.stableContext` on, except where a
 * test says otherwise.
 *
 * Covered: OpenAI, an OpenAI-compatible custom endpoint (vLLM), Anthropic with
 * and without prompt caching, OpenRouter with prompt caching, Bedrock with
 * prompt caching, and Google. Cache markers move to the newest messages every
 * turn and are not prompt content, so they are stripped before comparing
 * histories.
 *
 * With Anthropic and OpenRouter prompt caching the SDK moves a non-empty
 * `additional_instructions` into a message before the newest user message,
 * and that position shifts every turn. `createRun` merges the conversation-
 * stable part into `instructions` instead, so the history comparison is strict.
 * Per-turn parts (memory and RAG context, contributed as `turn` parts) stay in
 * `additional_instructions` and is moved on purpose; merging it would change
 * the system prompt every turn and uncache the whole history.
 *
 * The history goes through the same helpers `AgentClient.buildMessages` uses
 * (`createHistoryContextUpdates`), and the per-chat
 * system context through the same builders as agent initialization, so a
 * change to any of them that moves bytes inside a cached prefix fails here.
 */
import { tool } from '@langchain/core/tools';
import { formatAgentMessages, formatMessage, Providers } from '@librechat/agents';
import { replaceSpecialVars } from 'librechat-data-provider';
import { buildWebSearchContext, buildWebSearchDynamicContext } from '~/tools/toolkits/web';
import { createHistoryContextUpdates, AGENT_TEMPORAL_INSTRUCTIONS_KEY } from '../contextUpdates';
import { ContextPartKeys, contributeContext } from '../systemParts';
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

const appConfigFor = (stableContext: boolean, includeTimestamps = false) => ({
  endpoints: {
    agents: { promptCache: { stableContext }, promptMessageTimestamps: includeTimestamps },
  },
});

function buildHistory(
  conversation: Conversation,
  turn: number,
  includeTimestamps: boolean,
  stableContext: boolean,
) {
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
  const historyContext = createHistoryContextUpdates({
    req: {
      conversationCreatedAt: conversation.startedAt,
      turnStartedAt: conversation.turnStarts[turn - 1],
      body: { timezone: TIMEZONE },
      config: appConfigFor(stableContext, includeTimestamps),
    },
    messages: ordered,
    agents: [{ dynamicToolContextMap: { web_search: 'stated' } }],
  });
  const formatted = ordered.map((message, index) => {
    const formattedMessage = formatMessage({ message: message as never });
    historyContext.apply(formattedMessage as never, index);
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
const STATIC_ADDITIONAL = 'Answer in the language of the user.';
const QUEUED_CONTEXT = 'report.csv';

/** Code-env state of a turn whose upload is queued; `createRun` derives the queued file context from it. */
const queuedFileState = (queued: boolean) => ({
  fileConsumers: { executeCode: true, fileSearch: false },
  provisionState: {
    codeEnvFiles: queued
      ? [
          {
            file_id: 'report',
            filename: QUEUED_CONTEXT,
            filepath: '/uploads/report.csv',
            type: 'text/csv',
            user: 'user-1',
            object: 'file',
            bytes: 10,
            embedded: false,
            usage: 0,
          },
        ]
      : [],
    vectorDBFiles: [],
    aliveFileIds: new Set(),
    agentScopedFileIds: new Set(),
  },
});
const memoryFor = (turn: number) =>
  `Memory after turn ${turn}: prefers metric units, note ${turn * 104729}.`;
const ragFor = (turn: number) => `Retrieved context for question ${turn}: passage ${turn * 7919}.`;

interface AgentVariant {
  /** Adds query-dependent RAG context to `additional_instructions`. */
  rag?: boolean;
  /** Adds memory context, which the memory agent rewrites between turns. */
  memory?: boolean;
  /** Turn after which an upload leaves one-turn queued file context (gone on the next turn). */
  queuedAtTurn?: number;
  /** Contributes memory and RAG context as per-turn parts, as `AgentClient` does. */
  declareVolatile?: boolean;
  /** Dates the runtime context by the turn start instead of the conversation start. */
  perTurnClock?: boolean;
  /** `promptCache.stableContext`; on unless a test says otherwise. */
  stableContext?: boolean;
}

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
  variant: AgentVariant = {},
): Promise<Captured> {
  let captured: Captured | undefined;
  const stableContext = variant.stableContext ?? true;
  const now =
    variant.perTurnClock || !stableContext
      ? conversation.turnStarts[turn - 1]
      : conversation.startedAt;
  const rag = variant.rag ? ragFor(turn) : undefined;
  const memory = variant.memory ? memoryFor(turn) : undefined;
  const volatile = [rag, memory].filter(Boolean).join('\n\n');
  const tail: { additional_instructions?: string } = {};
  if (!variant.declareVolatile) {
    tail.additional_instructions = [STATIC_ADDITIONAL, volatile].filter(Boolean).join('\n\n');
  } else {
    contributeContext(tail, ContextPartKeys.artifacts, STATIC_ADDITIONAL);
    contributeContext(tail, ContextPartKeys.rag, rag);
    contributeContext(tail, ContextPartKeys.memory, memory);
  }
  const agent = {
    id: 'agent_stable',
    name: 'Stable Agent',
    provider: providerCase.provider,
    endpoint: providerCase.endpoint ?? providerCase.provider,
    instructions: 'You are a careful support assistant.',
    ...tail,
    ...(variant.queuedAtTurn ? queuedFileState(variant.queuedAtTurn === turn) : {}),
    toolContextMap: { web_search: buildWebSearchContext(stableContext) },
    dynamicToolContextMap: {
      web_search: buildWebSearchDynamicContext({
        turnStartedAt: now,
        conversationStartedAt: now,
        timezone: TIMEZONE,
        stableContext,
      }),
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
    const messages = buildHistory(conversation, turn, includeTimestamps, stableContext);
    const runId = `stability-${providerCase.name}-${turn}-${Math.random()}`;
    const run = await createRun({
      appConfig: appConfigFor(stableContext) as never,
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
    name: 'custom endpoint on the Anthropic protocol with promptCache',
    provider: Providers.ANTHROPIC,
    endpoint: 'gateway',
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
        for (const turn of turns) {
          expect(JSON.stringify(turn.system)).toContain(STATIC_ADDITIONAL);
          expect(JSON.stringify(turn.messages)).not.toContain(RUNTIME_CONTEXT_MARKER);
        }
        expect(JSON.stringify(turns[0])).toContain(
          `${RUNTIME_CONTEXT_MARKER} 2026-03-09 23:00 +03:00 (Mon)`,
        );
      });

      it('starts each turn with the previous turn history, newest user message included', () => {
        for (let i = 1; i < turns.length; i++) {
          const previous = turns[i - 1].messages;
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

const MOVES_TAIL = PROVIDERS.filter(
  ({ name }) =>
    name.includes('anthropic with') ||
    name.includes('openrouter with') ||
    name.includes('Anthropic protocol'),
);

async function playConversation(providerCase: ProviderCase, variant: AgentVariant) {
  const turns: Captured[] = [];
  for (let turn = 1; turn <= CONVERSATION_A.turnStarts.length; turn++) {
    turns.push(await captureTurn(providerCase, CONVERSATION_A, turn, false, variant));
  }
  return turns;
}

/** Texts that change from turn to turn without a user action. */
const perTurn = (index: number) => [memoryFor(index + 1), ragFor(index + 1)];

const roleOf = (message: unknown) => (message as { role?: string }).role;

describe('per-turn context in additional_instructions', () => {
  describe.each(PROVIDERS.map((providerCase) => [providerCase.name, providerCase] as const))(
    '%s',
    (_name, providerCase) => {
      const movesTail = MOVES_TAIL.includes(providerCase);
      let turns: Captured[];

      beforeAll(async () => {
        turns = await playConversation(providerCase, {
          rag: true,
          memory: true,
          declareVolatile: true,
        });
      });

      it('sends every turn its own memory and RAG context and keeps tools identical', () => {
        turns.forEach((turn, index) => {
          expect(JSON.stringify(turn.tools)).toBe(JSON.stringify(turns[0].tools));
          for (const text of perTurn(index)) {
            expect(JSON.stringify([turn.system, turn.messages])).toContain(text);
          }
        });
      });

      if (!movesTail) {
        it('keeps the memory and RAG context in the system prompt', () => {
          turns.forEach((turn, index) => {
            for (const text of perTurn(index)) {
              expect(JSON.stringify(turn.system)).toContain(text);
              expect(JSON.stringify(turn.messages)).not.toContain(text);
            }
          });
        });
        return;
      }

      const carrierIndexes = (turn: Captured, index: number) =>
        turn.messages.flatMap((message, position) =>
          perTurn(index).every((text) => JSON.stringify(message).includes(text)) ? [position] : [],
        );

      it('keeps the system prompt byte-identical, without the memory and RAG context', () => {
        turns.forEach((turn, index) => {
          expect(JSON.stringify(turn.system)).toBe(JSON.stringify(turns[0].system));
          expect(JSON.stringify(turn.system)).toContain(RUNTIME_CONTEXT_MARKER);
          for (const text of perTurn(index)) {
            expect(JSON.stringify(turn.system)).not.toContain(text);
          }
        });
      });

      it('moves only the memory and RAG context, in one message next to the newest user message', () => {
        turns.forEach((turn, index) => {
          /** The SDK places the tail after the only message of a one-message OpenRouter request. */
          const alone = index === 0 && providerCase.provider === Providers.OPENROUTER;
          const expected = alone ? turn.messages.length - 1 : turn.messages.length - 2;
          expect(carrierIndexes(turn, index)).toEqual([expected]);
          expect(JSON.stringify(turn.messages)).not.toContain(STATIC_ADDITIONAL);
          expect(roleOf(turn.messages[turn.messages.length - 1])).toBe('user');
        });
      });

      it('reuses everything before the moved tail on the next turn', () => {
        for (let i = 1; i < turns.length; i++) {
          const previous = turns[i - 1].messages;
          const reusable = previous.slice(0, carrierIndexes(turns[i - 1], i - 1)[0]);
          if (i >= 2) {
            expect(reusable.length).toBeGreaterThan(0);
          }
          expect(serialize(turns[i].messages.slice(0, reusable.length))).toBe(serialize(reusable));
          for (const text of perTurn(i - 1)) {
            expect(JSON.stringify(turns[i].messages)).not.toContain(text);
          }
        }
      });
    },
  );

  describe.each(MOVES_TAIL.map((providerCase) => [providerCase.name, providerCase] as const))(
    '%s: regression guard',
    (_name, providerCase) => {
      it('a per-turn part merged into the stable instructions changes the system prompt every turn', async () => {
        /** Without per-turn parts, memory and RAG context cannot be told apart and are merged. */
        const turns = await playConversation(providerCase, { rag: true, memory: true });
        expect(JSON.stringify(turns[1].system)).not.toBe(JSON.stringify(turns[0].system));
        expect(JSON.stringify(turns[2].system)).not.toBe(JSON.stringify(turns[1].system));
      });

      it('a runtime context dated by the turn start changes the system prompt every turn', async () => {
        const turns = await playConversation(providerCase, { perTurnClock: true });
        expect(JSON.stringify(turns[1].system)).not.toBe(JSON.stringify(turns[0].system));
        expect(JSON.stringify(turns[2].system)).not.toBe(JSON.stringify(turns[1].system));
      });
    },
  );

  describe.each(MOVES_TAIL.map((providerCase) => [providerCase.name, providerCase] as const))(
    '%s: one-turn queued file context',
    (_name, providerCase) => {
      it('keeps system byte-identical when queued files appear on one turn and are gone on the next', async () => {
        const turns = await playConversation(providerCase, { queuedAtTurn: 2 });
        expect(JSON.stringify(turns[1].system)).toBe(JSON.stringify(turns[0].system));
        expect(JSON.stringify(turns[2].system)).toBe(JSON.stringify(turns[0].system));
        expect(JSON.stringify(turns[1].system)).not.toContain(QUEUED_CONTEXT);
        expect(JSON.stringify(turns[1].messages)).toContain(QUEUED_CONTEXT);
        expect(JSON.stringify(turns[0].messages)).not.toContain(QUEUED_CONTEXT);
        expect(JSON.stringify(turns[2].messages)).not.toContain(QUEUED_CONTEXT);
      });
    },
  );
});

describe('stableContext off', () => {
  describe.each(PROVIDERS.map((providerCase) => [providerCase.name, providerCase] as const))(
    '%s',
    (_name, providerCase) => {
      it('dates the runtime context by each turn and announces nothing in the history', async () => {
        const turns = await playConversation(providerCase, { stableContext: false });
        for (const turn of turns) {
          const request = JSON.stringify([turn.system, turn.messages]);
          expect(request).toContain('Conversation Date & Time:');
          expect(request).not.toContain(RUNTIME_CONTEXT_MARKER);
          expect(JSON.stringify(turn.messages)).not.toContain('<context_update>');
        }
        const stamps = turns.map(
          (turn) =>
            /Conversation Date & Time: ([^"\\]+)/.exec(
              JSON.stringify([turn.system, turn.messages]),
            )?.[1],
        );
        expect(new Set(stamps).size).toBe(turns.length);
      });
    },
  );
});
