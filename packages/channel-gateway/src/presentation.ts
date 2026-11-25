import { z } from 'zod';
import { fromMarkdown } from 'mdast-util-from-markdown';

/** Platform safety bounds. Operational delivery limits remain in channel configuration. */
const characters = (maximum: number, empty = false) =>
  z.string().refine((value) => (empty || value.length > 0) && [...value].length <= maximum);
const unique = (values: string[]) => new Set(values).size === values.length;
const https = characters(2048).refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !/[<>|\s]/.test(value)
    );
  } catch {
    return false;
  }
});
const plain = (maximum: number) =>
  z.strictObject({ type: z.literal('plain_text'), text: characters(maximum) });
const imageElement = z.strictObject({
  type: z.literal('image'),
  image_url: https,
  alt_text: characters(2000),
});
const button = z.strictObject({
  type: z.literal('button'),
  text: plain(75),
  url: https,
  action_id: z.string().regex(/^channel_presentation_link_[0-2]$/),
});
const card = z.strictObject({
  type: z.literal('card'),
  title: plain(150),
  body: plain(200).optional(),
  subtitle: plain(150).optional(),
  hero_image: imageElement.optional(),
  actions: z.array(button).min(1).max(3).optional(),
});
const point = z.strictObject({ label: characters(20), value: z.number().finite() });
const seriesChart = z
  .strictObject({
    type: z.enum(['bar', 'line', 'area']),
    series: z
      .array(z.strictObject({ name: characters(20), data: z.array(point).min(1).max(20) }))
      .min(1)
      .max(12),
    axis_config: z.strictObject({
      categories: z.array(characters(20)).min(1).max(20),
      x_label: characters(50).optional(),
      y_label: characters(50).optional(),
    }),
  })
  .refine(
    (chart) =>
      unique(chart.axis_config.categories) &&
      unique(chart.series.map((entry) => entry.name)) &&
      chart.series.every(
        (entry) =>
          entry.data.length === chart.axis_config.categories.length &&
          unique(entry.data.map((item) => item.label)) &&
          entry.data.every((item) => chart.axis_config.categories.includes(item.label)),
      ),
  );
const pieChart = z.strictObject({
  type: z.literal('pie'),
  segments: z
    .array(point.extend({ value: z.number().finite().positive() }))
    .min(1)
    .max(12)
    .refine((segments) => unique(segments.map((segment) => segment.label))),
});
const chart = z.strictObject({
  type: z.literal('data_visualization'),
  title: characters(50),
  chart: z.union([seriesChart, pieChart]),
});
const tableCell = z.union([
  z.strictObject({ type: z.literal('raw_text'), text: characters(3000) }),
  z.strictObject({
    type: z.literal('raw_number'),
    value: z.number().finite(),
    text: characters(3000),
  }),
]);
const dataTable = z
  .strictObject({
    type: z.literal('data_table'),
    caption: characters(150),
    rows: z.array(z.array(tableCell).min(1).max(20)).min(2).max(201),
  })
  .refine(
    (table) =>
      table.rows.every((row) => row.length === table.rows[0].length) &&
      table.rows[0].every((cell) => cell.type === 'raw_text') &&
      table.rows.reduce(
        (total, row) => total + row.reduce((sum, cell) => sum + [...cell.text].length, 0),
        0,
      ) <= 20_000,
  );
const image = z.strictObject({
  type: z.literal('image'),
  image_url: https,
  alt_text: characters(2000),
  title: plain(150).optional(),
});
const section = z.strictObject({ type: z.literal('section'), text: plain(3000) });
const header = z.strictObject({ type: z.literal('header'), text: plain(150) });
const divider = z.strictObject({ type: z.literal('divider') });
const context = z.strictObject({
  type: z.literal('context'),
  elements: z.array(plain(2000)).min(1).max(10),
});
const code = z.strictObject({
  type: z.literal('rich_text'),
  elements: z
    .array(
      z.strictObject({
        type: z.literal('rich_text_preformatted'),
        elements: z
          .array(z.strictObject({ type: z.literal('text'), text: characters(3000) }))
          .length(1),
      }),
    )
    .length(1),
});
const carousel = z.strictObject({
  type: z.literal('carousel'),
  elements: z.array(card).min(1).max(10),
});
const stable = z.union([section, header, divider, context, image, code]);
const container = z.strictObject({
  type: z.literal('container'),
  title: plain(150),
  child_blocks: z.array(stable).min(1).max(10),
});
const leaf = z.union([stable, chart, dataTable, card, carousel]);
const layout = z
  .strictObject({
    type: z.literal('layout'),
    label: characters(150),
    is_label_visible: z.literal(true),
    rows: z
      .array(
        z.strictObject({
          items: z
            .array(z.strictObject({ block: z.union([leaf, container]) }))
            .min(1)
            .max(3),
        }),
      )
      .min(1)
      .max(5),
    fallback: z.array(stable).min(1).max(40),
  })
  .refine((block) =>
    block.rows.every(
      (row) =>
        row.items.length === 1 ||
        row.items.every(
          (item) => !['data_visualization', 'data_table', 'carousel'].includes(item.block.type),
        ),
    ),
  );
/** Only shapes emitted by this renderer can be replayed. No model-supplied callback IDs or views. */
export const richSlackBlockSchema = z
  .union([chart, dataTable, card, carousel, image, container, layout])
  .refine((block) => {
    const metrics = richMetrics(block);
    return metrics.charts <= 2 && metrics.tableCharacters <= 20_000 && richBlockCount(block) <= 38;
  });
export type RichSlackBlock = z.infer<typeof richSlackBlockSchema>;
type NativeBlock = z.infer<typeof leaf> | z.infer<typeof container> | z.infer<typeof layout>;

const link = z.strictObject({ label: characters(75), url: https });
const semanticCard = z.strictObject({
  type: z.literal('card'),
  title: characters(150),
  subtitle: characters(150).optional(),
  body: characters(200).optional(),
  image: z.strictObject({ url: https, alt: characters(2000) }).optional(),
  links: z.array(link).min(1).max(3).optional(),
});
const semanticText = z
  .strictObject({ type: z.enum(['text', 'header', 'context', 'code']), text: characters(3000) })
  .refine((block) => block.type !== 'header' || [...block.text].length <= 150)
  .refine((block) => block.type !== 'context' || [...block.text].length <= 2000);
const semanticImage = z.strictObject({
  type: z.literal('image'),
  url: https,
  alt: characters(2000),
  title: characters(150).optional(),
});
const semanticStable = z.union([semanticText, semanticImage, divider]);
const semanticChart = z.strictObject({
  type: z.literal('chart'),
  title: characters(50),
  chart: z.union([seriesChart, pieChart]),
});
const semanticTable = z
  .strictObject({
    type: z.literal('table'),
    title: characters(150),
    columns: z.array(characters(150)).min(1).max(20),
    rows: z
      .array(
        z
          .array(z.union([characters(3000), z.number().finite()]))
          .min(1)
          .max(20),
      )
      .min(1)
      .max(200),
  })
  .refine(
    (table) =>
      table.rows.every((row) => row.length === table.columns.length) &&
      [...table.columns.join('')].length +
        table.rows.reduce(
          (sum, row) => sum + row.reduce<number>((n, cell) => n + [...String(cell)].length, 0),
          0,
        ) <=
        20_000,
  );
const semanticCarousel = z.strictObject({
  type: z.literal('carousel'),
  cards: z.array(semanticCard).min(1).max(10),
});
const semanticContainer = z.strictObject({
  type: z.literal('container'),
  title: characters(150),
  blocks: z.array(semanticStable).min(1).max(10),
});
const semanticLeaf = z.union([
  semanticStable,
  semanticChart,
  semanticTable,
  semanticCard,
  semanticCarousel,
]);
const semanticLayout = z
  .strictObject({
    type: z.literal('layout'),
    title: characters(150),
    rows: z
      .array(
        z
          .array(z.union([semanticLeaf, semanticContainer]))
          .min(1)
          .max(3),
      )
      .min(1)
      .max(5),
  })
  .refine((block) =>
    block.rows.every(
      (row) =>
        row.length === 1 ||
        row.every((item) => !['chart', 'table', 'carousel'].includes(item.type)),
    ),
  );
export const channelPresentationSchema = z.strictObject({
  version: z.literal(1),
  blocks: z
    .array(z.union([semanticLeaf, semanticContainer, semanticLayout]))
    .min(1)
    .max(40),
});
export type Presentation = z.infer<typeof channelPresentationSchema>;
type Component = Presentation['blocks'][number];

const textObject = (value: string): z.infer<ReturnType<typeof plain>> => ({
  type: 'plain_text',
  text: value,
});
function stableBlock(block: z.infer<typeof semanticStable>): z.infer<typeof stable> {
  switch (block.type) {
    case 'text':
      return { type: 'section', text: textObject(block.text) };
    case 'header':
      return { type: 'header', text: textObject(block.text) };
    case 'context':
      return { type: 'context', elements: [textObject(block.text)] };
    case 'code':
      return {
        type: 'rich_text',
        elements: [
          { type: 'rich_text_preformatted', elements: [{ type: 'text', text: block.text }] },
        ],
      };
    case 'image':
      return {
        type: 'image',
        image_url: block.url,
        alt_text: block.alt,
        ...(block.title ? { title: textObject(block.title) } : {}),
      };
    case 'divider':
      return { type: 'divider' };
  }
}
function nativeCard(block: z.infer<typeof semanticCard>): z.infer<typeof card> {
  return {
    type: 'card',
    title: textObject(block.title),
    ...(block.subtitle ? { subtitle: textObject(block.subtitle) } : {}),
    ...(block.body ? { body: textObject(block.body) } : {}),
    ...(block.image
      ? {
          hero_image: {
            type: 'image',
            image_url: block.image.url,
            alt_text: block.image.alt,
          } as const,
        }
      : {}),
    ...(block.links
      ? {
          actions: block.links.map((item, index) => ({
            type: 'button' as const,
            text: textObject(item.label),
            url: item.url,
            action_id: `channel_presentation_link_${index}`,
          })),
        }
      : {}),
  };
}
function nativeBlock(
  block: Exclude<Component, { type: 'layout' }>,
): Exclude<NativeBlock, { type: 'layout' }>;
function nativeBlock(block: Component): NativeBlock;
function nativeBlock(block: Component): NativeBlock {
  switch (block.type) {
    case 'card':
      return nativeCard(block);
    case 'carousel':
      return { type: 'carousel', elements: block.cards.map(nativeCard) };
    case 'chart':
      return { type: 'data_visualization', title: block.title, chart: block.chart };
    case 'table':
      return {
        type: 'data_table',
        caption: block.title,
        rows: [
          block.columns.map((cell) => ({ type: 'raw_text' as const, text: cell })),
          ...block.rows.map((row) =>
            row.map((cell) =>
              typeof cell === 'number'
                ? { type: 'raw_number' as const, value: cell, text: String(cell) }
                : { type: 'raw_text' as const, text: cell },
            ),
          ),
        ],
      };
    case 'container':
      return {
        type: 'container',
        title: textObject(block.title),
        child_blocks: block.blocks.map(stableBlock),
      };
    case 'layout': {
      const fallback = fallbackBlocks(componentText(block));
      return {
        type: 'layout',
        label: block.title,
        is_label_visible: true,
        rows: block.rows.map((row) => ({
          items: row.map((item) => ({ block: nativeBlock(item) })),
        })),
        fallback,
      };
    }
    default:
      return stableBlock(block);
  }
}

/** Complete data and link targets also remain available to notifications, screen readers and old clients. */
export function componentText(block: Component): string {
  switch (block.type) {
    case 'divider':
      return '────────';
    case 'image':
      return [block.title, block.alt, block.url].filter(Boolean).join('\n');
    case 'card':
      return [
        block.title,
        block.subtitle,
        block.body,
        ...(block.image ? [block.image.alt, block.image.url] : []),
        ...(block.links ?? []).map((item) => `${item.label}: ${item.url}`),
      ]
        .filter(Boolean)
        .join('\n');
    case 'carousel':
      return block.cards.map(componentText).join('\n\n');
    case 'chart':
      return [
        block.title,
        ...(block.chart.type === 'pie'
          ? block.chart.segments.map((item) => `${item.label}: ${item.value}`)
          : [
              block.chart.axis_config.x_label,
              block.chart.axis_config.y_label,
              ...block.chart.series.map(
                (entry) =>
                  `${entry.name}: ${entry.data.map((item) => `${item.label}: ${item.value}`).join('; ')}`,
              ),
            ].filter(Boolean)),
      ].join('\n');
    case 'table':
      return [
        block.title,
        block.columns.join(' | '),
        ...block.rows.map((row) => row.join(' | ')),
      ].join('\n');
    case 'container':
      return [block.title, ...block.blocks.map(componentText)].join('\n\n');
    case 'layout':
      return [block.title, ...block.rows.flatMap((row) => row.map(componentText))].join('\n\n');
    default:
      return block.text;
  }
}
function fallbackBlocks(value: string): z.infer<typeof section>[] {
  const points = [...value];
  const blocks: z.infer<typeof section>[] = [];
  for (let index = 0; index < points.length; index += 3000)
    blocks.push({ type: 'section', text: textObject(points.slice(index, index + 3000).join('')) });
  return blocks;
}
export function presentComponent(block: Component): { block: NativeBlock; plain: string } {
  return { block: nativeBlock(block), plain: componentText(block) };
}

/** Count children and compatibility fallbacks too: nested blocks consume Slack's message budget. */
function richMetrics(block: NativeBlock): { charts: number; tableCharacters: number } {
  if (block.type === 'data_visualization') return { charts: 1, tableCharacters: 0 };
  if (block.type === 'data_table')
    return {
      charts: 0,
      tableCharacters: block.rows.reduce(
        (sum, row) => sum + row.reduce((n, cell) => n + [...cell.text].length, 0),
        0,
      ),
    };
  let children: NativeBlock[] = [];
  if (block.type === 'container') children = block.child_blocks;
  if (block.type === 'layout')
    children = block.rows.flatMap((row) => row.items.map((item) => item.block));
  return children.map(richMetrics).reduce(
    (sum, item) => ({
      charts: sum.charts + item.charts,
      tableCharacters: sum.tableCharacters + item.tableCharacters,
    }),
    { charts: 0, tableCharacters: 0 },
  );
}
export function richBlockCount(block: NativeBlock): number {
  if (block.type === 'container') return 1 + block.child_blocks.length;
  if (block.type === 'layout')
    return (
      1 +
      block.fallback.length +
      block.rows.reduce(
        (sum, row) => sum + row.items.reduce((n, item) => n + richBlockCount(item.block), 0),
        0,
      )
    );
  if (block.type === 'carousel') return 1 + block.elements.length;
  return 1;
}

/** An explicit final top-level fence is the only presentation entry point; quoted examples are ordinary text. */
export function parsePresentation(
  value: string,
): { text: string; presentation: Presentation } | undefined {
  // Bound work before parsing attacker/model-controlled JSON or building an AST.
  if (Buffer.byteLength(value) > 128_000 || !value.includes('```librechat-presentation'))
    return undefined;
  const document = fromMarkdown(value);
  const last = document.children.at(-1);
  if (
    last?.type !== 'code' ||
    last.lang !== 'librechat-presentation' ||
    last.meta ||
    !last.position ||
    document.children.filter(
      (node) => node.type === 'code' && node.lang === 'librechat-presentation',
    ).length !== 1 ||
    !/^```librechat-presentation\r?\n/.test(value.slice(last.position.start.offset)) ||
    !/\r?\n```\s*$/.test(value)
  )
    return undefined;
  try {
    const parsed = channelPresentationSchema.safeParse(JSON.parse(last.value));
    if (!parsed.success) return undefined;
    return {
      text: value.slice(0, last.position.start.offset).trimEnd(),
      presentation: parsed.data,
    };
  } catch {
    return undefined;
  }
}
