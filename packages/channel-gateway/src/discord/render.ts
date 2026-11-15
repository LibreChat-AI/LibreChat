import { createHash } from 'node:crypto';
import type { ChannelDeliveryPlan } from 'librechat-data-provider';

export const discordRendererVersion = 'discord-text-v1';
export interface DiscordRenderInput {
  runId: string;
  text: string;
}
export type DiscordTextPlan = ChannelDeliveryPlan;

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

/** Discord counts UTF-16 units; iteration by code point avoids splitting surrogate pairs. */
export function renderDiscordPlan(
  input: DiscordRenderInput,
  maxParts: number,
  options: { shorten?: boolean } = {},
): DiscordTextPlan {
  if (!input.runId || !Number.isSafeInteger(maxParts) || maxParts < 1 || maxParts > 100)
    throw new TypeError('Invalid Discord delivery budget');
  const source = sanitizeDiscordMentions(input.text);
  if (!source.trim()) throw new DiscordRenderLimitError();
  let chunks: string[];
  try {
    if (source.length > maxParts * 2000) throw new DiscordRenderLimitError();
    chunks = splitText(source, maxParts, false);
  } catch (error) {
    if (!(error instanceof DiscordRenderLimitError) || !options.shorten) throw error;
    chunks = splitText(source, maxParts, true);
  }
  const plan: ChannelDeliveryPlan = {
    revision: '',
    rendererVersion: discordRendererVersion,
    parts: chunks.map((text, index) => ({
      operationId: `${input.runId}:discord:${index}`,
      kind: 'message',
      required: true,
      text,
    })),
  };
  plan.revision = discordPlanRevision(plan);
  return plan;
}
