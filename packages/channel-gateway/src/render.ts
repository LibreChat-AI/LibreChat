import { z } from 'zod';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
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

/** Recognize literal spans before any prose transformation, including unfinished fences. */
function transformProse(
  value: string,
  prose: (text: string) => string,
  code = (text: string) => text,
): string {
  const starts = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)|`+/gm;
  let cursor = 0;
  let result = '';
  let start: RegExpExecArray | null;
  while ((start = starts.exec(value))) {
    const marker = start[1];
    let end = -1;
    if (marker) {
      const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \t]*(?:\n|$)`, 'gm');
      closing.lastIndex = starts.lastIndex;
      const match = closing.exec(value);
      end = match ? closing.lastIndex : value.length;
    } else {
      const closing = /`+/g;
      closing.lastIndex = starts.lastIndex;
      let match: RegExpExecArray | null;
      while ((match = closing.exec(value))) {
        if (match[0].length === start[0].length) {
          end = closing.lastIndex;
          break;
        }
      }
    }
    if (end < 0) continue;
    result += prose(value.slice(cursor, start.index)) + code(value.slice(start.index, end));
    cursor = end;
    starts.lastIndex = end;
  }
  return result + prose(value.slice(cursor));
}

/** A single scanner handles nested and escaped URL parentheses in both Slack formats. */
function proseLinks(value: string, slack: boolean): string {
  const starts = /\[([^\][\n]+)\]\(/g;
  let result = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  const escape = slack ? escapeSlackText : (text: string) => text;
  while ((match = starts.exec(value))) {
    let depth = 1;
    let end = starts.lastIndex;
    let url = '';
    for (; end < value.length; end++) {
      let char = value[end];
      if (char === '\\' && /[()\\]/.test(value[end + 1] ?? '')) {
        char = value[++end];
        url += char;
        continue;
      }
      if (/\s/.test(char)) break;
      if (char === '(') depth++;
      if (char === ')' && --depth === 0) break;
      url += char;
    }
    if (depth !== 0) {
      starts.lastIndex = end;
      continue;
    }
    result += escape(value.slice(cursor, match.index));
    const label = match[1];
    if (!displayUrl(url)) result += escape(label);
    else if (slack) result += `<${escapeSlackText(url)}|${escapeSlackText(label)}>`;
    else result += value.slice(match.index, end + 1);
    cursor = end + 1;
    starts.lastIndex = cursor;
  }
  return result + escape(value.slice(cursor));
}

function sanitizedLinks(value: string): string {
  return transformProse(value, (prose) => proseLinks(prose, false));
}

export function safeMrkdwn(value: string): string {
  return transformProse(
    value,
    (prose) =>
      proseLinks(prose, true)
        .replace(/\*\*([^*]+)\*\*/g, '*$1*')
        .replace(/__([^_]+)__/g, '*$1*')
        .replace(/^#{1,6}\s+(.+)$/gm, '*$1*'),
    escapeSlackText,
  );
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
function mrkdwnChunks(value: string, limit: number): string[] | null {
  const atoms = /<[^<>\n]+>|&(?:amp|lt|gt);|`+|[*_~]/g;
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
  let match: RegExpExecArray | null;
  while ((match = atoms.exec(value))) {
    let atom = match[0];
    let end = atoms.lastIndex;
    if (/^[`*_~]/.test(atom)) {
      // A bounded search avoids rescanning an unbounded sequence of unmatched delimiters.
      const window = value.slice(end, end + limit + 1);
      if (atom[0] === '`') {
        const closing = /`+/g;
        closing.lastIndex = end;
        let run: RegExpExecArray | null;
        let found = false;
        while ((run = closing.exec(value))) {
          if (run.index - match.index > limit) return null;
          if (run[0].length === atom.length) {
            end = closing.lastIndex;
            found = true;
            break;
          }
        }
        if (!found) return null;
      } else {
        const close = window.indexOf(atom);
        if (close < 0) {
          if (value.indexOf(atom, end) >= 0) return null;
          continue;
        }
        end += close + atom.length;
      }
      atom = value.slice(match.index, end);
    }
    const size = Buffer.byteLength(atom);
    if (size > limit) return null;
    addText(value.slice(cursor, match.index));
    if (bytes + size > limit) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += atom;
    bytes += size;
    cursor = end;
    atoms.lastIndex = end;
  }
  addText(value.slice(cursor));
  if (chunk || !chunks.length) chunks.push(chunk);
  return chunks;
}

function plainMessage(value: string): SlackMessage {
  return {
    text: value,
    blocks: chunkText(
      value.replace(/&(amp|lt|gt);/g, (_match, entity: string) => {
        if (entity === 'amp') return '&';
        if (entity === 'lt') return '<';
        return '>';
      }),
      2800,
    ).map((chunk) => ({
      type: 'section',
      text: { type: 'plain_text', text: chunk },
    })),
  };
}

function tableRow(line: string): { type: 'raw_text'; text: string }[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => ({
      type: 'raw_text',
      text: cell.trim(),
    }));
}

function tableDivider(line: string): boolean {
  return line.includes('|') && tableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell.text));
}

export function renderSlackDocument(markdown: string): SlackMessage[] {
  const parts: SlackMessage[] = [];
  let current: SlackMessage = { text: '', blocks: [] };
  const flush = () => {
    if (current.text || current.blocks?.length) {
      parts.push(current);
      current = { text: '', blocks: [] };
    }
  };
  const add = (fallback: string, block: SlackBlock) => {
    if (
      (current.blocks?.length ?? 0) >= 40 ||
      Buffer.byteLength(current.text + fallback) + 2 > chunkLimit
    ) {
      flush();
    }
    current.text += (current.text ? '\n\n' : '') + fallback;
    current.blocks?.push(block);
  };
  const prose = (value: string) => {
    const formatted = mrkdwnChunks(safeMrkdwn(value), 2800);
    if (!formatted) {
      for (const chunk of chunkText(value, 2800)) {
        if (chunk.trim())
          add(escapeSlackText(chunk), {
            type: 'section',
            text: { type: 'plain_text', text: chunk },
          });
      }
      return;
    }
    for (const chunk of formatted) {
      if (chunk.trim())
        add(chunk, { type: 'section', text: { type: 'mrkdwn', text: chunk }, expand: true });
    }
  };
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  for (let index = 0; index < lines.length; ) {
    const line = lines[index];
    const trimmed = line.trim();
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[0];
    if (marker) {
      const closing = new RegExp(`^${marker[0]}{${marker.length},}[ \t]*$`);
      const code: string[] = [];
      index++;
      while (index < lines.length && !closing.test(lines[index].trim())) {
        code.push(lines[index++]);
      }
      if (index < lines.length) {
        index++;
      }
      for (const chunk of chunkText(code.join('\n'), 2700)) {
        if (!chunk) {
          add('```\n\n```', { type: 'section', text: { type: 'mrkdwn', text: '```\n\n```' } });
        } else {
          add('```\n' + escapeSlackText(chunk) + '\n```', {
            type: 'rich_text',
            elements: [
              { type: 'rich_text_preformatted', elements: [{ type: 'text', text: chunk }] },
            ],
          });
        }
      }
      continue;
    }
    if (index + 1 < lines.length && line.includes('|') && tableDivider(lines[index + 1])) {
      const start = index;
      const rows = [tableRow(line)];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(tableRow(lines[index++]));
      }
      const fallback = safeMrkdwn(lines.slice(start, index).join('\n'));
      const block = blockSchema.safeParse({ type: 'table', rows });
      if (block.success && Buffer.byteLength(fallback) <= 2800) {
        flush();
        add(fallback, block.data);
        flush();
      } else {
        prose(lines.slice(start, index).join('\n'));
      }
      continue;
    }
    if (trimmed === '---' || trimmed === '***') {
      add('────────', { type: 'divider' });
      index++;
      continue;
    }
    const heading = /^#+\s+(.+)$/.exec(trimmed)?.[1];
    if (heading && heading.length <= 150) {
      add('*' + escapeSlackText(heading) + '*', {
        type: 'header',
        text: { type: 'plain_text', text: heading },
      });
      index++;
      continue;
    }
    if (!trimmed) {
      index++;
      continue;
    }
    const start = index++;
    while (index < lines.length) {
      const next = lines[index].trim();
      if (
        !next ||
        /^(#|```|~~~)/.test(next) ||
        next === '---' ||
        next === '***' ||
        (index + 1 < lines.length && tableDivider(lines[index + 1]))
      ) {
        break;
      }
      index++;
    }
    prose(lines.slice(start, index).join('\n'));
  }
  flush();
  return parts.length ? parts : [{ text: '_(the agent returned an empty reply)_' }];
}

export function renderAgentAnswer(value: string): SlackMessage[] {
  if (!value.trim() || !withinCharacters(value, 12_000) || /<[@!#]/.test(value)) {
    return renderSlackDocument(value);
  }
  const fallback = safeMrkdwn(value);
  if (Buffer.byteLength(fallback) > chunkLimit) return renderSlackDocument(value);
  return [{ text: fallback, blocks: [{ type: 'markdown', text: sanitizedLinks(value) }] }];
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

function appendFooter(parts: SlackMessage[], run: ChannelRunView): void {
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
    last = { text: '', blocks: [] };
    parts.push(last);
  }
  last.text += fallback;
  (last.blocks ??= []).push({ type: 'context', elements: [{ type: 'mrkdwn', text: line }] });
}

function appendFeedback(parts: SlackMessage[]): void {
  let last = parts[parts.length - 1];
  if (!last || (last.blocks?.length ?? 0) >= 40) {
    last = { text: 'Answer feedback', blocks: [] };
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
    const plain = chunkText(
      messages.map((message) => message.text).join('\n\n'),
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
    const payload = JSON.stringify(message.blocks);
    return {
      operationId: `${run.runId}:reply:${index}`,
      kind: 'message',
      required: true,
      text: message.text,
      ...(message.blocks?.length &&
      blocksSchema.safeParse(message.blocks).success &&
      Buffer.byteLength(payload) <= presentationLimit
        ? { presentation: { format: presentationFormat, payload } }
        : {}),
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
    // Reflow as explicit plain text; never split an existing formatted atom to add a notice.
    last.presentation = {
      format: presentationFormat,
      payload: JSON.stringify(plainMessage(last.text).blocks),
    };
  }
  const plan = { revision: '', rendererVersion, parts };
  plan.revision = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  return plan;
}
