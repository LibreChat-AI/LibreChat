import { z } from 'zod';
import { createHash } from 'node:crypto';
import { discordRunControl } from 'librechat-data-provider';
import type { ChannelDeliveryPlan, ChannelDeliveryPart } from 'librechat-data-provider';

export const discordLegacyRendererVersion = 'discord-text-v1';
export const discordRendererVersion = 'discord-text-v2';
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

function splitText(source: string, maxParts: number, shorten: boolean): string[] {
  const chunks: string[] = [];
  let chunk = '';
  let fence: string | undefined;
  const close = () => (fence !== undefined ? '\n```' : '');
  const limit = () =>
    2000 - (shorten && chunks.length === maxParts - 1 ? shorteningNotice.length : 0);
  const next = () => {
    if (chunks.length === maxParts - 1) {
      if (!shorten) throw new DiscordRenderLimitError();
      chunks.push(chunk + close() + shorteningNotice);
      return false;
    }
    chunks.push(chunk + close());
    chunk = fence !== undefined ? `\`\`\`${fence}\n` : '';
    return true;
  };
  for (const line of source.split(/(?<=\n)/)) {
    const match = /^```([^\r\n`]*)\r?\n?$/.exec(line);
    if (match && match[1].length <= 100 && (fence === undefined || !match[1].trim())) {
      const nextFence = fence === undefined ? match[1] : undefined;
      if (chunk.length + line.length + (nextFence !== undefined ? 4 : 0) > limit() && !next())
        return chunks;
      chunk += line;
      fence = nextFence;
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
