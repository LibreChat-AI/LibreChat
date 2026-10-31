import { z } from 'zod';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { channelStorageConfigSchema } from 'librechat-data-provider';
import type {
  ChannelArtifact,
  ChannelRunView,
  ChannelRunUsage,
  ChannelRunSummary,
  ChannelDeliveryPart,
  ChannelDeliveryPlan,
  ResponseAccounting,
} from 'librechat-data-provider';
import type { Nodes, Root, Definition } from 'mdast';

export const rendererVersion = 'slack-structured-v6';
export const presentationFormat = 'slack-blocks-v1';
export const artifactFailureNotice =
  'One or more attachments could not be confirmed. The answer is preserved; uncertain uploads will not be duplicated automatically.';
const chunkLimit = 39_000;
const presentationLimit = 64_000;
const supportedStructured = new Set([
  rendererVersion,
  'slack-structured-v5',
  'slack-structured-v4',
  'slack-structured-v3',
  'slack-structured-v2',
]);

function withinCharacters(value: string, limit: number): boolean {
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    if (++count > limit) {
      return false;
    }
    if ((value.codePointAt(index) ?? 0) > 0xffff) {
      index++;
    }
  }
  return true;
}

const boundedText = (limit: number, empty = false) =>
  z.string().refine((value) => (empty || value.length > 0) && withinCharacters(value, limit));
const text = <T extends string>(type: T, limit: number) =>
  z.strictObject({ type: z.literal(type), text: boundedText(limit) });
const feedbackButton = z.strictObject({
  text: text('plain_text', 75),
  value: z.enum(['+1', '-1']),
  accessibility_label: boundedText(75),
});
const blockSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('markdown'), text: boundedText(12_000) }),
  z.strictObject({
    type: z.literal('section'),
    text: z.union([text('mrkdwn', 3000), text('plain_text', 3000)]),
    expand: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal('header'), text: text('plain_text', 150) }),
  z.strictObject({ type: z.literal('divider') }),
  z.strictObject({ type: z.literal('context'), elements: z.array(text('mrkdwn', 3000)).length(1) }),
  z.strictObject({
    type: z.literal('rich_text'),
    elements: z
      .array(
        z.strictObject({
          type: z.literal('rich_text_preformatted'),
          elements: z.array(text('text', 3000)).length(1),
        }),
      )
      .length(1),
  }),
  z.strictObject({
    type: z.literal('table'),
    rows: z
      .array(
        z
          .array(z.strictObject({ type: z.literal('raw_text'), text: boundedText(3000, true) }))
          .min(1)
          .max(20),
      )
      .min(1)
      .max(20)
      .refine((rows) => rows.every((row) => row.length === rows[0].length)),
  }),
  z.strictObject({
    type: z.literal('context_actions'),
    elements: z
      .array(
        z.strictObject({
          type: z.literal('feedback_buttons'),
          action_id: z.literal('channel_feedback'),
          positive_button: feedbackButton.refine((button) => button.value === '+1'),
          negative_button: feedbackButton.refine((button) => button.value === '-1'),
        }),
      )
      .length(1),
  }),
]);
const blocksSchema = z.array(blockSchema).min(1).max(40);
export type SlackBlock = z.infer<typeof blockSchema>;
export interface SlackMessage {
  text: string;
  blocks?: SlackBlock[];
}

/** Semantic text is construction state, never part of a durable or SDK message. */
interface RenderedMessage extends SlackMessage {
  plain: string;
}

/** Every presentation path uses the same block and serialized-payload boundary. */
function presentationFor(message: SlackMessage): ChannelDeliveryPart['presentation'] {
  const blocks = blocksSchema.safeParse(message.blocks);
  if (!blocks.success) return undefined;
  const payload = JSON.stringify(blocks.data);
  if (Buffer.byteLength(payload) > presentationLimit) return undefined;
  return { format: presentationFormat, payload };
}

export function supportedRenderer(version: string): boolean {
  return version === 'slack-text-v1' || supportedStructured.has(version);
}

/** Legacy plans embedded session links in required footers; never replay that capability. */
function legacyMessage(text: string, blocks?: SlackBlock[]): SlackMessage {
  const footer = text.lastIndexOf('\n\n_This run · ID ');
  const fallback =
    footer < 0
      ? text
      : text.slice(0, footer) + text.slice(footer).replace(/\n<[^>\r\n]+\|View session>/g, '');
  return {
    text: fallback,
    ...(blocks
      ? {
          blocks: blocks.map((block) =>
            block.type === 'context'
              ? {
                  ...block,
                  elements: block.elements.map((element) => ({
                    ...element,
                    text: element.text.replace(/ · <[^>\r\n]+\|View session>/g, ''),
                  })),
                }
              : block,
          ),
        }
      : {}),
  };
}

export function durableSlackMessage(part: ChannelDeliveryPart, renderer: string): SlackMessage {
  const preserve =
    renderer === rendererVersion || renderer === 'slack-structured-v5' || !!part.traceUrl;
  if (!part.presentation) {
    return preserve ? { text: part.text } : legacyMessage(part.text);
  }
  if (
    !supportedStructured.has(renderer) ||
    part.presentation.format !== presentationFormat ||
    Buffer.byteLength(part.presentation.payload) > presentationLimit
  ) {
    throw new Error('Unsupported durable presentation');
  }
  try {
    const blocks = blocksSchema.parse(JSON.parse(part.presentation.payload));
    return preserve ? { text: part.text, blocks } : legacyMessage(part.text, blocks);
  } catch {
    throw new Error('Invalid persisted Slack blocks');
  }
}

export function escapeSlackText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function displayUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !/[<>|\s]/.test(raw)
    );
  } catch {
    return false;
  }
}

interface InlineDocument {
  text: string;
  plain: string;
  spans: { start: number; end: number }[];
  replacements: { start: number; end: number; plain: string }[];
}

interface MarkdownDocument {
  source: string;
  root: Root;
  definitions: Map<string, Definition>;
}

function bounds(node: Nodes): [number, number] {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) throw new Error('Missing Markdown position');
  return [start, end];
}

function parseMarkdown(source: string): MarkdownDocument {
  const root = fromMarkdown(source, {
    // Slack renders no HTML; keep HTML-looking mentions as text, not opaque HTML blocks.
    extensions: [gfm(), { disable: { null: ['htmlFlow', 'htmlText'] } }],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const definitions = new Map<string, Definition>();
  const pending: Nodes[] = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'definition' && !definitions.has(node.identifier))
      definitions.set(node.identifier, node);
    if ('children' in node)
      for (let index = node.children.length - 1; index >= 0; index--)
        pending.push(node.children[index]);
  }
  return { source, root, definitions };
}

function labelText(node: Nodes): string {
  let text = '';
  const pending: Nodes[] = [node];
  while (pending.length) {
    const child = pending.pop()!;
    if ('children' in child) {
      for (let index = child.children.length - 1; index >= 0; index--)
        pending.push(child.children[index]);
    } else if ('value' in child) text += child.value;
    else if ('alt' in child) text += child.alt ?? '';
    else if (child.type === 'break') text += '\n';
  }
  return text;
}

/** Parse once; the AST owns grammar and emitted links/code never reenter a formatter. */
function inlineDocument(document: MarkdownDocument, initial: Nodes, wire = true): InlineDocument {
  const output: InlineDocument = { text: '', plain: '', spans: [], replacements: [] };
  type Task =
    | { node: Nodes }
    | { text: string; plain: string; atomic?: boolean }
    | { end: { start: number; end: number } };
  const pending: Task[] = [{ node: initial }];
  const raw = (node: Nodes) => document.source.slice(...bounds(node));
  const literal = (value: string): Task => ({
    text: wire ? escapeSlackText(value) : value,
    plain: value,
  });
  while (pending.length) {
    const task = pending.pop()!;
    if ('end' in task) {
      task.end.end = output.text.length;
      continue;
    }
    if ('text' in task) {
      const start = output.text.length;
      output.text += task.text;
      output.plain += task.plain;
      const end = output.text.length;
      if (task.atomic) output.spans.push({ start, end });
      if (task.plain !== decodeSlackText(task.text))
        output.replacements.push({ start, end, plain: task.plain });
      continue;
    }
    const node = task.node;
    if (
      node.type === 'link' ||
      node.type === 'image' ||
      node.type === 'linkReference' ||
      node.type === 'imageReference'
    ) {
      const target = 'url' in node ? node : document.definitions.get(node.identifier);
      const label = labelText(node);
      const url = target?.url;
      if (url && displayUrl(url)) {
        pending.push({
          text: wire
            ? '<' +
              escapeSlackText(url) +
              (label === url ? '' : '|' + escapeSlackText(label || url)) +
              '>'
            : raw(node),
          plain: label && label !== url ? label + ' (' + url + ')' : url,
          atomic: true,
        });
      } else {
        // An unsafe autolink's label can itself contain credentials.
        pending.push(literal(url && label === url ? 'Link unavailable' : label));
      }
      continue;
    }
    if (node.type === 'definition') {
      if (!wire && displayUrl(node.url)) pending.push(literal(raw(node)));
      continue;
    }
    if (node.type === 'code' || node.type === 'inlineCode') {
      pending.push({
        text: wire ? escapeSlackText(raw(node)) : raw(node),
        plain: node.value,
        atomic: true,
      });
      continue;
    }
    if (node.type === 'text') {
      pending.push(wire ? literal(node.value) : literal(raw(node)));
      continue;
    }
    if (!('children' in node)) {
      pending.push(literal(node.type === 'break' && wire ? '\n' : raw(node)));
      continue;
    }
    const style = wire
      ? (
          { strong: '*', emphasis: '_', delete: '~', heading: '*' } as Partial<
            Record<Nodes['type'], string>
          >
        )[node.type]
      : undefined;
    const children = node.children;
    const [start, end] = bounds(node);
    const tasks: Task[] = [];
    if (style) tasks.push({ text: style, plain: '' });
    let cursor = style && children.length ? bounds(children[0])[0] : start;
    for (const child of children) {
      const [childStart, childEnd] = bounds(child);
      if (cursor < childStart) tasks.push(literal(document.source.slice(cursor, childStart)));
      tasks.push({ node: child });
      cursor = childEnd;
    }
    if (!style && cursor < end) tasks.push(literal(document.source.slice(cursor, end)));
    if (style) {
      const span = { start: output.text.length, end: 0 };
      output.spans.push(span);
      tasks.push({ text: style, plain: '' }, { end: span });
    }
    for (let index = tasks.length - 1; index >= 0; index--) pending.push(tasks[index]);
  }
  return output;
}

function decodeSlackText(value: string): string {
  return value.replace(/&(amp|lt|gt);/g, (_match, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    return '>';
  });
}

function plainSlice(document: InlineDocument, start: number, end: number): string {
  let plain = '';
  let cursor = start;
  for (const replacement of document.replacements) {
    if (replacement.end <= start) continue;
    if (replacement.start >= end) break;
    plain += decodeSlackText(document.text.slice(cursor, replacement.start)) + replacement.plain;
    cursor = replacement.end;
  }
  return plain + decodeSlackText(document.text.slice(cursor, end));
}

export function safeMrkdwn(value: string): string {
  const document = parseMarkdown(value);
  return inlineDocument(document, document.root).text;
}

/** Byte limits are stricter than Slack's character limits and never split a code point. */
export function chunkText(value: string, limit: number): string[] {
  if (!Number.isInteger(limit) || limit < 4) {
    throw new Error('Invalid chunk limit');
  }
  const chunks: string[] = [];
  let remaining = Buffer.from(value);
  while (remaining.length > limit) {
    let boundary = remaining.subarray(0, limit + 1).lastIndexOf(10);
    if (boundary <= 0) {
      boundary = limit;
      while ((remaining[boundary] & 0xc0) === 0x80) {
        boundary--;
      }
    }
    chunks.push(remaining.subarray(0, boundary).toString());
    remaining = remaining.subarray(boundary + (remaining[boundary] === 10 ? 1 : 0));
  }
  if (remaining.length || !chunks.length) {
    chunks.push(remaining.toString());
  }
  return chunks;
}

/** Recognize wire-format atoms before enforcing Slack's per-section byte limit. */
function mrkdwnChunks(document: InlineDocument, limit: number): string[] | null {
  const value = document.text;
  const protectedEnds = new Map(document.spans.map((span) => [span.start, span.end]));
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  let cursor = 0;
  const addText = (text: string) => {
    for (const character of text) {
      const size = Buffer.byteLength(character);
      if (bytes + size > limit) {
        chunks.push(chunk);
        chunk = '';
        bytes = 0;
      }
      chunk += character;
      bytes += size;
    }
  };
  for (let index = 0; index < value.length; ) {
    let end = protectedEnds.get(index);
    if (end === undefined && value[index] === '&') {
      if (value.startsWith('&amp;', index)) end = index + 5;
      else if (value.startsWith('&lt;', index) || value.startsWith('&gt;', index)) end = index + 4;
    }
    if (end === undefined) {
      index++;
      continue;
    }
    const atom = value.slice(index, end);
    const size = Buffer.byteLength(atom);
    if (size > limit) return null;
    addText(value.slice(cursor, index));
    if (bytes + size > limit) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += atom;
    bytes += size;
    cursor = end;
    index = end;
  }
  addText(value.slice(cursor));
  if (chunk || !chunks.length) chunks.push(chunk);
  return chunks;
}

/** Escape before packing so entity expansion also obeys the wire byte budget. */
function plainChunks(value: string, limit: number): string[] {
  return (
    mrkdwnChunks(
      { text: escapeSlackText(value), plain: value, spans: [], replacements: [] },
      limit,
    ) ?? []
  ).map(decodeSlackText);
}

function plainMessage(value: string): RenderedMessage {
  return {
    text: escapeSlackText(value),
    plain: value,
    blocks: plainChunks(value, 2800).map((chunk) => ({
      type: 'section',
      text: { type: 'plain_text', text: chunk },
    })),
  };
}

export function renderSlackDocument(markdown: string): RenderedMessage[] {
  const document = parseMarkdown(markdown);
  const parts: RenderedMessage[] = [];
  let current: RenderedMessage = { text: '', plain: '', blocks: [] };
  const flush = () => {
    if (current.text || current.blocks?.length) {
      parts.push(current);
      current = { text: '', plain: '', blocks: [] };
    }
  };
  const add = (fallback: string, block: SlackBlock, plain: string) => {
    if (
      (current.blocks?.length ?? 0) >= 40 ||
      Buffer.byteLength(current.text + fallback) + 2 > chunkLimit
    )
      flush();
    const separator = current.text ? '\n\n' : '';
    current.text += separator + fallback;
    current.plain += separator + plain;
    current.blocks?.push(block);
  };
  const prose = (node: Nodes) => {
    const inline = inlineDocument(document, node);
    const formatted = mrkdwnChunks(inline, 2800);
    if (!formatted) {
      for (const chunk of plainChunks(inline.plain, 2800)) {
        if (chunk.trim())
          add(
            escapeSlackText(chunk),
            {
              type: 'section',
              text: { type: 'plain_text', text: chunk },
            },
            chunk,
          );
      }
      return;
    }
    let offset = 0;
    for (const chunk of formatted) {
      if (chunk.trim())
        add(
          chunk,
          {
            type: 'section',
            text: { type: 'mrkdwn', text: chunk },
            expand: true,
          },
          plainSlice(inline, offset, offset + chunk.length),
        );
      offset += chunk.length;
    }
  };
  for (const node of document.root.children) {
    if (node.type === 'definition') continue;
    if (node.type === 'code') {
      for (const chunk of plainChunks(node.value, 2700)) {
        if (!chunk)
          add(
            '```\n\n```',
            {
              type: 'section',
              text: { type: 'mrkdwn', text: '```\n\n```' },
            },
            '',
          );
        else
          add(
            '```\n' + escapeSlackText(chunk) + '\n```',
            {
              type: 'rich_text',
              elements: [
                { type: 'rich_text_preformatted', elements: [{ type: 'text', text: chunk }] },
              ],
            },
            chunk,
          );
      }
      continue;
    }
    if (node.type === 'table') {
      const rows = node.children.map((row) =>
        row.children.map((cell) => ({
          type: 'raw_text',
          text: inlineDocument(document, cell).plain,
        })),
      );
      const inline = inlineDocument(document, node);
      const block = blockSchema.safeParse({ type: 'table', rows });
      if (block.success && Buffer.byteLength(inline.text) <= 2800) {
        flush();
        add(inline.text, block.data, inline.plain);
        flush();
      } else prose(node);
      continue;
    }
    if (node.type === 'thematicBreak') {
      add('────────', { type: 'divider' }, '────────');
      continue;
    }
    if (node.type === 'heading') {
      const inline = inlineDocument(document, node);
      if (
        inline.plain &&
        withinCharacters(inline.plain, 150) &&
        Buffer.byteLength(inline.text) <= 2800
      ) {
        add(
          inline.text,
          { type: 'header', text: { type: 'plain_text', text: inline.plain } },
          inline.plain,
        );
        continue;
      }
    }
    prose(node);
  }
  flush();
  return parts.length
    ? parts
    : [
        {
          text: '_(the agent returned an empty reply)_',
          plain: '(the agent returned an empty reply)',
        },
      ];
}

export function renderAgentAnswer(value: string): RenderedMessage[] {
  if (!value.trim() || !withinCharacters(value, 12_000) || /<[@!#]/.test(value)) {
    return renderSlackDocument(value);
  }
  const document = parseMarkdown(value);
  const fallback = inlineDocument(document, document.root);
  if (Buffer.byteLength(fallback.text) > chunkLimit) return renderSlackDocument(value);
  const native = inlineDocument(document, document.root, false).text;
  if (!withinCharacters(native, 12000)) return renderSlackDocument(value);
  return [
    { text: fallback.text, plain: fallback.plain, blocks: [{ type: 'markdown', text: native }] },
  ];
}

const decimal = /^(0|[1-9][0-9]{0,63})(\.[0-9]{1,18})?$/;
const model = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const validAmount = (value?: string): value is string =>
  typeof value === 'string' && value.length <= 64 && decimal.test(value);
const validBasis = (basis?: string): boolean =>
  basis === 'application_billing' || basis === 'provider_reported';

export function accountingPriceDescription(accounting?: ResponseAccounting): string {
  if (
    accounting?.status === 'available' &&
    accounting.currency === 'USD' &&
    accounting.coverage === 'complete' &&
    accounting.reason === 'priced' &&
    validAmount(accounting.amount) &&
    validBasis(accounting.basis)
  ) {
    return `$${accounting.amount} USD (${accounting.basis?.replaceAll('_', ' ')})`;
  }
  return 'Cost unavailable';
}

function accountingDescription(accounting?: ResponseAccounting): string {
  const labels = new Set<string>();
  for (const call of accounting?.calls ?? []) {
    if (
      !['provider_reported', 'runtime_reported'].includes(call.modelSource) ||
      !call.model ||
      !model.test(call.model)
    ) {
      continue;
    }
    labels.add(
      (call.provider && model.test(call.provider) ? call.provider + '/' : '') + call.model,
    );
    if (labels.size === 4) {
      break;
    }
  }
  return (
    accountingPriceDescription(accounting) + (labels.size ? ' · ' + [...labels].join(', ') : '')
  );
}

function validUsage(
  usage?: Pick<ChannelRunUsage, 'inputTokens' | 'outputTokens' | 'totalTokens'>,
): boolean {
  return (
    !!usage &&
    [usage.inputTokens, usage.outputTokens, usage.totalTokens].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) &&
    usage.totalTokens - usage.inputTokens === usage.outputTokens
  );
}

function validSummary(
  summary: ChannelRunSummary | undefined,
  sequence: number,
): summary is ChannelRunSummary {
  return (
    !!summary &&
    summary.version === 1 &&
    summary.scope === 'actor_lane' &&
    summary.includesCurrent &&
    Number.isSafeInteger(sequence) &&
    sequence > 0 &&
    summary.throughSequence === sequence &&
    summary.expectedRuns === sequence &&
    summary.priorRuns >= 0 &&
    summary.observedRuns > 0 &&
    summary.observedRuns <= sequence &&
    Number.isSafeInteger(summary.observedRuns) &&
    summary.observedRuns - 1 === summary.priorRuns
  );
}

function validCoverage(coverage: string, covered: number, summary: ChannelRunSummary): boolean {
  return (
    Number.isSafeInteger(covered) &&
    covered >= 0 &&
    covered <= summary.observedRuns &&
    ((coverage === 'complete' && covered === summary.expectedRuns) ||
      (coverage === 'partial' && covered > 0 && covered < summary.expectedRuns) ||
      (coverage === 'unavailable' && covered === 0))
  );
}

export function safeSummarySessionURL(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return (
      raw.length <= 2048 &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/[<>|\s]/.test(raw) &&
      !!host &&
      !isIP(host.replace(/^\[|\]$/g, '')) &&
      host.includes('.') &&
      !/\.(localhost|local|localdomain|internal|lan|home|test|invalid|example)$/.test(host)
    );
  } catch {
    return false;
  }
}

function shortRunId(id: string): string {
  return model.test(id) && !/[/:]/.test(id)
    ? id.slice(0, 8)
    : createHash('sha256').update(id).digest('hex').slice(0, 8);
}

function threadDetails(run: ChannelRunView): string[] {
  const summary = run.snapshot?.summary;
  if (!validSummary(summary, run.sequence)) {
    return ['Your thread: totals unavailable'];
  }
  const parts = [`Your thread · ${summary.expectedRuns} runs`];
  const cost = summary.costUSD;
  let price = 'cost unavailable';
  if (validCoverage(cost.coverage, cost.coveredRuns, summary) && validBasis(cost.basis)) {
    if (cost.coverage === 'complete' && validAmount(cost.value)) {
      price = `$${cost.value} USD (${cost.basis?.replaceAll('_', ' ')})`;
    } else if (cost.coverage === 'partial' && validAmount(cost.knownValue)) {
      price = `known $${cost.knownValue} USD (${cost.basis?.replaceAll('_', ' ')}; partial ${cost.coveredRuns}/${summary.expectedRuns} runs)`;
    }
  }
  parts.push(price);
  const elapsed = summary.elapsedMs;
  if (
    validCoverage(elapsed.coverage, elapsed.coveredRuns, summary) &&
    elapsed.coverage === 'complete' &&
    Number.isFinite(elapsed.value) &&
    (elapsed.value ?? -1) >= 0
  ) {
    parts.push(`${((elapsed.value ?? 0) / 1000).toFixed(1)}s processing`);
  } else if (
    validCoverage(elapsed.coverage, elapsed.coveredRuns, summary) &&
    elapsed.coverage === 'partial' &&
    Number.isFinite(elapsed.knownValue) &&
    (elapsed.knownValue ?? -1) >= 0
  ) {
    parts.push(
      `known ${((elapsed.knownValue ?? 0) / 1000).toFixed(1)}s processing (partial ${elapsed.coveredRuns}/${summary.expectedRuns})`,
    );
  } else {
    parts.push('time unavailable');
  }
  const tokens = summary.tokens;
  if (
    validCoverage(tokens.coverage, tokens.coveredRuns, summary) &&
    tokens.coverage === 'complete' &&
    validUsage(tokens.value)
  ) {
    parts.push(`${tokens.value?.totalTokens} tokens`);
  } else if (
    validCoverage(tokens.coverage, tokens.coveredRuns, summary) &&
    tokens.coverage === 'partial' &&
    validUsage(tokens.knownValue)
  ) {
    parts.push(
      `known ${tokens.knownValue?.totalTokens} tokens (partial ${tokens.coveredRuns}/${summary.expectedRuns})`,
    );
  } else {
    parts.push('tokens unavailable');
  }
  return parts;
}

function appendFooter(parts: RenderedMessage[], run: ChannelRunView): void {
  const snapshot = run.snapshot;
  if (!snapshot) {
    throw new Error('Missing run snapshot');
  }
  const id = shortRunId(run.runId);
  const elapsed =
    Number.isFinite(snapshot.elapsedMs) && snapshot.elapsedMs > 0
      ? `${(snapshot.elapsedMs / 1000).toFixed(1)}s`
      : '';
  const labels = [accountingPriceDescription(snapshot.accounting), elapsed, 'Run ' + id].filter(
    Boolean,
  );
  const summary = snapshot.summary;
  let line = labels.join(' · ');
  const details = threadDetails(run);
  if (!validSummary(summary, run.sequence) || summary.expectedRuns > 1) {
    line += '\n' + details.slice(0, 2).join(' · ');
  }
  const usage =
    validUsage(snapshot.usage) && snapshot.usage
      ? ` · ${snapshot.usage.totalTokens} tokens (${snapshot.usage.inputTokens} in / ${snapshot.usage.outputTokens} out)`
      : '';
  const fallback = safeMrkdwn(
    `\n\n_This run · ID ${id}${elapsed ? ' · ' + elapsed : ''}${usage}_\n_This run: ${accountingDescription(snapshot.accounting)}_\n_${details.join(' · ')}_`,
  );
  let last = parts[parts.length - 1];
  if (
    !last ||
    (last.blocks?.length ?? 0) >= 40 ||
    Buffer.byteLength(last.text + fallback) > chunkLimit
  ) {
    last = { text: '', plain: '', blocks: [] };
    parts.push(last);
  }
  const footer = parseMarkdown(fallback);
  last.plain =
    (last.plain ?? decodeSlackText(last.text)) + inlineDocument(footer, footer.root).plain;
  last.text += fallback;
  (last.blocks ??= []).push({ type: 'context', elements: [{ type: 'mrkdwn', text: line }] });
}

function appendFeedback(parts: RenderedMessage[]): void {
  let last = parts[parts.length - 1];
  if (!last || (last.blocks?.length ?? 0) >= 40) {
    last = { text: 'Answer feedback', plain: 'Answer feedback', blocks: [] };
    parts.push(last);
  }
  (last.blocks ??= []).push({
    type: 'context_actions',
    elements: [
      {
        type: 'feedback_buttons',
        action_id: 'channel_feedback',
        positive_button: {
          text: { type: 'plain_text', text: 'Helpful' },
          value: '+1',
          accessibility_label: 'Mark this answer helpful',
        },
        negative_button: {
          text: { type: 'plain_text', text: 'Not helpful' },
          value: '-1',
          accessibility_label: 'Mark this answer not helpful',
        },
      },
    ],
  });
}

export function validArtifact(artifact: ChannelArtifact): boolean {
  return (
    artifact.artifactId.length > 0 &&
    Buffer.byteLength(artifact.artifactId) <= 512 &&
    artifact.filename.length > 0 &&
    Buffer.byteLength(artifact.filename) <= 720 &&
    !artifact.filename.includes('/') &&
    !/[\\\p{Cc}\p{Cf}]/u.test(artifact.filename) &&
    Number.isSafeInteger(artifact.bytes) &&
    artifact.bytes >= 0 &&
    artifact.bytes <= 50 * 1024 * 1024 &&
    /^[a-f0-9]{64}$/.test(artifact.sha256)
  );
}

export function makeSlackPlan(
  run: ChannelRunView,
  native = false,
  maxDeliveryParts = channelStorageConfigSchema.shape.maxDeliveryParts.parse(undefined),
): ChannelDeliveryPlan {
  const budget = channelStorageConfigSchema.shape.maxDeliveryParts.parse(maxDeliveryParts);
  if (run.plan) {
    throw new Error('Existing delivery plans must not be regenerated');
  }
  const snapshot = run.snapshot;
  if (!snapshot || !['completed', 'failed', 'cancelled'].includes(snapshot.status)) {
    throw new Error('Missing terminal snapshot');
  }
  if (snapshot.status === 'completed' && !snapshot.responseId) {
    throw new Error('Completed snapshot has no response cursor');
  }
  const empty = snapshot.status === 'completed' && !snapshot.text.trim();
  let answer = snapshot.text;
  if (snapshot.status === 'failed') {
    answer =
      'Sorry — something went wrong while talking to the agent. Please try again in a moment.';
  } else if (snapshot.status === 'cancelled') {
    answer = 'This request was cancelled.';
  }
  if (empty) {
    answer =
      'The Agent finished without a text reply.' +
      (snapshot.artifacts?.length
        ? ' Attachments are subject to this channel’s delivery limits.'
        : '');
  }
  if (snapshot.artifactsUnavailable) {
    answer += '\n\nAttachments are unavailable. The answer is preserved.';
  }
  let messages = native ? renderAgentAnswer(answer) : renderSlackDocument(answer);
  appendFooter(messages, run);
  if (native && snapshot.status === 'completed' && !empty) {
    appendFeedback(messages);
  }
  if (messages.length > budget) {
    const notice =
      '\n\nReply shortened to fit this channel’s delivery limit. The full answer remains in the saved execution.';
    const plain = plainChunks(
      messages.map((message) => message.plain).join('\n\n'),
      chunkLimit - Buffer.byteLength(notice),
    );
    const selected = plain.slice(0, budget);
    if (plain.length > budget) selected[selected.length - 1] += notice;
    messages = selected.map(plainMessage);
  }
  if (!messages.length || messages.length > 64) {
    throw new Error('Durable answer exceeds part budget');
  }
  const parts: ChannelDeliveryPart[] = messages.map((message, index) => {
    const presentation = presentationFor(message);
    return {
      operationId: `${run.runId}:reply:${index}`,
      kind: 'message',
      required: true,
      text: message.text,
      ...(presentation ? { presentation } : {}),
    };
  });
  const summary = snapshot.summary;
  const traceUrl = validSummary(summary, run.sequence) && summary.session?.url;
  if (traceUrl && safeSummarySessionURL(traceUrl)) {
    parts.push({
      operationId: `${run.runId}:trace:0`,
      kind: 'message',
      required: false,
      text: safeMrkdwn(`[View session](${traceUrl})`),
      traceUrl,
    });
  }
  const seen = new Set<string>();
  let invalid = false;
  if (snapshot.status === 'completed') {
    for (const [index, artifact] of (snapshot.artifacts ?? []).entries()) {
      if (index >= 20 || !validArtifact(artifact) || seen.has(artifact.artifactId)) {
        invalid = true;
        continue;
      }
      seen.add(artifact.artifactId);
      parts.push({
        operationId: `${run.runId}:artifact:${index}`,
        kind: 'artifact',
        required: false,
        artifactId: artifact.artifactId,
        text: artifact.filename,
      });
    }
  }
  if (seen.size) {
    parts.push({
      operationId: `${run.runId}:artifact-status`,
      kind: 'message',
      required: false,
      text: artifactFailureNotice,
    });
  }
  if (invalid) {
    parts.push({
      operationId: `${run.runId}:artifact-unavailable`,
      kind: 'message',
      required: false,
      text: 'One or more attachments are unavailable. The answer is preserved.',
    });
  }
  if (parts.length > budget) {
    const required = parts.filter((part) => part.required);
    const remaining = budget - required.length;
    // Artifact delivery and its failure notice form a group. Never publish uploads without it.
    const optional = parts.filter(
      (part) =>
        !part.required &&
        part.kind !== 'artifact' &&
        !part.operationId.endsWith(':artifact-status'),
    );
    const artifacts = parts.filter((part) => part.kind === 'artifact');
    const status = parts.find((part) => part.operationId.endsWith(':artifact-status'));
    const selected = remaining >= 2 && status ? [...artifacts.slice(0, remaining - 1), status] : [];
    selected.push(...optional.slice(0, remaining - selected.length));
    parts.splice(0, parts.length, ...required, ...selected);
    const last = required[required.length - 1];
    const notice =
      '\n\nSome attachments or session links were omitted by this channel’s delivery limit.';
    last.text += notice;
    const message = durableSlackMessage(last, rendererVersion);
    const blocks = message.blocks && [
      ...message.blocks,
      {
        type: 'section' as const,
        text: { type: 'plain_text' as const, text: notice.trim() },
      },
    ];
    // Preserve formatting when it fits; fallback obeys the same block and payload boundary.
    last.presentation =
      presentationFor({ text: last.text, blocks }) ??
      presentationFor(plainMessage(messages[required.length - 1].plain + notice));
  }
  const plan = { revision: '', rendererVersion, parts };
  plan.revision = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  return plan;
}
