/**
 * Recorded-shape conversations the outside host and LibreChat both draw. Each is one user turn and
 * one assistant reply, written as the messages endpoint returns them, so the spec can hand the same
 * objects to LibreChat's chat view (through the routes it intercepts) and to the outside host.
 *
 * Plain objects on purpose: this file is read by the Playwright spec and by the host page, and
 * names no type from the packages.
 */

export const NO_PARENT = '00000000-0000-0000-0000-000000000000';

/** A 2x2 PNG both pages fetch from the same intercepted path. */
export const IMAGE_PATH = '/images/outside-host/chart.png';
export const IMAGE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGNk+M/wn4GBgYGJAQoAAP8DAgEAoQnvVQAAAABJRU5ErkJggg==';

export type Fixture = {
  /** What the transcript exercises, for a reader of the spec's output. */
  covers: string;
  conversation: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
};

const AT = new Date(Date.UTC(2026, 10, 24, 12, 0, 0)).toISOString();

const toolCall = (
  id: string,
  name: string,
  args: unknown,
  output: string | undefined,
  extra: Record<string, unknown> = {},
) => ({
  type: 'tool_call',
  tool_call: {
    id,
    name,
    args: typeof args === 'string' ? args : JSON.stringify(args),
    ...(output == null ? {} : { output }),
    progress: output == null ? 0.5 : 1,
    type: 'tool_call',
    ...(output == null ? {} : { runStepStatus: 'completed' }),
    ...extra,
  },
});

const text = (value: string, extra: Record<string, unknown> = {}) => ({
  type: 'text',
  text: value,
  ...extra,
});

/** One user turn and one reply in conversation `name`, with the reply's parts and attachments. */
function exchange(
  name: string,
  covers: string,
  question: string,
  content: unknown[],
  reply: Record<string, unknown> = {},
): Fixture {
  const conversationId = `outside-host-${name}`;
  const userId = `${conversationId}-user`;
  const replyId = `${conversationId}-reply`;
  return {
    covers,
    conversation: {
      conversationId,
      title: `Outside host: ${name}`,
      endpoint: 'Mock Provider A',
      endpointType: 'custom',
      model: 'mock-model-a',
      createdAt: AT,
      updatedAt: AT,
    },
    messages: [
      {
        messageId: userId,
        conversationId,
        parentMessageId: NO_PARENT,
        isCreatedByUser: true,
        sender: 'User',
        text: question,
        createdAt: AT,
        updatedAt: AT,
      },
      {
        messageId: replyId,
        conversationId,
        parentMessageId: userId,
        isCreatedByUser: false,
        sender: 'Mock Provider A',
        endpoint: 'Mock Provider A',
        model: 'mock-model-a',
        text: '',
        content,
        createdAt: AT,
        updatedAt: AT,
        ...reply,
      },
    ],
  };
}

const MARKDOWN = [
  '## Release notes',
  '',
  'The cache is **warm** and the queue is _drained_; run `npm ci` before the build.',
  'See [the guide](https://docs.example.invalid/guide) for details.',
  '',
  '- First item',
  '- Second item with `code`',
  '',
  '1. Ordered one',
  '2. Ordered two',
  '',
  '> A quoted line.',
  '',
  '| Column | Value |',
  '| ------ | ----- |',
  '| alpha  | 1     |',
  '| beta   | 2     |',
  '',
  'Inline math $a^2 + b^2 = c^2$ and a block:',
  '',
  '$$',
  '\\int_0^1 x\\,dx = \\frac{1}{2}',
  '$$',
  '',
  '```python',
  'def total(values):',
  '    return sum(values)',
  '```',
].join('\n');

export const FIXTURES: Record<string, Fixture> = {
  prose: exchange(
    'prose',
    'markdown: headings, emphasis, links, lists, quote, table, math, code',
    'Write the release notes.',
    [text(MARKDOWN)],
  ),
  reasoning: exchange('reasoning', 'a reasoning part before the answer', 'Think first.', [
    { type: 'think', think: 'Weighing the two options before answering.' },
    text('The second option is cheaper.'),
  ]),
  tools: exchange(
    'tools',
    'a lone tool call, a labelled batch of two, and the answer',
    'Look it up.',
    [
      toolCall('lookup-1', 'lookup_records', { query: 'invoices' }, 'Found 3 records'),
      text('Now the details.'),
      toolCall('lookup-2', 'read_file', { path: 'notes.md' }, '# Notes'),
      toolCall('lookup-3', 'list_files', { path: '.' }, 'notes.md\nplan.md'),
      {
        type: 'activity_label',
        activity_label: 'Read the notes and listed the folder',
        tool_call_ids: ['lookup-2', 'lookup-3'],
        pending: false,
      },
      text('Both files are present.'),
    ],
  ),
  phases: exchange(
    'phases',
    'a settled activity phase folding two batches, then the answer',
    'Investigate.',
    [
      toolCall('phase-1', 'lookup_records', { query: 'orders' }, '12 orders'),
      {
        type: 'activity_label',
        activity_label: 'Counted the orders',
        tool_call_ids: ['phase-1'],
        pending: false,
      },
      toolCall('phase-2', 'read_file', { path: 'orders.csv' }, 'id,total'),
      {
        type: 'activity_label',
        activity_label: 'Read the order file',
        tool_call_ids: ['phase-2'],
        pending: false,
      },
      {
        type: 'activity_label',
        activity_label: 'Reconciled the orders against the file',
        activity_label_type: 'phase',
        activity_start_index: 0,
        activity_end_index: 4,
        activity_count: 2,
        pending: false,
      },
      text('Every order is in the file.'),
    ],
  ),
  parallel: exchange('parallel', 'two agents answering side by side', 'Ask both.', [
    text('Lane one answered.', { groupId: 1, agentId: 'agent_lane_one' }),
    text('Lane two answered.', { groupId: 1, agentId: 'agent_lane_two' }),
  ]),
  attachments: exchange(
    'attachments',
    'a tool call that produced an image file',
    'Chart it.',
    [
      toolCall('chart-1', 'execute_code', { lang: 'py', code: 'plot()' }, 'Saved chart.png'),
      text('Here is the chart.'),
    ],
    {
      attachments: [
        {
          type: 'image/png',
          file_id: 'outside-host-chart',
          filename: 'chart.png',
          filepath: IMAGE_PATH,
          width: 2,
          height: 2,
          toolCallId: 'chart-1',
          conversationId: 'outside-host-attachments',
          messageId: 'outside-host-attachments-reply',
        },
      ],
    },
  ),
  'mcp-app': exchange(
    'mcp-app',
    'an MCP App a tool call returned, drawn as its own row',
    'Show the dashboard.',
    [
      toolCall('app-1', 'show_dashboard_mcp_e2e-apps', {}, 'Rendered the dashboard'),
      text('The dashboard is above.'),
    ],
    {
      attachments: [
        {
          type: 'ui_resources',
          toolCallId: 'app-1',
          conversationId: 'outside-host-mcp-app',
          messageId: 'outside-host-mcp-app-reply',
          ui_resources: [
            {
              uri: 'ui://e2e-apps/dashboard',
              mimeType: 'text/html;profile=mcp-app',
              toolName: 'show_dashboard',
              serverName: 'e2e-apps',
              text: '<html><body>Dashboard</body></html>',
            },
          ],
        },
      ],
    },
  ),
  subagent: exchange('subagent', 'a subagent call and its report', 'Delegate it.', [
    toolCall(
      'sub-1',
      'subagent',
      { description: 'Summarize the logs', subagent_type: 'researcher' },
      'The logs show two restarts.',
    ),
    text('The researcher found two restarts.'),
  ]),
  'web-search': exchange(
    'web-search',
    'a web search call and its sources',
    'Search for it.',
    [
      toolCall('search-1', 'web_search', { query: 'view transitions' }, 'results'),
      text('View transitions animate between states.'),
    ],
    {
      attachments: [
        {
          type: 'web_search',
          toolCallId: 'search-1',
          conversationId: 'outside-host-web-search',
          messageId: 'outside-host-web-search-reply',
          web_search: {
            turn: 0,
            organic: [
              {
                link: 'https://developer.mozilla.org/',
                title: 'MDN on view transitions',
                snippet: 'The View Transition API',
                attribution: 'developer.mozilla.org',
              },
            ],
            topStories: [],
            images: [],
            references: [],
          },
        },
      ],
    },
  ),
  error: exchange(
    'error',
    'a reply that failed with an error part',
    'Fail please.',
    [{ type: 'error', error: 'The provider rejected the request.' }],
    { error: true },
  ),
  approval: exchange('approval', 'a tool call paused for the reader to approve', 'Delete it.', [
    toolCall('approve-1', 'delete_records', { ids: [1, 2] }, undefined, {
      approval: {
        actionId: 'outside-host-approval',
        allowed_decisions: ['approve', 'reject'],
        description: 'Deletes two records',
      },
    }),
  ]),
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);
