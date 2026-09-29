import { formatAgentMessages, Providers } from '@librechat/agents';
import { createRun } from '~/agents/run';

type CapturedRequest = {
  tenantId?: string;
  body: Record<string, unknown>;
};

const ROOT_ID = 'agent_root';
const CHILD_ID = 'agent_child';
const TENANT_HEADER = 'x-tenant-id';

function anthropicStream(kind: 'delegate' | 'text', text = ''): string {
  const events: Array<[string, Record<string, unknown>]> = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: `msg_${kind}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
  ];

  if (kind === 'delegate') {
    events.push(
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_delegate', name: 'subagent', input: {} },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({
              description: 'Answer the user request.',
              subagent_type: CHILD_ID,
            }),
          },
        },
      ],
    );
  } else {
    events.push(
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        },
      ],
    );
  }

  events.push(
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: {
          stop_reason: kind === 'delegate' ? 'tool_use' : 'end_turn',
          stop_sequence: null,
        },
        usage: { output_tokens: 1 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  );

  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
}

function makeAgent(id: string, baseURL: string) {
  return {
    id,
    name: id,
    provider: Providers.ANTHROPIC,
    endpoint: 'Tenant Gateway',
    instructions:
      id === ROOT_ID
        ? 'Delegate the request to agent_child, then return its answer.'
        : 'Return a short answer.',
    tools: [],
    maxContextTokens: 4096,
    recursion_limit: 9,
    model_parameters: {
      model: 'claude-test',
      maxTokens: 64,
      streaming: false,
      apiKey: 'test-key',
      clientOptions: {
        baseURL,
        defaultHeaders: { 'X-Tenant-ID': '{{LIBRECHAT_USER_TENANT_ID}}' },
      },
    },
  };
}

describe('custom endpoint tenant headers E2E', () => {
  it('sends the authoritative tenant on root and subagent HTTP requests', async () => {
    const requests: CapturedRequest[] = [];
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : undefined;
      const headers = new Headers(request?.headers ?? init?.headers);
      const rawBody = request ? await request.clone().text() : String(init?.body ?? '{}');
      requests.push({
        tenantId: headers.get(TENANT_HEADER) ?? undefined,
        body: JSON.parse(rawBody) as Record<string, unknown>,
      });

      const stream =
        requests.length === 1
          ? anthropicStream('delegate')
          : anthropicStream('text', requests.length === 3 ? 'Final answer.' : 'Child answer.');

      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    try {
      const baseURL = 'https://fake-custom-endpoint.invalid';
      const child = makeAgent(CHILD_ID, baseURL);
      const root = {
        ...makeAgent(ROOT_ID, baseURL),
        subagents: { enabled: true, allowSelf: false, agent_ids: [CHILD_ID] },
        subagentAgentConfigs: [child],
      };
      const { messages } = formatAgentMessages(
        [{ role: 'user', content: 'Ask the child for an answer.' }] as never,
        {},
      );
      const runId = `custom-endpoint-tenant-${Date.now()}`;
      const run = await createRun({
        agents: [root] as never,
        messages,
        runId,
        signal: new AbortController().signal,
        streaming: false,
        streamUsage: true,
        user: { id: 'user-1', tenantId: 'stale-user-tenant' } as never,
        tenantId: 'request-tenant',
      });

      await run.processStream(
        { messages },
        {
          configurable: { thread_id: runId },
          recursionLimit: 20,
          version: 'v2',
        },
      );

      expect(requests).toHaveLength(3);
      expect(requests.every(({ tenantId }) => tenantId === 'request-tenant')).toBe(true);
      expect(requests.every(({ body }) => body.stream === true)).toBe(true);
      expect(requests.every(({ body }) => body.model === 'claude-test')).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
