/**
 * Tool groups keep every provider's `tools` parameter and system prompt fixed
 * while MCP servers and actions are switched mid-conversation, and a tool added
 * mid-conversation really runs.
 *
 * Each turn runs the chat path's steps: the real `initializeAgent` over the real
 * `loadToolDefinitions` (MCP catalogs, an OpenAPI action, a deferred tool behind
 * `tool_search`), the request stage of `AgentClient.buildMessages`
 * (`applyContextToAgent` without live MCP instructions, `collectToolGroups`,
 * `planTurnContext`, `applyTurnContext`, update blocks prepended to the prompt
 * copies, `formatAgentMessages` with the run's tool set), and the real
 * `createRun` with LibreChat's tool execution handler, a tool approval policy
 * and a plugin `PreToolUse` hook. Model replies are streamed in each provider's
 * wire format; the content parts the SDK aggregator builds are stored as the
 * reply and restored on the next turn.
 *
 * Scenario: server `alpha` from the first turn; `beta` switched on at turn 2,
 * called through the dispatcher at turn 3, switched off at turn 4 when an
 * action is added; `alpha` unreachable at turn 5, where `tool_search` finds a
 * deferred tool the model then calls; a compaction summary on the reply of
 * turn 6 re-anchors turn 7.
 *
 * Built-in scenario: the code environment from the first turn; web search
 * switched on at turn 2 and called through the dispatcher at turn 3; the code
 * environment switched off at turn 4, where a direct call to it is refused, and
 * on again at turn 5; another model at turn 6 is a declared reset that
 * re-anchors without a compaction.
 */
jest.mock('winston', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  })),
  format: Object.assign(
    jest.fn((fn) => () => ({ transform: fn })),
    {
      combine: jest.fn(),
      colorize: jest.fn(),
      simple: jest.fn(),
      label: jest.fn(),
      timestamp: jest.fn(),
      printf: jest.fn(),
      errors: jest.fn(),
      splat: jest.fn(),
      json: jest.fn(),
    },
  ),
  addColors: jest.fn(),
  transports: { Console: jest.fn(), DailyRotateFile: jest.fn(), File: jest.fn() },
}));

jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  extractLibreChatParams: jest.fn(() => ({ resendFiles: false, modelOptions: {} })),
  getModelMaxTokens: jest.fn(() => 200000),
}));

jest.mock('~/endpoints', () => ({
  getProviderConfig: jest.fn(({ provider }: { provider: string }) => ({
    overrideProvider: provider,
    getOptions: jest.fn(async () => ({ llmConfig: { model: 'test-model', maxTokens: 4096 } })),
  })),
}));

jest.mock('~/files', () => ({
  filterFilesByEndpointConfig: jest.fn(() => []),
  filterFilesByEndpointRuntimeConfig: jest.fn(() => []),
  isLegacyFileUploadUX: jest.fn(() => false),
}));

jest.mock('../resources', () => ({
  primeResources: jest.fn().mockResolvedValue({ attachments: [], tool_resources: undefined }),
}));

import { Types } from 'mongoose';
import { tool } from '@langchain/core/tools';
import { ContentTypes, EModelEndpoint } from 'librechat-data-provider';
import {
  GraphEvents,
  formatMessage,
  createToolSearch,
  formatAgentMessages,
  TOOL_DISPATCHER_NAME,
  createContentAggregator,
} from '@librechat/agents';
import type { HookRegistry, JsonSchemaType, LCTool } from '@librechat/agents';
import type { Agent } from 'librechat-data-provider';
import type { ContextEntry, TurnContextMessage, TurnPlan } from '../turnContext';
import type { Captured, ProviderCase } from './helpers/providerCapture';
import type { InitializeAgentDbMethods } from '../initialize';
import type { Reply } from './helpers/providerReplies';
import type { MCPManager } from '~/mcp/MCPManager';
import {
  applyTurnContext,
  planTurnContext,
  createSendSnapshot,
  collectToolGroups,
} from '../turnContext';
import { PROVIDERS, OPENAI_RESPONSES, captureRun, serialize } from './helpers/providerCapture';
import { providerReply } from './helpers/providerReplies';
import { loadToolDefinitions } from '~/tools/definitions';
import { createToolExecuteHandler } from '../handlers';
import { setPluginHookSource } from '../hooks/source';
import { applyContextToAgent } from '../context';
import { prependContextText } from '../client';
import { initializeAgent } from '../initialize';
import { buildToolSet } from '../tools';

jest.setTimeout(180000);

const USER_ID = new Types.ObjectId().toString();
const START = Date.parse('2026-03-09T09:00:00.000Z');
const SEARCH = 'search_mcp_alpha';
const QUERY = 'query_mcp_beta';
const LOOKUP = 'lookup_mcp_gamma';
const ACTION = 'getWeather_action_api---example---com';
const SUMMARY = 'Summary of turns 1 to 6: the user asked about stock.';

const schema = (property: string): JsonSchemaType => ({
  type: 'object',
  properties: { [property]: { type: 'string' } },
  required: [property],
});
const CATALOGS: Record<string, Record<string, unknown>> = {
  alpha: {
    [SEARCH]: {
      function: { name: SEARCH, description: 'Searches alpha.', parameters: schema('text') },
    },
  },
  beta: {
    [QUERY]: {
      function: { name: QUERY, description: 'Queries beta stock.', parameters: schema('q') },
    },
  },
  gamma: {
    [LOOKUP]: {
      function: { name: LOOKUP, description: 'Looks up an order.', parameters: schema('order') },
    },
  },
};
const DRIFTED_ALPHA = {
  [SEARCH]: {
    function: {
      name: SEARCH,
      description: 'Searches alpha, now by query.',
      parameters: schema('query'),
    },
  },
};
const INSTRUCTIONS: Record<string, string> = {
  alpha: 'Alpha answers in French.',
  beta: 'Beta needs a part number.',
};
/** The approval policy allows only the real tools: a call seen as the dispatcher would be held. */
const APPROVAL = { enabled: true, allow: [SEARCH, QUERY, LOOKUP, ACTION, 'tool_search'] };

interface TurnState {
  mcp: string[];
  code?: boolean;
  webSearch?: boolean;
  /** The model the agent is configured with, when not the default. */
  model?: string;
  /** Selected servers whose catalog cannot be loaded. */
  down?: string[];
  action?: boolean;
  /** Model replies to the turn's requests, in order; the last one answers with text. */
  replies?: Reply[];
  compacts?: boolean;
  /** The server renamed the parameter of `alpha`'s tool and reworded its description. */
  drift?: boolean;
}

const answer = (n: number): Reply => ({ text: `Answer ${n}` });
const SCENARIO: TurnState[] = [
  { mcp: ['alpha'], replies: [answer(1)] },
  { mcp: ['alpha', 'beta'], replies: [answer(2)] },
  {
    mcp: ['alpha', 'beta'],
    replies: [
      {
        calls: [
          {
            id: 'toolu_t3',
            name: TOOL_DISPATCHER_NAME,
            args: { name: QUERY, arguments: JSON.stringify({ q: 'bolts' }) },
          },
        ],
      },
      answer(3),
    ],
  },
  { mcp: ['alpha'], action: true, replies: [answer(4)] },
  {
    mcp: [],
    down: ['alpha'],
    action: true,
    replies: [
      { calls: [{ id: 'toolu_t5a', name: 'tool_search', args: { query: 'order' } }] },
      /** Called directly after the search: the SDK turns it into a dispatcher call. */
      { calls: [{ id: 'toolu_t5b', name: LOOKUP, args: { order: '7' } }] },
      answer(5),
    ],
  },
  { mcp: ['alpha'], action: true, replies: [answer(6)], compacts: true },
  { mcp: ['alpha'], action: true, replies: [answer(7)] },
];
const SECOND_SEGMENT = 6;

const WEB_SEARCH_GUIDE = 'Cite every web source you use.';

/** The approval policy allows only the real tools: a call seen as the dispatcher would be held. */
const BUILTIN_APPROVAL = {
  enabled: true,
  allow: [SEARCH, 'web_search', 'bash_tool', 'tool_search'],
};
/**
 * The dispatched call runs while the code environment is off: with it on, the live run marks
 * tool results with output references the next turn does not restore (a separate gap).
 */
const BUILTIN_SCENARIO: TurnState[] = [
  { mcp: ['alpha'], code: true, replies: [answer(1)] },
  { mcp: ['alpha'], code: true, webSearch: true, replies: [answer(2)] },
  {
    mcp: ['alpha'],
    webSearch: true,
    replies: [
      {
        calls: [
          {
            id: 'toolu_b3a',
            name: TOOL_DISPATCHER_NAME,
            args: { name: 'web_search', arguments: JSON.stringify({ query: 'bolts' }) },
          },
        ],
      },
      { calls: [{ id: 'toolu_b3b', name: 'bash_tool', args: { command: 'ls' } }] },
      answer(3),
    ],
  },
  { mcp: ['alpha'], code: true, webSearch: true, replies: [answer(4)] },
  { mcp: ['alpha'], code: true, webSearch: true, model: 'other-model', replies: [answer(5)] },
  { mcp: ['alpha'], code: true, webSearch: true, model: 'other-model', replies: [answer(6)] },
];
const RESET_TURN = 4;

const mcpManager = {
  formatInstructionsForContext: jest.fn(async () => ''),
} as unknown as MCPManager;

const serverInstructions = async (servers: string[]) =>
  Object.fromEntries(servers.filter((s) => INSTRUCTIONS[s]).map((s) => [s, INSTRUCTIONS[s]]));

function createDb(): InitializeAgentDbMethods {
  return {
    getProjectFiles: jest.fn().mockResolvedValue([]),
    getFiles: jest.fn().mockResolvedValue([]),
    getConvoFiles: jest.fn().mockResolvedValue([]),
    updateFilesUsage: jest.fn().mockResolvedValue([]),
    getUserKey: jest.fn().mockResolvedValue('user-1'),
    getUserKeyValues: jest.fn().mockResolvedValue([]),
    getToolFilesByIds: jest.fn().mockResolvedValue([]),
  } as unknown as InitializeAgentDbMethods;
}

/** `initializeAgent` with the real definition loader, then the request stage of `buildMessages`. */
async function prepareAgent(state: TurnState, provider: string) {
  const selected = [...state.mcp, ...(state.down ?? [])];
  const agent = {
    id: 'agent_main',
    name: 'Main',
    provider,
    model: 'test-model',
    model_parameters: { model: 'test-model' },
    instructions: 'You are a careful support assistant.',
    tools: [
      'memory',
      ...(state.code ? ['execute_code'] : []),
      ...(state.webSearch ? ['web_search'] : []),
      ...selected.map((server) => `sys__all__sys_mcp_${server}`),
      LOOKUP,
      ...(state.action ? [ACTION] : []),
    ],
    tool_options: { [LOOKUP]: { defer_loading: true } },
  } as unknown as Agent;
  const loadTools = jest.fn(
    async ({ tools, tool_options }: { tools: string[]; tool_options: never }) => {
      const loaded = await loadToolDefinitions(
        {
          userId: USER_ID,
          agentId: 'agent_main',
          tools,
          toolOptions: tool_options,
          deferredToolsEnabled: true,
          provider: provider as never,
          mcpServerNames: ['alpha', 'beta', 'gamma'],
        },
        {
          getOrFetchMCPServerTools: async (_userId, server) =>
            state.mcp.includes(server) || server === 'gamma'
              ? ((state.drift && server === 'alpha' ? DRIFTED_ALPHA : CATALOGS[server]) as never)
              : null,
          isBuiltInTool: (name) => name === 'web_search',
          getActionToolDefinitions: async (_agentId, names) =>
            names.map((name) => ({
              name,
              description: 'Gets the weather.',
              parameters: schema('city'),
            })),
        },
      );
      return {
        tools: [],
        toolContextMap: state.webSearch ? { web_search: WEB_SEARCH_GUIDE } : {},
        dynamicToolContextMap: {},
        toolDefinitions: loaded.toolDefinitions,
        toolRegistry: loaded.toolRegistry,
        hasDeferredTools: loaded.hasDeferredTools,
      };
    },
  );
  const initialized = (await initializeAgent(
    {
      runtime: {
        user: { id: USER_ID },
        appConfig: {
          endpoints: { [EModelEndpoint.agents]: { promptCache: { stableContext: true } } },
        },
        requestBody: {},
        turnStartedAt: START,
        conversationCreatedAt: START,
      } as never,
      agent,
      loadTools: loadTools as never,
      endpointOption: { endpoint: EModelEndpoint.agents },
      allowedProviders: new Set([provider]),
      isInitialAgent: true,
      memoryAvailable: true,
      codeEnvAvailable: true,
    } as never,
    createDb(),
  )) as unknown as Record<string, unknown> & { toolRegistry?: Map<string, LCTool> };
  initialized.instructions = (initialized.instructions as string)?.trim() || undefined;
  if (state.model != null) {
    initialized.model_parameters = {
      ...(initialized.model_parameters as object),
      model: state.model,
    };
  }
  await applyContextToAgent({ agent: initialized as never, mcpManager, mcpServers: [] });
  return initialized;
}

interface Row extends TurnContextMessage {
  messageId: string;
  sender: string;
  text: string;
  content?: unknown[];
}

interface Conversation {
  rows: Row[];
  anchor: ContextEntry[] | null;
}

interface PlayedTurn {
  requests: Captured[];
  plan: TurnPlan;
  agent: Record<string, unknown>;
  stored: Row;
}

/** What the tool execution handler loads by name, recording each call. */
function createToolbox(registry: () => Map<string, LCTool> | undefined) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const make = (name: string) =>
    name === 'tool_search'
      ? createToolSearch({
          mode: 'local',
          toolRegistry: registry(),
          toolDispatch: TOOL_DISPATCHER_NAME,
        })
      : tool(
          async (args: unknown) => {
            calls.push({ name, args });
            return `${name} result: ${JSON.stringify(args)}`;
          },
          { name, description: name, schema: { type: 'object', properties: {} } },
        );
  return {
    calls,
    loadTools: async (toolNames: string[]) => ({
      loadedTools: toolNames.map(make),
      configurable: {},
    }),
  };
}

/** A plugin `PreToolUse` hook that records the tool names it is shown. */
function installHook(seen: string[]) {
  setPluginHookSource({
    hasHooks: () => true,
    register: ({ registry }: { registry: HookRegistry }) => {
      registry.register('PreToolUse', {
        hooks: [
          async (input: { toolName?: string }) => {
            seen.push(input.toolName ?? '');
            return {};
          },
        ],
      } as never);
      return 1;
    },
  });
}

interface PlayOptions {
  approval?: Record<string, unknown>;
  /** Tools the user chose to always allow in this conversation. */
  toolApprovalAllows?: string[];
  toolSetOf?: (agent: Record<string, unknown>) => Set<string>;
}

async function playTurn(
  providerCase: ProviderCase,
  conversation: Conversation,
  state: TurnState,
  index: number,
  calls: Array<{ name: string; args: unknown }>,
  {
    approval = APPROVAL,
    toolApprovalAllows,
    toolSetOf = (agent) => buildToolSet(agent as never),
  }: PlayOptions,
): Promise<PlayedTurn> {
  const agent = await prepareAgent(state, providerCase.provider);
  const loadedRegistry = agent.toolRegistry;
  const user: Row = {
    messageId: `u${index + 1}`,
    isCreatedByUser: true,
    sender: 'User',
    text: `Question ${index + 1}`,
  };
  const rows = [...conversation.rows, user];
  const plan = planTurnContext({
    messages: rows,
    conversationAnchor: conversation.anchor,
    currentIndex: rows.length - 1,
    snapshot: createSendSnapshot({
      agent: agent as never,
      agents: [agent as never],
      req: { turnStartedAt: START + index * 60_000 },
      toolGroups: await collectToolGroups({
        agent: agent as never,
        getInstructions: serverInstructions,
      }),
    }),
  });
  applyTurnContext(agent as never, plan);

  const formatted = rows.map((row, position) => {
    const message = formatMessage({ message: row as never });
    prependContextText(message as never, plan.updates.get(position), '\n\n');
    return message;
  });
  const { messages, summary } = formatAgentMessages(formatted as never, {}, toolSetOf(agent));
  const toolbox = createToolbox(() => loadedRegistry);
  const { contentParts, aggregateContent } = createContentAggregator();
  const aggregate = {
    handle: (event: string, data: unknown) => aggregateContent({ event, data } as never),
  };
  const requests = await captureRun({
    providerCase,
    agent,
    messages,
    initialSummary: summary,
    streaming: true,
    runOptions: {
      appConfig: {
        endpoints: {
          [EModelEndpoint.agents]: { toolApproval: approval, promptCache: { stableContext: true } },
        },
      },
      ...(toolApprovalAllows && { toolApprovalAllows }),
    },
    customHandlers: {
      [GraphEvents.ON_TOOL_EXECUTE]: createToolExecuteHandler({
        loadTools: toolbox.loadTools as never,
      }),
      [GraphEvents.ON_RUN_STEP]: aggregate,
      [GraphEvents.ON_RUN_STEP_DELTA]: aggregate,
      [GraphEvents.ON_RUN_STEP_COMPLETED]: aggregate,
      [GraphEvents.ON_MESSAGE_DELTA]: aggregate,
      [GraphEvents.ON_PROVIDER_OUTPUT_ITEMS]: aggregate,
    },
    respond: (position, request) => {
      const reply = state.replies?.[position];
      return reply ? providerReply(providerCase, request, reply) : undefined;
    },
  });
  calls.push(...toolbox.calls);

  const content = contentParts.filter(Boolean) as unknown[];
  const stored: Row = {
    messageId: `a${index + 1}`,
    isCreatedByUser: false,
    sender: 'Assistant',
    text: '',
    content: state.compacts
      ? [
          {
            type: ContentTypes.SUMMARY,
            content: [{ type: ContentTypes.TEXT, text: SUMMARY }],
            tokenCount: 20,
            boundary: { messageId: `a${index + 1}`, contentIndex: 0 },
          },
          ...content,
        ]
      : content,
  };
  conversation.rows.push({ ...user, contextUpdates: plan.currentEntries }, stored);
  if (plan.anchorTarget?.messageId === null) {
    conversation.anchor ??= plan.anchor;
  } else if (plan.anchorTarget != null) {
    const carrier = conversation.rows.find((row) => row.messageId === plan.anchorTarget?.messageId);
    if (carrier != null && carrier.contextAnchor == null) {
      carrier.contextAnchor = plan.anchor;
    }
  }
  return { requests, plan, agent, stored };
}

async function playConversation(
  providerCase: ProviderCase,
  turns: TurnState[],
  options: PlayOptions = {},
) {
  const conversation: Conversation = { rows: [], anchor: null };
  const calls: Array<{ name: string; args: unknown }> = [];
  const hookNames: string[] = [];
  installHook(hookNames);
  const played: PlayedTurn[] = [];
  try {
    for (let i = 0; i < turns.length; i++) {
      played.push(await playTurn(providerCase, conversation, turns[i], i, calls, options));
    }
  } finally {
    setPluginHookSource(undefined);
  }
  return { played, calls, hookNames };
}

/** Tool names of a request, in the order the provider receives them. */
function toolNames(request: Captured): string[] {
  const tools = request.tools as
    | Array<{
        name?: string;
        function?: { name: string };
        functionDeclarations?: Array<{ name: string }>;
      }>
    | { tools?: Array<{ toolSpec?: { name: string } }> }
    | undefined;
  if (tools == null) {
    return [];
  }
  if (!Array.isArray(tools)) {
    return (tools.tools ?? []).flatMap(({ toolSpec }) => (toolSpec ? [toolSpec.name] : []));
  }
  return tools.flatMap(
    (entry) =>
      entry.functionDeclarations?.map(({ name }) => name) ?? [
        entry.function?.name ?? entry.name ?? '',
      ],
  );
}

/** Every provider, and the Responses API, which replays tool rounds with their stored items. */
const ALL_CASES = [...PROVIDERS, OPENAI_RESPONSES];

const json = (value: unknown) => JSON.stringify(value);
const lastMessage = (request: Captured) => json(request.messages[request.messages.length - 1]);

/**
 * Known gap of every failed tool call, dispatched or not: the next turn restores the result
 * without its error status (Bedrock `status: "error"`, Gemini `response.error`).
 */
const ERROR_STATUS_NOT_RESTORED = new Set(['bedrock', 'bedrock with promptCache', 'google']);

describe('tool groups across providers', () => {
  describe.each(ALL_CASES.map((providerCase) => [providerCase.name, providerCase] as const))(
    '%s',
    (_name, providerCase) => {
      let result: Awaited<ReturnType<typeof playConversation>>;
      let turns: Captured[][];

      beforeAll(async () => {
        result = await playConversation(providerCase, SCENARIO);
        turns = result.played.map(({ requests }) => requests);
      });

      it('answers every scripted request', () => {
        turns.forEach((requests, i) =>
          expect(requests).toHaveLength(SCENARIO[i].replies?.length ?? 1),
        );
      });

      it('keeps tools and system byte-identical on every request of a segment', () => {
        const first = turns[0][0];
        expect(toolNames(first)).toEqual([
          'delete_memory',
          'set_memory',
          'tool_search',
          SEARCH,
          TOOL_DISPATCHER_NAME,
        ]);
        for (const request of turns.slice(0, SECOND_SEGMENT).flat()) {
          expect(serialize(request.tools)).toBe(serialize(first.tools));
          expect(serialize(request.system)).toBe(serialize(first.system));
        }
        expect(json(first.system)).toContain(INSTRUCTIONS.alpha);
        expect(json(first.system)).not.toContain(INSTRUCTIONS.beta);
      });

      it('starts every request of a segment with all bytes of the one before it', () => {
        const segment = turns.slice(0, SECOND_SEGMENT).flat();
        for (let i = 1; i < segment.length; i++) {
          const previous = segment[i - 1].messages;
          expect(serialize(segment[i].messages.slice(0, previous.length))).toBe(
            serialize(previous),
          );
        }
      });

      it('announces each change only in the message sent with it', () => {
        const sent = turns.map((requests) => requests[0]);
        expect(lastMessage(sent[0])).not.toContain('context_update');
        expect(lastMessage(sent[1])).toContain('Tools of MCP server `beta` are now available.');
        expect(lastMessage(sent[1])).toContain(INSTRUCTIONS.beta);
        expect(lastMessage(sent[1])).toContain(`- ${QUERY}: Queries beta stock.`);
        expect(lastMessage(sent[2])).not.toContain('context_update');
        expect(lastMessage(sent[3])).toContain('Tools of MCP server `beta` were switched off');
        expect(lastMessage(sent[3])).toContain(
          'Tools of action `api---example---com` are now available.',
        );
        /** Unreachable is not switched off: nothing to announce, calls are refused. */
        expect(lastMessage(sent[4])).not.toContain('context_update');
        expect(result.played[4].agent.toolDefinitions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: SEARCH, disabled: { reason: 'unavailable' } }),
          ]),
        );
      });

      it('runs a tool added mid-conversation through the dispatcher, under its own name', () => {
        expect(result.calls).toEqual([
          { name: QUERY, args: { q: 'bolts' } },
          { name: LOOKUP, args: { order: '7' } },
        ]);
        expect(result.hookNames).toEqual([QUERY, 'tool_search', LOOKUP]);
        const [first, followUp] = turns[2];
        const appended = json(followUp.messages.slice(first.messages.length));
        expect(appended).toContain(TOOL_DISPATCHER_NAME);
        expect(appended).toContain(`${QUERY} result:`);
      });

      it('stores the dispatched call in the model form, with the tool it ran', () => {
        const parts = result.played[2].stored.content as Array<{
          tool_call?: Record<string, unknown>;
        }>;
        const call = parts.find((part) => part.tool_call != null)?.tool_call;
        expect(call).toMatchObject({ name: TOOL_DISPATCHER_NAME, dispatched: { name: QUERY } });
      });

      it('keeps found tools out of the tool list and calls them through the dispatcher', () => {
        const [search, found] = turns[4];
        expect(toolNames(found)).toEqual(toolNames(search));
        const results = json(found.messages.slice(search.messages.length));
        expect(results).toContain('call_with');
        expect(results).toContain(LOOKUP);
        const parts = result.played[4].stored.content as Array<{
          tool_call?: Record<string, unknown>;
        }>;
        expect(parts.map((part) => part.tool_call?.name).filter(Boolean)).toEqual([
          'tool_search',
          TOOL_DISPATCHER_NAME,
        ]);
      });

      it('re-anchors at the compaction: keeps the order, drops what is off, appends the new group', () => {
        const before = toolNames(turns[0][0]);
        const after = toolNames(turns[SECOND_SEGMENT][0]);
        expect(after).toEqual([...before.slice(0, -1), ACTION, TOOL_DISPATCHER_NAME]);
        expect(json(turns[SECOND_SEGMENT][0].system)).toContain(INSTRUCTIONS.alpha);
        const messages = turns[SECOND_SEGMENT][0].messages;
        expect(json([turns[SECOND_SEGMENT][0].system, messages])).toContain(SUMMARY);
        expect(json(messages)).not.toContain('context_update');
      });
    },
  );

  describe('a schema the server changes mid-segment', () => {
    const DRIFT: TurnState[] = [
      { mcp: ['alpha'], replies: [answer(1)] },
      {
        mcp: ['alpha'],
        drift: true,
        replies: [
          { calls: [{ id: 'toolu_d2', name: SEARCH, args: { query: 'bolts' } }] },
          answer(2),
        ],
      },
      { mcp: ['alpha'], drift: true, replies: [answer(3)] },
    ];

    describe.each(PROVIDERS.map((providerCase) => [providerCase.name, providerCase] as const))(
      '%s',
      (_name, providerCase) => {
        let result: Awaited<ReturnType<typeof playConversation>>;
        let turns: Captured[][];

        beforeAll(async () => {
          result = await playConversation(providerCase, DRIFT);
          turns = result.played.map(({ requests }) => requests);
        });

        it('keeps tools and system byte-identical', () => {
          const first = turns[0][0];
          for (const request of turns.flat()) {
            expect(serialize(request.tools)).toBe(serialize(first.tools));
            expect(serialize(request.system)).toBe(serialize(first.system));
          }
        });

        it('announces the new schema once, in the message sent with the change', () => {
          const sent = turns.map((requests) => requests[0]);
          expect(lastMessage(sent[0])).not.toContain('context_update');
          expect(lastMessage(sent[1])).toContain('Tools of MCP server `alpha` changed.');
          expect(lastMessage(sent[1])).toContain('Your tool list still shows their previous');
          expect(lastMessage(sent[1])).toContain('Searches alpha, now by query.');
          expect(lastMessage(sent[1])).toContain('query');
          expect(lastMessage(sent[2])).not.toContain('context_update');
        });

        it('runs the call the model made with the new parameters, and keeps the prefix', () => {
          expect(result.calls).toEqual([{ name: SEARCH, args: { query: 'bolts' } }]);
          const segment = turns.flat();
          for (let i = 1; i < segment.length; i++) {
            const previous = segment[i - 1].messages;
            expect(serialize(segment[i].messages.slice(0, previous.length))).toBe(
              serialize(previous),
            );
          }
        });
      },
    );
  });

  describe('approval of a dispatched call', () => {
    const [openAI] = PROVIDERS;
    const toDispatch = SCENARIO.slice(0, 3);
    const others = APPROVAL.allow.filter((name) => name !== QUERY);

    it('denies the call when the policy denies the real tool', async () => {
      const { played, calls } = await playConversation(openAI, toDispatch, {
        approval: { enabled: true, allow: others, deny: [QUERY] },
      });
      expect(calls).toEqual([]);
      const [first, followUp] = played[2].requests;
      expect(json(followUp.messages.slice(first.messages.length))).not.toContain(`${QUERY} result`);
    });

    it('holds a call the policy does not allow, and runs it once the user always allows it', async () => {
      const held = await playConversation(openAI, toDispatch, {
        approval: { enabled: true, allow: others, allowAlways: true },
      });
      expect(held.calls).toEqual([]);
      const allowed = await playConversation(openAI, toDispatch, {
        approval: { enabled: true, allow: others, allowAlways: true },
        toolApprovalAllows: [QUERY],
      });
      expect(allowed.calls).toEqual([{ name: QUERY, args: { q: 'bolts' } }]);
    });
  });

  describe('reverting the dispatcher entry of the formatter tool set', () => {
    it('strips the stored dispatcher call and breaks the next turn prefix', async () => {
      const [openAI] = PROVIDERS;
      const { played } = await playConversation(openAI, SCENARIO.slice(0, 4), {
        toolSetOf: (agent) => {
          const toolSet = buildToolSet(agent as never);
          toolSet.delete(TOOL_DISPATCHER_NAME);
          return toolSet;
        },
      });
      const [, followUp] = played[2].requests;
      const next = played[3].requests[0];
      expect(serialize(next.messages.slice(0, followUp.messages.length))).not.toBe(
        serialize(followUp.messages),
      );
    });
  });

  describe.each(ALL_CASES.map((providerCase) => [providerCase.name, providerCase] as const))(
    'built-in capabilities: %s',
    (_name, providerCase) => {
      let result: Awaited<ReturnType<typeof playConversation>>;
      let turns: Captured[][];

      beforeAll(async () => {
        result = await playConversation(providerCase, BUILTIN_SCENARIO, {
          approval: BUILTIN_APPROVAL,
        });
        turns = result.played.map(({ requests }) => requests);
      });

      it('answers every scripted request', () => {
        turns.forEach((requests, i) =>
          expect(requests).toHaveLength(BUILTIN_SCENARIO[i].replies?.length ?? 1),
        );
      });

      it('keeps tools and system byte-identical while built-ins are switched', () => {
        const first = turns[0][0];
        expect(toolNames(first)).toEqual([
          'bash_tool',
          'create_file',
          'edit_file',
          'read_file',
          'delete_memory',
          'set_memory',
          'tool_search',
          SEARCH,
          TOOL_DISPATCHER_NAME,
        ]);
        for (const request of turns.slice(0, RESET_TURN).flat()) {
          expect(serialize(request.tools)).toBe(serialize(first.tools));
          expect(serialize(request.system)).toBe(serialize(first.system));
        }
        expect(json(first.system)).not.toContain(WEB_SEARCH_GUIDE);
      });

      it('starts every request with all bytes of the one before it, except at the reset', () => {
        const all = turns.flat();
        const resetAt = turns.slice(0, RESET_TURN).flat().length;
        /** The request right after the refused call, whose result ends the one before it. */
        const afterRefusal = turns.slice(0, 3).flat().length;
        for (let i = 1; i < all.length; i++) {
          const previous =
            i === afterRefusal && ERROR_STATUS_NOT_RESTORED.has(providerCase.name)
              ? all[i - 1].messages.slice(0, -1)
              : all[i - 1].messages;
          const prefix = serialize(all[i].messages.slice(0, previous.length));
          if (i === resetAt) {
            expect(prefix).not.toBe(serialize(previous));
          } else {
            expect(prefix).toBe(serialize(previous));
          }
        }
      });

      it('announces a built-in with its instructions, switching off and on again', () => {
        const sent = turns.map((requests) => requests[0]);
        expect(lastMessage(sent[1])).toContain(
          'Tools of built-in capability `web_search` are now available.',
        );
        expect(lastMessage(sent[1])).toContain(WEB_SEARCH_GUIDE);
        expect(lastMessage(sent[2])).toContain(
          'Tools of built-in capability `execute_code` were switched off',
        );
        expect(lastMessage(sent[3])).toContain(
          'Tools of built-in capability `execute_code` are available again.',
        );
      });

      it('runs a dispatched built-in under its own name and refuses a switched-off one', () => {
        expect(result.calls).toEqual([{ name: 'web_search', args: { query: 'bolts' } }]);
        expect(result.hookNames).toEqual(['web_search']);
        const [, refused, followUp] = turns[2];
        const appended = json(followUp.messages.slice(refused.messages.length));
        expect(appended).toContain('is disabled in this conversation');
      });

      it('re-anchors at a declared reset: keeps the order and appends the deferred built-in', () => {
        const reset = result.played[RESET_TURN];
        expect(reset.plan.reset).toEqual(['model']);
        expect(reset.plan.anchorTarget).toEqual({ messageId: `u${RESET_TURN + 1}` });
        const before = toolNames(turns[0][0]);
        const after = toolNames(turns[RESET_TURN][0]);
        expect(after).toEqual([...before.slice(0, -1), 'web_search', TOOL_DISPATCHER_NAME]);
        expect(json(turns[RESET_TURN][0].system)).toContain(WEB_SEARCH_GUIDE);
        expect(json(turns[RESET_TURN][0].messages)).not.toContain('context_update');
        const next = turns[RESET_TURN + 1][0];
        expect(serialize(next.tools)).toBe(serialize(turns[RESET_TURN][0].tools));
        expect(serialize(next.system)).toBe(serialize(turns[RESET_TURN][0].system));
        expect(result.played[RESET_TURN + 1].plan.reset).toBeUndefined();
      });
    },
  );
});
