import type { SeedMessage } from '../specs/mock/db';

/**
 * Deterministic transcript for the message-tree render benchmark: a long
 * linear spine with two regenerate branches, one shallow (short alternate
 * continuation) and one at the leaf, so both a deep path swap and a
 * leaf-only sibling switch can be measured against the same thread.
 */
/** Turns per seeded thread; `TREE_PERF_TURNS` overrides it for scaling runs. */
export const TURNS = Number(process.env.TREE_PERF_TURNS) || 120;
export const ROWS = TURNS * 2;
export const SHALLOW_BRANCH_TURN = 3;
export const SHALLOW_BRANCH_CONTINUATION_TURNS = 2;
export const ROOT_PARENT = '00000000-0000-0000-0000-000000000000';

const SENTENCE =
  'The rollout plan sequences every dependent service behind a single feature flag so rollbacks stay one toggle away. ';

export function marker(label: string): string {
  return `TREEBENCH-${label}`;
}

export function turnHeading(label: string, turn: number): string {
  return `${marker(label)} section ${turn}`;
}

export function altHeading(label: string, turn: number): string {
  return `${marker(label)} alternate ${turn}`;
}

function assistantBody(heading: string, turn: number): string {
  let body = `## ${heading}\n\n${SENTENCE}${SENTENCE}\n\n`;
  body += `- ${marker('point')} one for turn ${turn}\n`;
  body += `- ${marker('point')} two for turn ${turn}\n\n`;
  if (turn % 3 === 0) {
    body +=
      '```ts\nexport function rollout(stage: number): boolean {\n  return stage > 0;\n}\n```\n\n';
  }
  if (turn % 4 === 0) {
    body += '| Service | Requests |\n| --- | --- |\n| gateway | 120000 |\n| worker | 135500 |\n\n';
  }
  return body;
}

function userRow(label: string, id: string, parentMessageId: string, turn: number): SeedMessage {
  return {
    messageId: id,
    parentMessageId,
    text: `${marker(label)} prompt ${turn}: walk me through the rollout for stage ${turn}.`,
    isCreatedByUser: true,
    sender: 'User',
  };
}

function assistantRow(id: string, parentMessageId: string, heading: string, turn: number) {
  return {
    messageId: id,
    parentMessageId,
    text: assistantBody(heading, turn),
    isCreatedByUser: false,
    sender: 'Assistant',
  };
}

/**
 * Seed order doubles as creation order, so an alternate sibling is emitted
 * BEFORE the spine row it competes with: the newest sibling is the default
 * selection, and the spine must stay the default visible path.
 */
export function buildTreeMessages(label: string): SeedMessage[] {
  const messages: SeedMessage[] = [];
  let parentMessageId = ROOT_PARENT;
  for (let turn = 1; turn <= TURNS; turn += 1) {
    const userId = `${label}-user-${turn}`;
    messages.push(userRow(label, userId, parentMessageId, turn));
    const assistantId = `${label}-assistant-${turn}`;
    if (turn === SHALLOW_BRANCH_TURN) {
      const altId = `${label}-assistant-${turn}-alt`;
      messages.push(assistantRow(altId, userId, altHeading(label, turn), turn));
      let altParent = altId;
      for (let extra = 1; extra <= SHALLOW_BRANCH_CONTINUATION_TURNS; extra += 1) {
        const altTurn = 1000 + extra;
        const altUser = `${label}-alt-user-${extra}`;
        messages.push(userRow(label, altUser, altParent, altTurn));
        const altAssistant = `${label}-alt-assistant-${extra}`;
        messages.push(assistantRow(altAssistant, altUser, altHeading(label, altTurn), altTurn));
        altParent = altAssistant;
      }
    }
    if (turn === TURNS) {
      messages.push(
        assistantRow(`${label}-assistant-${turn}-alt`, userId, altHeading(label, turn), turn),
      );
    }
    messages.push(assistantRow(assistantId, userId, turnHeading(label, turn), turn));
    parentMessageId = assistantId;
  }
  return messages;
}
