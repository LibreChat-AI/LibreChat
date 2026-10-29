import { z } from 'zod';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import type {
  ChannelArtifact,
  ChannelRunView,
  ChannelRunUsage,
  ChannelRunSummary,
  ChannelDeliveryPart,
  ChannelDeliveryPlan,
  ResponseAccounting,
} from 'librechat-data-provider';

export const rendererVersion = 'slack-structured-v4';
export const presentationFormat = 'slack-blocks-v1';
export const artifactFailureNotice =
  'One or more attachments could not be confirmed. The answer is preserved; uncertain uploads will not be duplicated automatically.';
const chunkLimit = 39_000;
const presentationLimit = 64_000;
const supportedStructured = new Set([
  rendererVersion,
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
    text: text('mrkdwn', 3000),
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

export function durableSlackMessage(part: ChannelDeliveryPart, renderer: string): SlackMessage {
  if (!part.presentation) {
    return { text: part.text };
  }
  if (
    !supportedStructured.has(renderer) ||
    part.presentation.format !== presentationFormat ||
    Buffer.byteLength(part.presentation.payload) > presentationLimit
  ) {
    throw new Error('Unsupported durable presentation');
  }
  try {
    return { text: part.text, blocks: blocksSchema.parse(JSON.parse(part.presentation.payload)) };
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

function sanitizedLinks(value: string): string {
  return value.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) =>
    displayUrl(url) ? match : label,
  );
}

export function safeMrkdwn(value: string): string {
  const escaped = escapeSlackText(sanitizedLinks(value));
  // Code is literal; prose conversion must not rewrite code examples.
  return escaped
    .split(/(```[\s\S]*?```)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part
            .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<$2|$1>')
            .replace(/\*\*([^*]+)\*\*/g, '*$1*')
            .replace(/__([^_]+)__/g, '*$1*')
            .replace(/^#{1,6}\s+(.+)$/gm, '*$1*'),
    )
    .join('');
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
    for (const chunk of chunkText(safeMrkdwn(value), 2800)) {
      if (chunk.trim()) {
        add(chunk, { type: 'section', text: { type: 'mrkdwn', text: chunk }, expand: true });
      }
    }
  };
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  for (let index = 0; index < lines.length; ) {
    const line = lines[index];
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      const marker = trimmed.slice(0, 3);
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index].trim().startsWith(marker)) {
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
  return [{ text: safeMrkdwn(value), blocks: [{ type: 'markdown', text: sanitizedLinks(value) }] }];
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
  const session =
    validSummary(summary, run.sequence) &&
    summary.session &&
    safeSummarySessionURL(summary.session.url)
      ? summary.session.url
      : undefined;
  let line = labels.join(' · ') + (session ? ` · <${session}|View session>` : '');
  const details = threadDetails(run);
  if (!validSummary(summary, run.sequence) || summary.expectedRuns > 1) {
    line += '\n' + details.slice(0, 2).join(' · ');
  }
  const usage =
    validUsage(snapshot.usage) && snapshot.usage
      ? ` · ${snapshot.usage.totalTokens} tokens (${snapshot.usage.inputTokens} in / ${snapshot.usage.outputTokens} out)`
      : '';
  const fallback = safeMrkdwn(
    `\n\n_This run · ID ${id}${elapsed ? ' · ' + elapsed : ''}${usage}_\n_This run: ${accountingDescription(snapshot.accounting)}_\n_${details.join(' · ')}_${session ? `\n[View session](${session})` : ''}`,
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

export function makeSlackPlan(run: ChannelRunView, native = false): ChannelDeliveryPlan {
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
      (snapshot.artifacts?.length ? ' Any available attachments follow.' : '');
  }
  if (snapshot.artifactsUnavailable) {
    answer += '\n\nAttachments are unavailable. The answer is preserved.';
  }
  const messages = native ? renderAgentAnswer(answer) : renderSlackDocument(answer);
  appendFooter(messages, run);
  if (native && snapshot.status === 'completed' && !empty) {
    appendFeedback(messages);
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
  if (parts.length > 100) {
    throw new Error('Durable answer exceeds part budget');
  }
  const plan = { revision: '', rendererVersion, parts };
  plan.revision = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  return plan;
}
