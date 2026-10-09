/**
 * Deterministic long-form reply payload for the reasoning-stream perf benchmark.
 *
 * The reasoning section intentionally far exceeds the legacy 4500-char
 * `blockThreshold` the old SplitStreamHandler used, so streaming it as ONE
 * contiguous think part exercises exactly the case the legacy splitting
 * existed to protect against.
 */
export const SENTENCE =
  'The quarterly analytics review shows sustained growth across every referral channel, with notable spikes on launch days. ';

export const THINK_TARGET_CHARS = 18000;
export const TEXT_TARGET_CHARS = 6000;
export const END_MARKER = 'END-OF-BENCH-STREAM';

export function buildThinkSection(): string {
  let think = '';
  let i = 0;
  while (think.length < THINK_TARGET_CHARS) {
    i += 1;
    think += `Step ${i}: ${SENTENCE}`;
    if (i % 6 === 0) {
      think += '\n\n';
    }
  }
  return think;
}

export function buildTextSection(): string {
  const codeBlock =
    '```ts\nexport function estimate(total: number, rate: number): number {\n  return Math.round(total * rate);\n}\n```\n\n';
  const table =
    '| Month | Visitors | Growth |\n| --- | --- | --- |\n| Jan | 120000 | 4% |\n| Feb | 135500 | 12% |\n| Mar | 151200 | 11% |\n\n';
  let text = '# Milestone Report\n\n';
  let j = 0;
  while (text.length < TEXT_TARGET_CHARS) {
    j += 1;
    text += `## Section ${j}\n\n${SENTENCE}${SENTENCE}\n\n- Point one for section ${j}\n- Point two for section ${j}\n\n`;
    if (j % 3 === 0) {
      text += codeBlock;
    }
    if (j % 4 === 0) {
      text += table;
    }
  }
  text += `\n\n${END_MARKER}\n`;
  return text;
}

export function buildReasoningPayload(): string {
  return `<think>${buildThinkSection()}</think>\n\n${buildTextSection()}`;
}

/** Mirrors the mock FakeChatModel's default whitespace split strategy. */
export function countModelChunks(text: string): number {
  return text.split(/(?<=\s+)|(?=\s+)/).length;
}
