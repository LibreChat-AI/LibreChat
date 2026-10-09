import type { SeedMessage } from '../specs/mock/db';

export const TURNS = 150;
export const ROWS = TURNS * 2;
export const STREAM_END_MARKER = 'MOBILE-PERF-STREAM-END';

const PROSE =
  'This mobile performance transcript deliberately combines prose, lists, tables, and code so each mounted message exercises realistic chat rendering. ';

function assistantBody(turn: number): string {
  let body = `## Mobile stress turn ${turn}\n\n${PROSE}${PROSE}\n\n`;
  body += `- First observation for turn ${turn}\n`;
  body += `- Second observation for turn ${turn}\n\n`;
  if (turn % 5 === 0) {
    body +=
      '```ts\nexport function mobileSample(value: number): number {\n  return value * 2;\n}\n```\n\n';
  }
  if (turn % 7 === 0) {
    body +=
      '| Metric | Value |\n| --- | ---: |\n' + `| messages | ${turn * 2} |\n| turn | ${turn} |\n\n`;
  }
  return body;
}

export function buildStressMessages(label: string): SeedMessage[] {
  const messages: SeedMessage[] = [];
  let parentMessageId = '00000000-0000-0000-0000-000000000000';
  for (let turn = 1; turn <= TURNS; turn += 1) {
    const userMessageId = `${label}-user-${turn}`;
    messages.push({
      messageId: userMessageId,
      parentMessageId,
      text: `Mobile stress prompt ${turn}: summarize the measurements for this turn.`,
      isCreatedByUser: true,
      sender: 'User',
    });
    const assistantMessageId = `${label}-assistant-${turn}`;
    messages.push({
      messageId: assistantMessageId,
      parentMessageId: userMessageId,
      text: assistantBody(turn),
      isCreatedByUser: false,
      sender: 'Assistant',
    });
    parentMessageId = assistantMessageId;
  }
  return messages;
}

export function buildContinuationReply(): string {
  let body = '# Continued mobile stress response\n\n';
  for (let section = 1; section <= 16; section += 1) {
    body += `## Stream section ${section}\n\n${PROSE}${PROSE}\n\n`;
    body += `1. Render the streamed section ${section}.\n`;
    body += `2. Keep the long transcript mounted behind it.\n\n`;
    if (section % 4 === 0) {
      body +=
        '```ts\nexport function streamedValue(input: number): number {\n  return input + 1;\n}\n```\n\n';
    }
  }
  return `${body}${STREAM_END_MARKER}\n`;
}
