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

/** Discord counts UTF-16 units; iteration by code point avoids splitting surrogate pairs. */
export function renderDiscordPlan(input: DiscordRenderInput, maxParts: number): DiscordTextPlan {
  if (!input.runId || !Number.isSafeInteger(maxParts) || maxParts < 1 || maxParts > 100)
    throw new TypeError('Invalid Discord delivery budget');
  const source = sanitizeDiscordMentions(input.text);
  if (!source.trim() || source.length > maxParts * 2000)
    throw new Error('Discord answer exceeds delivery budget');
  const chunks: string[] = [];
  let chunk = '';
  let fence: string | undefined;
  const flush = () => {
    if (chunks.length >= maxParts) throw new Error('Discord answer exceeds delivery budget');
    chunks.push(chunk + (fence !== undefined ? '\n```' : ''));
    chunk = fence !== undefined ? `\`\`\`${fence}\n` : '';
  };
  const fencePattern = /^```([^\r\n`]*)\r?\n?$/;
  const lines = source.split(/(?<=\n)/);
  for (const [index, line] of lines.entries()) {
    const match = fencePattern.exec(line);
    if (match && match[1].length <= 100) {
      const closingFenceLength = fence === undefined ? 4 : 0;
      if (chunk.length + line.length + closingFenceLength > 2000) flush();
      chunk += line;
      fence = fence === undefined ? match[1] : undefined;
      continue;
    }
    // A closing fence on the next line can fit without the synthetic newline.
    if (
      fence !== undefined &&
      lines[index + 1] === '```' &&
      chunk.length + line.length + 3 <= 2000
    ) {
      chunk += line;
      continue;
    }
    for (const point of line) {
      if (chunk.length + point.length + (fence !== undefined ? 4 : 0) > 2000) flush();
      chunk += point;
    }
  }
  if (chunk) flush();
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
  plan.revision = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  return plan;
}
