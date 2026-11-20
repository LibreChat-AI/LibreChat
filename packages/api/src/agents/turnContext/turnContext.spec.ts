import { ArtifactModes, ContentTypes, EModelEndpoint } from 'librechat-data-provider';
import type { ContextEntry, SendSnapshot, TurnContextAgent } from './registry';
import type { TurnContextMessage } from './anchor';
import type { TurnPlan } from './ledger';
import { assembleSystemPrompt, contributeContext, ContextPartKeys } from '../systemParts';
import { generateArtifactsPrompt } from '~/prompts';
import { formatMemoryContext } from '../memory';
import { applyTurnContext } from './anchor';
import { planTurnContext } from './ledger';

const TIMEZONE = 'Africa/Nairobi';
/** 23:00 on Monday 2026-03-09 in Nairobi (UTC+3). */
const START = '2026-03-09T20:00:00.000Z';
const minutes = (n: number) => new Date(Date.parse(START) + n * 60_000).toISOString();
const ARTIFACTS = generateArtifactsPrompt({
  endpoint: EModelEndpoint.openAI,
  artifacts: ArtifactModes.DEFAULT,
}) as string;
const WEB_SEARCH_RUNTIME = '# `web_search` Runtime Context\nConversation started: 2026-03-09';

interface State {
  artifacts?: boolean;
  project?: string;
  skills?: string;
  guard?: string;
  memory?: string;
  webSearch?: boolean;
  files?: string;
  queued?: string;
  timestamps?: boolean;
  timezone?: string;
  rag?: string;
}

function buildAgent(state: State): TurnContextAgent {
  const agent: TurnContextAgent = {
    provider: EModelEndpoint.openAI,
    additional_instructions: 'Own guidance.',
    artifacts: state.artifacts ? ArtifactModes.DEFAULT : undefined,
  };
  if (state.project) {
    contributeContext(agent, ContextPartKeys.project, state.project);
  }
  if (state.guard) {
    contributeContext(agent, ContextPartKeys.memoryGuard, state.guard);
  }
  if (state.artifacts) {
    contributeContext(agent, ContextPartKeys.artifacts, ARTIFACTS);
  }
  if (state.skills) {
    contributeContext(agent, ContextPartKeys.skills, state.skills);
  }
  contributeContext(agent, ContextPartKeys.memory, state.memory);
  agent.dynamicToolContextMap = {
    ...(state.webSearch ? { web_search: WEB_SEARCH_RUNTIME } : {}),
    ...(state.files ? { execute_code: state.files } : {}),
    ...(state.queued ? { queued_code_files: state.queued } : {}),
  };
  return agent;
}

function snapshotOf(state: State, at: string): SendSnapshot {
  return {
    agent: buildAgent(state),
    turnStartedAt: at,
    timezone: state.timezone ?? TIMEZONE,
    dateContext: state.webSearch === true,
    messageTimestamps: state.timestamps === true,
    memory: state.memory,
    rag: state.rag,
  };
}

interface Row extends TurnContextMessage {
  messageId: string;
  parentMessageId: string | null;
  contextUpdates?: ContextEntry[];
  contextAnchor?: ContextEntry[];
}

/** Stores what the server stores: entries on user messages, anchors on the conversation and on summary carriers. */
class Conversation {
  rows: Row[] = [];
  anchor: ContextEntry[] | null = null;
  private count = 0;

  branch(leafId: string | null): Row[] {
    const byId = new Map(this.rows.map((row) => [row.messageId, row]));
    const chain: Row[] = [];
    for (let id = leafId; id != null; id = byId.get(id)?.parentMessageId ?? null) {
      const row = byId.get(id);
      if (row == null) {
        break;
      }
      chain.unshift(row);
    }
    return chain;
  }

  /** Sends a user message after `parentId` (the last message by default) and stores the turn. */
  send(
    state: State,
    at: string,
    {
      parentId = this.rows[this.rows.length - 1]?.messageId ?? null,
      reuseId,
      summary,
    }: { parentId?: string | null; reuseId?: string; summary?: boolean } = {},
  ): { plan: TurnPlan; messages: Row[]; texts: Array<string | undefined> } {
    const userId = reuseId ?? `u${++this.count}`;
    const user: Row = { messageId: userId, parentMessageId: parentId, isCreatedByUser: true };
    const messages = [...this.branch(parentId), user];
    const plan = planTurnContext({
      messages,
      conversationAnchor: this.anchor,
      snapshot: snapshotOf(state, at),
      currentIndex: messages.length - 1,
    });
    this.store(plan, user);
    const reply: Row = {
      messageId: `a-${userId}-${this.count}`,
      parentMessageId: userId,
      isCreatedByUser: false,
      content: summary ? [summaryPart()] : [{ type: ContentTypes.TEXT, text: 'Answer' }],
    };
    this.rows.push(reply);
    return { plan, messages, texts: messages.map((_m, i) => plan.updates.get(i)) };
  }

  private store(plan: TurnPlan, user: Row) {
    this.rows = this.rows.filter((row) => row.messageId !== user.messageId);
    this.rows.push({ ...user, contextUpdates: plan.currentEntries });
    if (plan.anchorTarget?.messageId === null) {
      this.anchor ??= plan.anchor;
    } else if (plan.anchorTarget != null) {
      const carrier = this.rows.find((row) => row.messageId === plan.anchorTarget?.messageId);
      if (carrier != null) {
        carrier.contextAnchor ??= plan.anchor;
      }
    }
  }
}

const summaryPart = (retainedFromMessageId?: string) => ({
  type: ContentTypes.SUMMARY,
  content: [{ type: ContentTypes.TEXT, text: 'Earlier discussion.' }],
  boundary: { messageId: 'm', contentIndex: 0 },
  ...(retainedFromMessageId ? { coverage: { retainedFromMessageId } } : {}),
});

const last = (texts: Array<string | undefined>) => texts[texts.length - 1];

describe('planTurnContext', () => {
  const base: State = { project: 'Quote prices in EUR.', memory: 'Likes tea.', webSearch: true };

  it('anchors the first turn to the live state and announces nothing', () => {
    const convo = new Conversation();
    const { plan, texts } = convo.send(base, minutes(0));
    expect(plan.anchorTarget).toEqual({ messageId: null });
    expect(plan.anchor.map(({ key }) => key)).toEqual([
      'project',
      'runtime:web_search',
      'date',
      'memory',
    ]);
    expect(plan.block).toBe(
      [
        'Quote prices in EUR.',
        WEB_SEARCH_RUNTIME,
        'Current date: 2026-03-09 (Monday)',
        'Likes tea.',
      ].join('\n\n'),
    );
    expect(plan.currentEntries).toEqual([]);
    expect(texts).toEqual([undefined]);
    expect(plan.memoryTexts).toEqual(['Likes tea.']);
  });

  it('keeps the anchor, announces a toggle once and replays it byte for byte', () => {
    const convo = new Conversation();
    const first = convo.send(base, minutes(0)).plan;
    const turn2 = convo.send({ ...base, artifacts: true }, minutes(1));
    expect(turn2.plan.anchorTarget).toBeUndefined();
    expect(turn2.plan.block).toBe(first.block);
    expect(turn2.plan.currentEntries).toEqual([{ key: 'artifacts', value: 'default' }]);
    expect(last(turn2.texts)).toBe(
      `<context_update>\nArtifacts instructions:\n${ARTIFACTS}\n</context_update>`,
    );

    const turn3 = convo.send({ ...base, artifacts: true }, minutes(2));
    expect(turn3.plan.currentEntries).toEqual([]);
    expect(turn3.texts[2]).toBe(last(turn2.texts));
    expect(last(turn3.texts)).toBeUndefined();

    const turn4 = convo.send(base, minutes(3));
    expect(last(turn4.texts)).toBe(
      '<context_update>\nArtifacts instructions no longer applies.\n</context_update>',
    );
    expect(turn4.texts.filter(Boolean)).toHaveLength(2);
    expect(turn4.plan.block).toBe(first.block);
  });

  describe('toggles flipped before sending', () => {
    it('leave no trace when they end where they started', () => {
      const baseline = new Conversation();
      baseline.send(base, minutes(0));
      const untouched = baseline.send(base, minutes(1));

      /** On, off, on, off between the turns: only the state at send time is read. */
      const flapped = new Conversation();
      flapped.send(base, minutes(0));
      const result = flapped.send({ ...base, artifacts: false }, minutes(1));
      expect(result.plan).toEqual(untouched.plan);
      expect(result.plan.currentEntries).toEqual([]);
    });
  });

  it('follows the parent chain: a branch does not see the changes of another branch', () => {
    const convo = new Conversation();
    convo.send(base, minutes(0));
    const firstReply = convo.rows[1].messageId;
    convo.send({ ...base, artifacts: true }, minutes(1));
    convo.send({ ...base, artifacts: true }, minutes(2));

    const branch = convo.send(base, minutes(3), { parentId: firstReply });
    expect(branch.messages).toHaveLength(3);
    expect(branch.plan.currentEntries).toEqual([]);
    expect(branch.texts.filter(Boolean)).toHaveLength(0);

    const branchOn = convo.send({ ...base, artifacts: true }, minutes(4), { parentId: firstReply });
    expect(branchOn.plan.currentEntries).toEqual([{ key: 'artifacts', value: 'default' }]);
  });

  describe('compaction', () => {
    function compacted() {
      const convo = new Conversation();
      convo.send({ ...base, timestamps: true }, minutes(0));
      convo.send({ ...base, artifacts: true, timestamps: true }, minutes(1));
      convo.send({ ...base, artifacts: true, project: 'P2', timestamps: true }, minutes(2), {
        summary: true,
      });
      return convo;
    }

    it('re-anchors the next turn to the live state, keeping the previous order', () => {
      const convo = compacted();
      const carrier = convo.rows[convo.rows.length - 1].messageId;
      const { plan, texts } = convo.send(
        { ...base, artifacts: true, project: 'P2', skills: 'S', memory: undefined },
        minutes(3),
      );
      expect(plan.anchorTarget).toEqual({ messageId: carrier });
      expect(plan.anchor).toEqual([
        { key: 'project', value: 'P2' },
        { key: 'runtime:web_search', value: WEB_SEARCH_RUNTIME },
        { key: 'date', value: '2026-03-09 (Monday)' },
        { key: 'artifacts', value: 'default' },
        { key: 'skills', value: 'S' },
      ]);
      expect(plan.block).toBe(
        ['P2', WEB_SEARCH_RUNTIME, 'Current date: 2026-03-09 (Monday)', ARTIFACTS, 'S'].join(
          '\n\n',
        ),
      );
      expect(plan.currentEntries).toEqual([]);
      expect(texts.every((text) => text == null)).toBe(true);
    });

    it('does not re-announce changes from before the boundary and keeps the new anchor', () => {
      const convo = compacted();
      const state = { ...base, artifacts: true, project: 'P2' };
      convo.send(state, minutes(3));
      const next = convo.send({ ...state, project: 'P3' }, minutes(4));
      expect(next.plan.anchorTarget).toBeUndefined();
      expect(next.texts.filter(Boolean)).toEqual([
        '<context_update>\nProject guidance (replaces any earlier version):\nP3\n</context_update>',
      ]);
    });
  });

  describe('memory', () => {
    const formatted = (...entries: string[]) =>
      formatMemoryContext(entries.map((entry, i) => `${i + 1}. ${entry}`).join('\n\n'));
    const entry = (key: string, value: string, date = '2026-03-09') =>
      `[${date}]. ["key": "${key}"]. ["value": "${value}"]`;

    it('announces added, changed and removed entries by key and stores the diff, not the memory', () => {
      const convo = new Conversation();
      const initial = formatted(entry('color', 'blue'), entry('city', 'Oslo'), entry('pet', 'cat'));
      convo.send({ ...base, memory: initial }, minutes(0));
      const next = formatted(
        entry('color', 'green', '2026-03-10'),
        entry('pet', 'cat'),
        entry('job', 'pilot', '2026-03-10'),
      );
      const changed = convo.send({ ...base, memory: next }, minutes(1));
      expect(changed.plan.currentEntries).toEqual([
        {
          key: 'memory',
          value: JSON.stringify({
            added: [entry('job', 'pilot', '2026-03-10')],
            changed: [entry('color', 'green', '2026-03-10')],
            removed: [entry('city', 'Oslo')],
          }),
        },
      ]);
      expect(last(changed.texts)).toBe(
        `<context_update>\nMemory about the user changed:\nAdded:\n${entry('job', 'pilot', '2026-03-10')}\nChanged:\n${entry('color', 'green', '2026-03-10')}\nRemoved:\n${entry('city', 'Oslo')}\n</context_update>`,
      );
    });

    it('withholds memory everywhere while it is off, and records nothing', () => {
      const convo = new Conversation();
      convo.send(base, minutes(0));
      convo.send({ ...base, memory: 'Likes coffee.' }, minutes(1));
      const off = convo.send({ ...base, memory: undefined }, minutes(2));
      expect(off.plan.block).not.toContain('Likes');
      expect(off.texts.join('')).not.toContain('Likes');
      expect(off.plan.currentEntries).toEqual([]);
      expect(off.plan.memoryTexts).toEqual([]);

      const back = convo.send({ ...base, memory: 'Likes coffee.' }, minutes(3));
      expect(back.plan.currentEntries).toEqual([]);
      expect(back.texts.join('')).toContain('Likes coffee.');
      expect(back.plan.block).toContain('Likes tea.');
    });
  });

  describe('date', () => {
    it('announces the first message after local midnight once', () => {
      const convo = new Conversation();
      convo.send(base, minutes(0));
      const before = convo.send(base, minutes(59));
      const after = convo.send(base, minutes(61));
      expect(last(before.texts)).toBeUndefined();
      expect(last(after.texts)).toBe(
        '<context_update>\nCurrent date changed to: 2026-03-10 (Tuesday)\n</context_update>',
      );
      const later = convo.send(base, minutes(120));
      expect(later.texts.filter(Boolean)).toHaveLength(1);
    });
  });

  it('shows queued upload files with their own message only', () => {
    const convo = new Conversation();
    convo.send(base, minutes(0));
    const upload = convo.send({ ...base, queued: '- /mnt/data/report.csv' }, minutes(1));
    expect(last(upload.texts)).toBe('<context_update>\n- /mnt/data/report.csv\n</context_update>');
    expect(upload.plan.block).not.toContain('report.csv');
    const next = convo.send(base, minutes(2));
    expect(next.texts[2]).toBe(last(upload.texts));
    expect(last(next.texts)).toBeUndefined();
  });

  describe('retrieved context (RAG)', () => {
    it('binds it to the message it was retrieved for, stores it and replays it', () => {
      const convo = new Conversation();
      convo.send(base, minutes(0));
      const turn2 = convo.send({ ...base, rag: 'Passage 7919 from report.pdf\n' }, minutes(1));
      expect(turn2.plan.currentEntries).toEqual([
        { key: 'rag', value: 'Passage 7919 from report.pdf' },
      ]);
      expect(last(turn2.texts)).toBe(
        '<context_update>\nPassage 7919 from report.pdf\n</context_update>',
      );
      expect(turn2.plan.block).not.toContain('Passage');
      expect(turn2.plan.ragTexts).toEqual(['Passage 7919 from report.pdf']);

      const turn3 = convo.send({ ...base, rag: 'Passage 104729' }, minutes(2));
      expect(turn3.texts[2]).toBe(last(turn2.texts));
      expect(last(turn3.texts)).toBe('<context_update>\nPassage 104729\n</context_update>');
      expect(turn3.plan.block).toBe(turn2.plan.block);
    });
  });
});

describe('applyTurnContext', () => {
  function initialized(): TurnContextAgent {
    const agent = buildAgent({
      project: 'Project',
      artifacts: true,
      memory: 'Memory',
      webSearch: true,
      queued: 'queued.csv',
    });
    agent.instructions = 'Base.';
    agent.toolContextMap = { web_search: 'Search instructions.' };
    contributeContext(agent, ContextPartKeys.agentFiles, 'Agent files.');
    contributeContext(agent, ContextPartKeys.rag, 'Retrieved passage.');
    return agent;
  }

  it('renders the system prompt from the anchor block, without any per-turn part', () => {
    const agent = initialized();
    applyTurnContext(agent, { block: 'Anchored block.' });
    expect(agent.additional_instructions).toBe('Own guidance.\n\nAgent files.\n\nAnchored block.');
    expect(assembleSystemPrompt(agent)).toEqual({
      instructions: 'Search instructions.\nBase.',
      additional_instructions: 'Own guidance.\n\nAgent files.\n\nAnchored block.',
    });
  });

  it('leaves nothing for the SDK to move when the provider moves the dynamic part', () => {
    const agent = initialized();
    applyTurnContext(agent, { block: 'Anchored block.' });
    expect(assembleSystemPrompt(agent, { stableContext: true, moveTurnPartsOnly: true })).toEqual({
      instructions:
        'Search instructions.\nBase.\n\nOwn guidance.\n\nAgent files.\n\nAnchored block.',
      additional_instructions: '',
    });
  });
});
