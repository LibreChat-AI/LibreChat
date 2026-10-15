/**
 * OpenAI Responses tool rounds keep the prompt prefix across turns.
 *
 * Each turn runs the real `createRun` with LibreChat's tool execution handler against
 * scripted Responses streams (reasoning items with encrypted content, function calls with
 * ids and status). The SDK content aggregator receives the events the chat path routes to
 * it, `ON_PROVIDER_OUTPUT_ITEMS` included; its parts are stored as the reply and restored
 * through `formatAgentMessages` on the next turn. The items are split off the content the way
 * `saveMessage` stores them and put back for formatting; what a client receives is serialized
 * the way the stream routes serialize it.
 *
 * Scenario: two parallel calls, then a sequential call, then the answer; one call and the
 * answer; a plain answer.
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

import { tool } from '@langchain/core/tools';
import {
  GraphEvents,
  formatMessage,
  formatAgentMessages,
  createContentAggregator,
} from '@librechat/agents';
import type { LCTool } from '@librechat/agents';
import type { Captured } from './helpers/providerCapture';
import type { Reply } from './helpers/providerReplies';
import { OPENAI_RESPONSES, captureRun, serialize } from './helpers/providerCapture';
import { splitProviderItems } from '@librechat/data-schemas';
import {
  attachProviderItems,
  stripProviderItems,
  omitProviderItemsFromEvent,
} from '~/utils/message';
import { providerReply } from './helpers/providerReplies';
import { createToolExecuteHandler } from '../handlers';

jest.setTimeout(120000);

const TOOLS = ['lookup_order', 'search_docs'];
const DEFINITIONS: LCTool[] = TOOLS.map((name) => ({
  name,
  description: `Runs ${name}.`,
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
}));

const call = (id: string, name: string, query: string) => ({ id, name, args: { query } });
const TURNS: Reply[][] = [
  [
    { calls: [call('call_1a', 'lookup_order', '1'), call('call_1b', 'lookup_order', '2')] },
    { calls: [call('call_1c', 'search_docs', 'shipping')] },
    { text: 'Both ship today.' },
  ],
  [{ calls: [call('call_2a', 'search_docs', 'warranty')] }, { text: 'Two years.' }],
  [{ text: 'You are welcome.' }],
];

interface Row {
  messageId: string;
  isCreatedByUser: boolean;
  sender: string;
  text: string;
  content?: unknown[];
  providerItems?: Record<string, unknown>;
}

interface PlayedTurn {
  requests: Captured[];
  /** The content as the run built it, items on the tool calls. */
  live: unknown[];
  /** The content as stored, and the items stored beside it. */
  stored: unknown[];
  providerItems?: Record<string, unknown>;
}

const loadTools = async (toolNames: string[]) => ({
  loadedTools: toolNames.map((name) =>
    tool(async ({ query }: { query: string }) => `${name} result for ${query}`, {
      name,
      description: name,
      schema: { type: 'object', properties: { query: { type: 'string' } } },
    }),
  ),
  configurable: {},
});

/** Plays the conversation, storing what the aggregator builds as each reply. */
async function playConversation(routeProviderItems = true): Promise<PlayedTurn[]> {
  const rows: Row[] = [];
  const played: PlayedTurn[] = [];
  for (const [index, replies] of TURNS.entries()) {
    rows.push({
      messageId: `u${index + 1}`,
      isCreatedByUser: true,
      sender: 'User',
      text: `Question ${index + 1}`,
    });
    const formatted = rows.map((row) =>
      formatMessage({ message: attachProviderItems(row) as never }),
    );
    const { messages } = formatAgentMessages(formatted as never, {}, new Set(TOOLS));
    const { contentParts, aggregateContent } = createContentAggregator();
    const aggregate = {
      handle: (event: string, data: unknown) => aggregateContent({ event, data } as never),
    };
    const requests = await captureRun({
      providerCase: OPENAI_RESPONSES,
      agent: {
        id: 'agent_main',
        name: 'Main',
        instructions: 'Answer support questions.',
        toolDefinitions: DEFINITIONS,
        toolRegistry: new Map(DEFINITIONS.map((definition) => [definition.name, definition])),
      },
      messages,
      streaming: true,
      customHandlers: {
        [GraphEvents.ON_TOOL_EXECUTE]: createToolExecuteHandler({ loadTools: loadTools as never }),
        [GraphEvents.ON_RUN_STEP]: aggregate,
        [GraphEvents.ON_RUN_STEP_DELTA]: aggregate,
        [GraphEvents.ON_RUN_STEP_COMPLETED]: aggregate,
        [GraphEvents.ON_MESSAGE_DELTA]: aggregate,
        ...(routeProviderItems && { [GraphEvents.ON_PROVIDER_OUTPUT_ITEMS]: aggregate }),
      },
      respond: (position, request) => {
        const reply = replies[position];
        return reply ? providerReply(OPENAI_RESPONSES, request, reply) : undefined;
      },
    });
    const live = contentParts.filter(Boolean) as unknown[];
    const split = splitProviderItems(live);
    const stored = split?.content ?? live;
    rows.push({
      messageId: `a${index + 1}`,
      isCreatedByUser: false,
      sender: 'Assistant',
      text: '',
      content: stored,
      providerItems: split?.providerItems,
    });
    played.push({ requests, live, stored, providerItems: split?.providerItems });
  }
  return played;
}

const json = (value: unknown) => JSON.stringify(value);
const toolCallsOf = (content: unknown[]) =>
  content.flatMap((part) => {
    const toolCall = (part as { tool_call?: Record<string, unknown> }).tool_call;
    return toolCall ? [toolCall] : [];
  });

/** Index of the first request that does not start with all bytes of the one before it. */
function firstBrokenPrefix(requests: Captured[]): number {
  return requests.findIndex(
    (request, i) =>
      i > 0 &&
      serialize(request.messages.slice(0, requests[i - 1].messages.length)) !==
        serialize(requests[i - 1].messages),
  );
}

describe('OpenAI Responses tool rounds across turns', () => {
  let played: PlayedTurn[];
  let requests: Captured[];

  beforeAll(async () => {
    played = await playConversation();
    requests = played.flatMap((turn) => turn.requests);
  });

  it('answers every scripted request', () => {
    played.forEach((turn, i) => expect(turn.requests).toHaveLength(TURNS[i].length));
  });

  it('starts every request, the first of each turn included, with all bytes of the one before it', () => {
    expect(firstBrokenPrefix(requests)).toBe(-1);
    for (const request of requests.slice(1)) {
      expect(serialize(request.system)).toBe(serialize(requests[0].system));
      expect(serialize(request.tools)).toBe(serialize(requests[0].tools));
    }
  });

  it('replays the stored rounds with their reasoning items, ids and status', () => {
    const restored = json(played[1].requests[0].messages);
    expect(restored).toContain('"encrypted_content":"encrypted_');
    expect(restored).toMatch(/"id":"fc_msg_\d+_1","type":"function_call","status":"completed"/);
    expect(restored).toContain('"call_id":"call_1c"');
  });

  it('reports the provider items on every tool call of the live reply', () => {
    const calls = toolCallsOf(played[0].live);
    expect(calls.map((toolCall) => toolCall.id)).toEqual(['call_1a', 'call_1b', 'call_1c']);
    for (const toolCall of calls) {
      expect(toolCall.providerItems).toEqual(
        expect.objectContaining({ origin: expect.any(String), items: expect.any(Array) }),
      );
    }
  });

  it('stores them beside the content, keyed by tool call, and leaves the content clean', () => {
    expect(Object.keys(played[0].providerItems ?? {})).toEqual(['call_1a', 'call_1b', 'call_1c']);
    expect(json(played[0].stored)).not.toContain('providerItems');
    expect(json(played[0].stored)).not.toContain('encrypted_');
    expect(toolCallsOf(played[0].stored)).toHaveLength(3);
    expect(played[2].providerItems).toBeUndefined();
  });

  it('keeps the live provider items out of what a client receives', () => {
    const sync = omitProviderItemsFromEvent({
      sync: true,
      resumeState: { aggregatedContent: played[0].live },
    });
    const final = omitProviderItemsFromEvent({
      final: true,
      responseMessage: { content: played[0].live },
    });
    expect(json(sync)).not.toContain('encrypted_');
    expect(json(final)).not.toContain('encrypted_');
    expect(toolCallsOf(final.responseMessage.content)).toHaveLength(3);
    expect(json(stripProviderItems(played[0].live))).not.toContain('providerItems');
    expect(toolCallsOf(played[0].live)[0]).toHaveProperty('providerItems');
  });

  it('breaks the prefix at the first restored round without the routed items', async () => {
    const unrouted = (await playConversation(false)).flatMap((turn) => turn.requests);
    expect(firstBrokenPrefix(unrouted)).toBe(played[0].requests.length);
  });
});
