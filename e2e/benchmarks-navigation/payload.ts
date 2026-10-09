import type { SeedMessage } from '../specs/mock/db';

/**
 * Deterministic transcripts for the conversation-navigation perf benchmark.
 *
 * Two seeded conversations of the same shape, each long enough that its first
 * commit is real work (well past `MIN_PROGRESSIVE_ROWS`), so switching between
 * them measures the navigation path a user actually feels — not a two-message
 * toy thread that renders in a single frame regardless.
 */

/** Turns per seeded conversation; one turn is a user + assistant pair. */
export const TURNS_PER_CONVO = 30;

/** Rows per conversation — what `useProgressiveRowMount` windows over. */
export const ROWS_PER_CONVO = TURNS_PER_CONVO * 2;

const SENTENCE =
  'The migration plan sequences every dependent service behind a single feature flag so rollbacks stay one toggle away. ';

/**
 * Per-conversation marker carried by EVERY row. The in-page sampler reads it
 * off whichever row happens to be mounted, so it identifies the painted
 * transcript without depending on which slice of the thread the progressive
 * mount window admitted first.
 */
export function convoMarker(label: string): string {
  return `NAVBENCH-${label}`;
}

/** Rendered heading text unique to one conversation, for Playwright locators. */
export function turnHeading(label: string, turn: number): string {
  return `${convoMarker(label)} section ${turn}`;
}

function assistantBody(label: string, turn: number): string {
  const table =
    '| Service | Requests | Growth |\n| --- | --- | --- |\n' +
    '| gateway | 120000 | 4% |\n| worker | 135500 | 12% |\n';
  const code =
    '```ts\nexport function rollout(stage: number): boolean {\n  return stage > 0;\n}\n```\n';
  let body = `## ${turnHeading(label, turn)}\n\n${SENTENCE}${SENTENCE}\n\n`;
  body += `- ${convoMarker(label)} point one for turn ${turn}\n`;
  body += `- ${convoMarker(label)} point two for turn ${turn}\n\n`;
  if (turn % 3 === 0) {
    body += `${code}\n`;
  }
  if (turn % 4 === 0) {
    body += `${table}\n`;
  }
  return body;
}

/**
 * Linear thread (no siblings): every message parents the previous one, so the
 * visible path is the whole conversation and `latestMessageDepth` equals
 * `ROWS_PER_CONVO - 1`.
 */
export function buildConversationMessages(label: string): SeedMessage[] {
  const messages: SeedMessage[] = [];
  let parentMessageId = '00000000-0000-0000-0000-000000000000';
  for (let turn = 1; turn <= TURNS_PER_CONVO; turn += 1) {
    const userMessageId = `${label}-user-${turn}`;
    messages.push({
      messageId: userMessageId,
      parentMessageId,
      text: `${convoMarker(label)} prompt ${turn}: walk me through the rollout for stage ${turn}.`,
      isCreatedByUser: true,
      sender: 'User',
    });
    const assistantMessageId = `${label}-assistant-${turn}`;
    messages.push({
      messageId: assistantMessageId,
      parentMessageId: userMessageId,
      text: assistantBody(label, turn),
      isCreatedByUser: false,
      sender: 'Assistant',
    });
    parentMessageId = assistantMessageId;
  }
  return messages;
}
