import type { ChannelRunView } from 'librechat-data-provider';
import type { Presentation } from './presentation';
import { makeSlackPlan, durableSlackMessage, rendererVersion, renderRichAnswer } from './render';
import { channelPresentationSchema, parsePresentation, componentText } from './presentation';
import { SlackClient } from './slack';

const card = {
  type: 'card' as const,
  title: 'Documentation',
  body: 'Read the guide',
  links: [{ label: 'Open guide', url: 'https://docs.slack.dev/' }],
};
const chart = {
  type: 'chart' as const,
  title: 'Latency',
  chart: {
    type: 'line' as const,
    axis_config: { categories: ['Mon', 'Tue'], y_label: 'ms' },
    series: [
      {
        name: 'p95',
        data: [
          { label: 'Mon', value: 20 },
          { label: 'Tue', value: 17 },
        ],
      },
    ],
  },
};
const table = {
  type: 'table' as const,
  title: 'Results',
  columns: ['Name', 'Count'],
  rows: [
    ['Passed', 12],
    ['Failed', 0],
  ],
};
const image = {
  type: 'image' as const,
  url: 'https://example.com/image.png',
  alt: 'A workflow diagram',
};
const components: Presentation['blocks'] = [
  { type: 'header', text: 'Report' },
  { type: 'text', text: 'Hello <@U123> <!channel> & friends' },
  { type: 'context', text: 'Source: test' },
  { type: 'code', text: 'select 1;' },
  { type: 'divider' },
  image,
  card,
  { type: 'carousel', cards: [card, { ...card, title: 'Second' }] },
  chart,
  { ...chart, chart: { ...chart.chart, type: 'bar' } },
  { ...chart, chart: { ...chart.chart, type: 'area' } },
  {
    type: 'chart',
    title: 'Share',
    chart: {
      type: 'pie',
      segments: [
        { label: 'Yes', value: 2 },
        { label: 'No', value: 1 },
      ],
    },
  },
  table,
  { type: 'container', title: 'Details', blocks: [{ type: 'text', text: 'Detail' }, image] },
  {
    type: 'layout',
    title: 'Options',
    rows: [[card, { type: 'container', title: 'More', blocks: [{ type: 'text', text: 'One' }] }]],
  },
];
const document = (blocks: unknown = components, intro = 'Summary') =>
  `${intro}\n\n\`\`\`librechat-presentation\n${JSON.stringify({ version: 1, blocks })}\n\`\`\``;
const run = (text: string): ChannelRunView => ({
  runId: 'run-12345678',
  channelId: 'channel-1',
  revision: 'revision-1',
  state: 'delivering',
  sequence: 1,
  admission: {
    actor: { teamId: 'T1', appId: 'A1', externalUserId: 'U1' },
    eventId: 'event-1',
    externalChannelId: 'C1',
    externalThreadKey: 'C1:123.456',
    externalMessageKey: 'C1:123.457',
    input: 'report',
  },
  cancellationRequested: false,
  receipts: [],
  snapshot: { text, status: 'completed', elapsedMs: 100, responseId: 'resp_1' },
});

describe('semantic Slack presentations', () => {
  test('renders the complete component gallery through a frozen plan with complete text fallbacks', () => {
    const plan = makeSlackPlan(run(document()), true);
    const messages = plan.parts
      .filter((part) => part.required)
      .map((part) => durableSlackMessage(part, plan.rendererVersion));
    const blocks = messages.flatMap((message) => message.blocks ?? []);
    expect(blocks.map((block) => block.type)).toEqual(
      expect.arrayContaining([
        'header',
        'section',
        'context',
        'rich_text',
        'divider',
        'image',
        'card',
        'carousel',
        'data_visualization',
        'data_table',
        'container',
        'layout',
        'context_actions',
      ]),
    );
    const allText = messages.map((message) => message.text).join('\n');
    for (const component of components) {
      const expected = componentText(component)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      expect(allText).toContain(expected);
    }
    expect(allText).not.toContain('librechat-presentation');
    expect(allText).not.toContain('<@U123>');
    const layout = blocks.find((block) => block.type === 'layout');
    expect(layout).toMatchObject({ label: 'Options', is_label_visible: true });
    expect(layout?.type === 'layout' && layout.fallback).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'section' })]),
    );
    expect(blocks.find((block) => block.type === 'data_table')).toMatchObject({
      rows: [
        [
          { type: 'raw_text', text: 'Name' },
          { type: 'raw_text', text: 'Count' },
        ],
        [
          { type: 'raw_text', text: 'Passed' },
          { type: 'raw_number', value: 12, text: '12' },
        ],
        [
          { type: 'raw_text', text: 'Failed' },
          { type: 'raw_number', value: 0, text: '0' },
        ],
      ],
    });
    expect(blocks.find((block) => block.type === 'card')).toMatchObject({
      actions: [{ action_id: 'channel_presentation_link_0', url: 'https://docs.slack.dev/' }],
    });
  });

  test('works without native Agent sessions and preserves attachment failure notices', () => {
    const view = run(document([chart]));
    view.snapshot!.artifactsUnavailable = true;
    const plan = makeSlackPlan(view, false);
    expect(
      plan.parts.some((part) => part.presentation?.payload.includes('data_visualization')),
    ).toBe(true);
    expect(plan.parts.map((part) => part.text).join('\n')).toContain('Attachments are unavailable');
    expect(plan.parts.some((part) => part.presentation?.payload.includes('context_actions'))).toBe(
      false,
    );
  });

  test.each([
    ['ordinary JSON', JSON.stringify({ version: 1, blocks: [card] })],
    ['ordinary code', document([card]).replace('librechat-presentation', 'json')],
    [
      'quoted code',
      document([card], '')
        .split('\n')
        .map((line) => '> ' + line)
        .join('\n'),
    ],
    ['unfinished fence', document([card]).slice(0, -3)],
    ['trailing prose', document([card]) + '\nThis is only an example.'],
    ['multiple documents', document([card]) + '\n\n' + document([card])],
    ['oversized input', 'x'.repeat(128_001) + document([card])],
    ['malformed JSON', '```librechat-presentation\n{\n```'],
    ['unknown version', document([card]).replace('"version":1', '"version":2')],
    [
      'arbitrary Slack callbacks',
      document([
        { type: 'actions', elements: [{ type: 'button', action_id: 'channel_run_cancel' }] },
      ]),
    ],
    ['unknown keys', document([{ ...card, action_id: 'channel_run_cancel' }])],
    ['non-HTTPS image', document([{ ...image, url: 'http://example.com/a' }])],
    ['credentialed URL', document([{ ...image, url: 'https://user:password@example.com/a' }])],
  ])('keeps %s on the ordinary text path', (_name, value) => {
    expect(parsePresentation(value)).toBeUndefined();
    expect(
      renderRichAnswer(value).some((message) =>
        message.blocks?.some((block) => block.type === 'card'),
      ),
    ).toBe(false);
  });

  test.each([
    {
      ...chart,
      chart: {
        ...chart.chart,
        series: [{ ...chart.chart.series[0], data: [{ label: 'Wed', value: 1 }] }],
      },
    },
    { ...chart, chart: { ...chart.chart, series: [chart.chart.series[0], chart.chart.series[0]] } },
    { ...chart, chart: { ...chart.chart, axis_config: { categories: ['Mon', 'Mon'] } } },
    {
      type: 'chart',
      title: 'Pie',
      chart: { type: 'pie', segments: [{ label: 'Zero', value: 0 }] },
    },
    { ...table, rows: [['missing']] },
    { ...table, rows: [[Number.POSITIVE_INFINITY, 1]] },
    { ...table, rows: Array.from({ length: 201 }, () => ['row', 1]) },
    { type: 'layout', title: 'Invalid chart row', rows: [[chart, card]] },
    {
      type: 'container',
      title: 'Invalid nesting',
      blocks: [{ type: 'layout', title: 'Deep', rows: [[card]] }],
    },
  ])('rejects structurally invalid or unsupported data: %j', (component) => {
    expect(channelPresentationSchema.safeParse({ version: 1, blocks: [component] }).success).toBe(
      false,
    );
  });

  test('rejects duplicate pie labels in new documents and persisted payloads', () => {
    const pie = {
      type: 'chart',
      title: 'Share',
      chart: {
        type: 'pie',
        segments: [
          { label: 'Same', value: 2 },
          { label: 'Same', value: 1 },
        ],
      },
    };
    expect(parsePresentation(document([pie]))).toBeUndefined();
    const payload = JSON.stringify([
      { type: 'data_visualization', title: 'Share', chart: pie.chart },
    ]);
    const frozen = {
      operationId: 'run:reply:0',
      kind: 'message' as const,
      required: true,
      text: 'Share: Same 2; Same 1',
      presentation: { format: 'slack-blocks-v1', payload },
    };
    expect(() => durableSlackMessage(frozen, rendererVersion)).toThrow(
      'Invalid persisted Slack blocks',
    );
  });

  test('degrades a layout exceeding nested chart limits without losing its values', () => {
    const value = document([
      { type: 'layout', title: 'Three charts', rows: [[chart], [chart], [chart]] },
    ]);
    const plan = makeSlackPlan(run(value));
    const fallback = plan.parts.map((part) => part.text).join('\n');
    expect(fallback.match(/Mon: 20/g)).toHaveLength(3);
    expect(
      plan.parts.some((part) => part.presentation?.payload.includes('data_visualization')),
    ).toBe(false);
  });

  test('packs oversized rich fallbacks as messages instead of section-sized delivery parts', () => {
    const oversized = {
      type: 'layout',
      title: 'Large layout',
      rows: Array.from({ length: 5 }, () =>
        Array.from({ length: 2 }, () => ({
          type: 'container',
          title: 'Group',
          blocks: Array.from({ length: 10 }, () => ({ type: 'text', text: '&'.repeat(400) })),
        })),
      ),
    };
    const value = document([oversized]);
    expect(parsePresentation(value)).toBeDefined();
    const plan = makeSlackPlan(run(value));
    expect(plan.parts.length).toBeLessThan(10);
    expect(
      plan.parts
        .map((part) => part.text)
        .join('')
        .match(/&amp;/g),
    ).toHaveLength(40_000);
    expect(
      plan.parts.every(
        (part) =>
          Buffer.byteLength(part.text) <= 40_000 &&
          Buffer.byteLength(part.presentation?.payload ?? '') <= 64_000,
      ),
    ).toBe(true);
    expect(plan.parts.map((part) => part.text).join('')).not.toContain('Reply shortened');
    for (const part of plan.parts)
      expect(() => durableSlackMessage(part, plan.rendererVersion)).not.toThrow();
  });

  test('counts nested blocks and JSON bytes, and preserves all data through delivery shortening', () => {
    const giant = {
      type: 'layout',
      title: 'Large layout',
      rows: Array.from({ length: 5 }, () => [
        {
          type: 'container',
          title: 'Group',
          blocks: Array.from({ length: 10 }, () => ({
            type: 'text',
            text: 'large & <@U1> ' + '😀'.repeat(400),
          })),
        },
      ]),
    };
    const view = run(document([giant]));
    const plan = makeSlackPlan(view, true, 2);
    expect(plan.parts).toHaveLength(2);
    expect(
      plan.parts.every(
        (part) =>
          Buffer.byteLength(part.text) <= 40_000 &&
          Buffer.byteLength(part.presentation?.payload ?? '') <= 64_000,
      ),
    ).toBe(true);
    expect(plan.parts.at(-1)?.text).toContain('Reply shortened');
    expect(plan.parts[0].text).not.toContain('<@U1>');
    for (const part of plan.parts)
      expect(() => durableSlackMessage(part, plan.rendererVersion)).not.toThrow();
  });

  test('replays frozen v6 plans without stripping their footer and rejects modified v7 payloads', () => {
    const plan = makeSlackPlan(run('Ordinary reply'));
    expect(durableSlackMessage(plan.parts[0], 'slack-structured-v1').text).toBe(plan.parts[0].text);
    const rich = makeSlackPlan(run(document([card])));
    const part = rich.parts.find((item) => item.presentation?.payload.includes('card'))!;
    expect(() =>
      durableSlackMessage(
        {
          ...part,
          presentation: {
            ...part.presentation!,
            payload: part.presentation!.payload.replace(
              'channel_presentation_link_0',
              'channel_run_cancel',
            ),
          },
        },
        rendererVersion,
      ),
    ).toThrow('Invalid persisted Slack blocks');
    expect(() => makeSlackPlan({ ...run('Changed answer'), plan: rich })).toThrow(
      'Existing delivery plans',
    );
  });

  test('sends real SDK-shaped blocks and retries explicit unsupported blocks with the full fallback', async () => {
    const plan = makeSlackPlan(run(document([chart])));
    const part = plan.parts.find((item) =>
      item.presentation?.payload.includes('data_visualization'),
    )!;
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: 'invalid_blocks' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1.1' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const client = new SlackClient(
      { SLACK_API_BASE_URL: 'http://127.0.0.1:8080/api/', API_CALL_TIMEOUT_MS: 2000 },
      undefined,
      transport,
    );
    await expect(
      client.deliverPart('token', {
        channel: 'C1',
        ...durableSlackMessage(part, plan.rendererVersion),
      }),
    ).resolves.toEqual({ channel: 'C1', ts: '1.1' });
    expect(transport).toHaveBeenCalledTimes(2);
    const first = new URLSearchParams(String(transport.mock.calls[0][1]?.body));
    const second = new URLSearchParams(String(transport.mock.calls[1][1]?.body));
    expect(JSON.parse(first.get('blocks')!)[0].type).toBe('data_visualization');
    expect(second.get('blocks')).toBe('[]');
    expect(second.get('text')).toBe(first.get('text'));
    expect(second.get('text')).toContain('p95: Mon: 20; Tue: 17');
  });
});
