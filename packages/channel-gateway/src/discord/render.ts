import { z } from 'zod';
import { createHash } from 'node:crypto';
import { discordRunControl } from 'librechat-data-provider';
import type { ChannelDeliveryPlan, ChannelDeliveryPart } from 'librechat-data-provider';

export const discordLegacyRendererVersion = 'discord-text-v1';
export const discordRendererVersion = 'discord-text-v2';
export const discordDocumentRendererVersion = 'discord-document-v1';
/** v2 whose last answer part may carry an authorized session link button, resolved at delivery. */
export const discordSessionRendererVersion = 'discord-text-v3';
const feedbackFormat = 'discord-feedback-v1';
const feedbackSchema = z.object({ runId: z.string().min(1).max(80) }).strict();
const presentationSchema = z
  .object({ format: z.literal(feedbackFormat), payload: z.string().max(128) })
  .strict();
export interface DiscordRenderInput {
  runId: string;
  text: string;
}
export type DiscordTextPlan = ChannelDeliveryPlan;

/** Fixed server-authored controls only; no model-authored component payload or URL is accepted. */
export function discordFeedbackPresentation(
  runId: string,
): NonNullable<ChannelDeliveryPart['presentation']> {
  discordRunControl('thumbsUp', runId);
  return { format: feedbackFormat, payload: JSON.stringify({ runId }) };
}

export function readDiscordFeedbackPresentation(part: ChannelDeliveryPart): string | undefined {
  if (part.presentation === undefined) return undefined;
  if (part.presentation.format === 'discord-document-v1')
    return readDiscordDocumentPresentation(part)?.feedbackRunId;
  const wrapper = presentationSchema.safeParse(part.presentation);
  if (!wrapper.success) throw new Error('Invalid Discord feedback presentation');
  const value = wrapper.data;
  let payload: unknown;
  try {
    payload = JSON.parse(value.payload);
  } catch {
    throw new Error('Invalid Discord feedback presentation');
  }
  const parsed = feedbackSchema.safeParse(payload);
  if (!parsed.success || JSON.stringify(parsed.data) !== value.payload)
    throw new Error('Invalid Discord feedback presentation');
  discordRunControl('thumbsUp', parsed.data.runId);
  return parsed.data.runId;
}

export function sanitizeDiscordMentions(text: string): string {
  return text
    .replace(/<(@[!&]?|#)(\d+)>/g, '<$1\u200b$2>')
    .replace(/@(everyone|here)\b/gi, '@\u200b$1');
}

const shorteningNotice =
  '\n\nReply shortened to fit this channel’s delivery limit. The full answer remains in the saved execution.';
class DiscordRenderLimitError extends Error {
  constructor() {
    super('Discord answer exceeds delivery budget');
  }
}

function splitText(
  source: string,
  maxParts: number,
  shorten: boolean,
  maxLength = 2000,
  notice = shorteningNotice,
): string[] {
  const chunks: string[] = [];
  let chunk = '';
  let fence: string | undefined;
  const close = () => (fence !== undefined ? '\n```' : '');
  const limit = () => maxLength - (shorten && chunks.length === maxParts - 1 ? notice.length : 0);
  const next = () => {
    if (chunks.length === maxParts - 1) {
      if (!shorten) throw new DiscordRenderLimitError();
      chunks.push(chunk + close() + notice);
      return false;
    }
    chunks.push(chunk + close());
    chunk = fence !== undefined ? `\`\`\`${fence}\n` : '';
    return true;
  };
  const fencePattern = /^```([^\r\n`]*)\r?\n?$/;
  const lines = source.split(/(?<=\n)/);
  for (const [index, line] of lines.entries()) {
    const match = fencePattern.exec(line);
    if (match && match[1].length <= 100 && (fence === undefined || !match[1].trim())) {
      const nextFence = fence === undefined ? match[1] : undefined;
      if (chunk.length + line.length + (nextFence !== undefined ? 4 : 0) > limit() && !next())
        return chunks;
      chunk += line;
      fence = nextFence;
      continue;
    }
    // A closing fence on the next line can fit without the synthetic newline.
    if (
      fence !== undefined &&
      lines[index + 1] === '```' &&
      chunk.length + line.length + 3 <= limit()
    ) {
      chunk += line;
      continue;
    }
    for (const point of line) {
      if (chunk.length + point.length + close().length > limit() && !next()) return chunks;
      chunk += point;
    }
  }
  if (chunk) chunks.push(chunk + close());
  return chunks;
}

export function discordPlanRevision(
  plan: Pick<ChannelDeliveryPlan, 'rendererVersion' | 'parts'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({ revision: '', rendererVersion: plan.rendererVersion, parts: plan.parts }),
    )
    .digest('hex');
}

/**
 * Discord counts UTF-16 units; iteration by code point avoids splitting surrogate pairs.
 * `spare` leaves one part free only when the answer has to be shortened, so the caller can still
 * append an optional part within `maxParts`. A complete answer is never shortened for it, and a
 * one part budget keeps its required answer part.
 * `session` covers the shortened answer that still fills the whole budget, where no part is left
 * for a link. The plan is stamped with the renderer version that lets delivery attach the session
 * link as a button, if the backend still authorizes it then. The text is unchanged and no URL is
 * persisted.
 */
export function renderDiscordPlan(
  input: DiscordRenderInput,
  maxParts: number,
  options: { shorten?: boolean; feedback?: boolean; spare?: boolean; session?: boolean } = {},
): DiscordTextPlan {
  if (!input.runId || !Number.isSafeInteger(maxParts) || maxParts < 1 || maxParts > 100)
    throw new TypeError('Invalid Discord delivery budget');
  const source = sanitizeDiscordMentions(input.text);
  if (!source.trim()) throw new DiscordRenderLimitError();
  let chunks: string[];
  let shortened = false;
  try {
    if (source.length > maxParts * 2000) throw new DiscordRenderLimitError();
    chunks = splitText(source, maxParts, false);
  } catch (error) {
    if (!(error instanceof DiscordRenderLimitError) || !options.shorten) throw error;
    shortened = true;
    chunks = splitText(source, options.spare ? Math.max(1, maxParts - 1) : maxParts, true);
  }
  const plan: ChannelDeliveryPlan = {
    revision: '',
    rendererVersion:
      options.session === true && shortened && chunks.length >= maxParts
        ? discordSessionRendererVersion
        : discordRendererVersion,
    parts: chunks.map((text, index) => ({
      operationId: `${input.runId}:discord:${index}`,
      kind: 'message',
      required: true,
      text,
    })),
  };
  if (options.feedback === true)
    plan.parts[0].presentation = discordFeedbackPresentation(input.runId);
  plan.revision = discordPlanRevision(plan);
  return plan;
}

/** One bounded draft, with closed code fences and no split Unicode or active mention syntax. */
export function renderDiscordPreview(text: string, maxChars: number): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 128 || maxChars > 1800)
    throw new TypeError('Invalid Discord preview budget');
  return splitText(sanitizeDiscordMentions(text), 1, true, maxChars, '\n\n…')[0] ?? '';
}

const documentSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().min(1).max(1_048_576),
    feedbackRunId: z.string().min(1).max(80).optional(),
    artifactsUnavailable: z.boolean().optional(),
  })
  .strict();

export function readDiscordDocumentPresentation(
  part: ChannelDeliveryPart,
): z.infer<typeof documentSchema> | undefined {
  if (part.presentation?.format !== discordDocumentRendererVersion) return undefined;
  if (part.presentation.payload.length > 256)
    throw new Error('Invalid Discord document presentation');
  const value = documentSchema.parse(JSON.parse(part.presentation.payload));
  if (
    JSON.stringify(value) !== part.presentation.payload ||
    part.text !== documentCaption(value.artifactsUnavailable)
  )
    throw new Error('Invalid Discord document presentation');
  if (value.feedbackRunId) discordRunControl('thumbsUp', value.feedbackRunId);
  return value;
}

/** Only a hash and byte count are persisted: final delivery checks the immutable answer snapshot. */
export function renderDiscordDocumentPlan(
  input: DiscordRenderInput,
  feedback: boolean,
  artifactsUnavailable = false,
): DiscordTextPlan {
  const bytes = Buffer.byteLength(input.text);
  const payload = documentSchema.parse({
    sha256: createHash('sha256').update(input.text).digest('hex'),
    bytes,
    ...(feedback ? { feedbackRunId: input.runId } : {}),
    ...(artifactsUnavailable ? { artifactsUnavailable: true } : {}),
  });
  const plan: DiscordTextPlan = {
    revision: '',
    rendererVersion: discordDocumentRendererVersion,
    parts: [
      {
        operationId: `${input.runId}:discord:0`,
        kind: 'message',
        required: true,
        text: documentCaption(artifactsUnavailable),
        presentation: { format: discordDocumentRendererVersion, payload: JSON.stringify(payload) },
      },
    ],
  };
  plan.revision = discordPlanRevision(plan);
  return plan;
}

export function discordAnswerFits(text: string, maxParts: number): boolean {
  try {
    renderDiscordPlan({ runId: 'budget', text }, maxParts);
    return true;
  } catch (error) {
    if (error instanceof DiscordRenderLimitError) return false;
    throw error;
  }
}

function documentCaption(artifactsUnavailable = false): string {
  return (
    'The complete reply is attached as reply.md.' +
    (artifactsUnavailable
      ? '\n\nOther attachments are unavailable in Discord. Use /librechat status to open the saved session.'
      : '')
  );
}
