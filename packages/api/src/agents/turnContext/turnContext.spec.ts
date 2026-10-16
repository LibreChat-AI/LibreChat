import { ArtifactModes, ContentTypes, EModelEndpoint } from 'librechat-data-provider';
import type { ContextEntry, SendSnapshot, TurnContextAgent } from './registry';
import type { TurnContextMessage } from './anchor';
import type { TurnPlan } from './ledger';
import {
  ContextSourceKeys,
  collectLiveContext,
  renderAnchorText,
  compareContextKeys,
} from './registry';
import { assembleSystemPrompt, contributeContext, ContextPartKeys } from '../systemParts';
import { applyTurnContext, createAnchor, reanchor } from './anchor';
import { formatMemoryContext, memoryInstructions } from '../memory';
import { QUEUED_CODE_FILES_CONTEXT_KEY } from '~/files/code/queued';
import { generateArtifactsPrompt } from '~/prompts';
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

describe('registry', () => {
  it('collects every source from the agent and the send-time snapshot', () => {
    const live = collectLiveContext(
      snapshotOf(
        {
          artifacts: true,
          project: 'Project',
          skills: 'Skills',
          guard: 'Guard',
          memory: 'Memory',
          webSearch: true,
          files: 'data.csv',
          queued: 'upload.csv',
          timestamps: true,
        },
        minutes(0),
      ),
    );
    expect([...live.entries()]).toEqual([
      ['memory_guard', 'Guard'],
      ['artifacts', ArtifactModes.DEFAULT],
      ['skills', 'Skills'],
      ['project', 'Project'],
      ['runtime:web_search', WEB_SEARCH_RUNTIME],
      ['runtime:execute_code', 'data.csv'],
      ['date', '2026-03-09 (Mon)'],
      ['message_time', '2026-03-09 23:00:00 +03:00 (Mon)'],
      ['memory', 'Memory'],
      ['queued_code_files', 'upload.csv'],
    ]);
  });

  it('keys its sources by the system prompt part they replace', () => {
    expect(ContextSourceKeys).toMatchObject({
      memoryGuard: ContextPartKeys.memoryGuard,
      artifacts: ContextPartKeys.artifacts,
      skills: ContextPartKeys.skills,
      project: ContextPartKeys.project,
      runtimePrefix: ContextPartKeys.runtimePrefix,
      memory: ContextPartKeys.memory,
      queuedCodeFiles: QUEUED_CODE_FILES_CONTEXT_KEY,
    });
  });

  it('dates and stamps nothing unless the prompt states a date or timestamps are on', () => {
    const live = collectLiveContext(snapshotOf({}, minutes(0)));
    expect(live.has(ContextSourceKeys.date)).toBe(false);
    expect(live.has(ContextSourceKeys.messageTime)).toBe(false);
  });

  it('stores the artifacts mode and renders the exact prompt initialization contributes', () => {
    const agent = buildAgent({ artifacts: true });
    expect(renderAnchorText('artifacts', ArtifactModes.DEFAULT, agent)).toBe(
      agent.contextParts?.artifacts,
    );
    const anthropic = { ...agent, provider: EModelEndpoint.anthropic };
    expect(renderAnchorText('artifacts', ArtifactModes.SHADCNUI, anthropic)).toBe(
      generateArtifactsPrompt({
        endpoint: EModelEndpoint.anthropic,
        artifacts: ArtifactModes.SHADCNUI,
      }),
    );
  });

  it('dates the anchor and renders nothing in the system prompt for message sources', () => {
    const agent = buildAgent({});
    expect(renderAnchorText('date', '2026-03-09 (Mon)', agent)).toBe(
      'Current date: 2026-03-09 (Mon)',
    );
    expect(renderAnchorText('queued_code_files', 'x', agent)).toBe('');
    expect(renderAnchorText('unknown', 'x', agent)).toBe('');
  });

  it('orders keys by registry, keys of one prefix by name', () => {
    const keys = ['memory', 'runtime:web_search', 'date', 'runtime:execute_code', 'project'];
    expect(keys.sort(compareContextKeys)).toEqual([
      'project',
      'runtime:execute_code',
      'runtime:web_search',
      'date',
      'memory',
    ]);
  });
});

describe('anchors', () => {
  it('anchors the live state sources in registry order', () => {
    const live = new Map([
      ['memory', 'M'],
      ['date', '2026-03-10 (Tue)'],
      ['message_time', 'now'],
      ['project', 'P'],
    ]);
    expect(createAnchor(live)).toEqual([
      { key: 'project', value: 'P' },
      { key: 'date', value: '2026-03-10 (Tue)' },
      { key: 'memory', value: 'M' },
    ]);
  });

  it('re-anchors keeping the previous order, dropping what is off and appending what is new', () => {
    const previous = [
      { key: 'memory', value: 'old' },
      { key: 'artifacts', value: 'default' },
      { key: 'project', value: 'P' },
    ];
    const live = new Map([
      ['project', 'P2'],
      ['memory', 'new'],
      ['skills', 'S'],
      ['runtime:web_search', 'W'],
    ]);
    expect(reanchor(previous, live)).toEqual([
      { key: 'memory', value: 'new' },
      { key: 'project', value: 'P2' },
      { key: 'skills', value: 'S' },
      { key: 'runtime:web_search', value: 'W' },
    ]);
    expect(reanchor(null, live).map(({ key }) => key)).toEqual([
      'skills',
      'project',
      'runtime:web_search',
      'memory',
    ]);
  });
});

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
        'Current date: 2026-03-09 (Mon)',
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

  it('replaces a changed value and removes one switched off', () => {
    const convo = new Conversation();
    convo.send(base, minutes(0));
    const changed = convo.send({ ...base, project: 'Quote prices in USD.' }, minutes(1));
    expect(last(changed.texts)).toBe(
      '<context_update>\nProject guidance (replaces any earlier version):\nQuote prices in USD.\n</context_update>',
    );
    const off = convo.send({ ...base, project: undefined }, minutes(2));
    expect(last(off.texts)).toBe(
      '<context_update>\nProject guidance no longer applies.\n</context_update>',
    );
    expect(off.plan.currentEntries).toEqual([{ key: 'project', value: null }]);
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

    it('announce exactly one change when they end switched on', () => {
      const convo = new Conversation();
      convo.send(base, minutes(0));
      const { plan, texts } = convo.send({ ...base, artifacts: true }, minutes(1));
      expect(plan.currentEntries).toHaveLength(1);
      expect(texts.filter(Boolean)).toHaveLength(1);
    });

    it('leave no trace when a toggle returns to the anchored value', () => {
      const convo = new Conversation();
      convo.send({ ...base, artifacts: true }, minutes(0));
      convo.send(base, minutes(1));
      const back = convo.send({ ...base, artifacts: true }, minutes(2));
      expect(last(back.texts)).toBe(
        `<context_update>\nArtifacts instructions:\n${ARTIFACTS}\n</context_update>`,
      );
      const again = convo.send({ ...base, artifacts: true }, minutes(3));
      expect(again.plan.currentEntries).toEqual([]);
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

  it('overwrites the record of the regenerated message and leaves earlier turns alone', () => {
    const convo = new Conversation();
    convo.send(base, minutes(0));
    convo.send({ ...base, artifacts: true }, minutes(1));
    const parent = convo.rows[1].messageId;

    const regenerated = convo.send(base, minutes(2), { parentId: parent, reuseId: 'u2' });
    expect(regenerated.plan.currentEntries).toEqual([]);
    expect(convo.rows.find((row) => row.messageId === 'u2')?.contextUpdates).toEqual([]);
    expect(regenerated.texts.filter(Boolean)).toHaveLength(0);

    const next = convo.send(base, minutes(3));
    expect(next.texts.filter(Boolean)).toHaveLength(0);
  });

  it('plans no entries for a continued response', () => {
    const convo = new Conversation();
    convo.send(base, minutes(0));
    const messages = convo.branch(convo.rows[1].messageId);
    const plan = planTurnContext({
      messages,
      conversationAnchor: convo.anchor,
      snapshot: snapshotOf({ ...base, artifacts: true }, minutes(1)),
    });
    expect(plan.currentEntries).toBeUndefined();
    expect(plan.updates.size).toBe(0);
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
        { key: 'date', value: '2026-03-09 (Mon)' },
        { key: 'artifacts', value: 'default' },
        { key: 'skills', value: 'S' },
      ]);
      expect(plan.block).toBe(
        ['P2', WEB_SEARCH_RUNTIME, 'Current date: 2026-03-09 (Mon)', ARTIFACTS, 'S'].join('\n\n'),
      );
      expect(plan.currentEntries).toEqual([]);
      expect(texts.every((text) => text == null)).toBe(true);
    });

    it('dates the new anchor by its turn: the first message after midnight announces nothing', () => {
      const convo = compacted();
      const { plan, texts } = convo.send({ ...base, artifacts: true, project: 'P2' }, minutes(120));
      expect(plan.block).toContain('Current date: 2026-03-10 (Tue)');
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

    it('still shows message sources of messages a summary retains', () => {
      const convo = new Conversation();
      convo.send({ ...base, timestamps: true }, minutes(0));
      convo.send({ ...base, artifacts: true, timestamps: true }, minutes(1));
      const carrier = convo.rows[convo.rows.length - 1];
      carrier.content = [summaryPart('u2')];
      const { texts, messages } = convo.send({ ...base, artifacts: true }, minutes(2));
      const u2 = messages.findIndex((m) => m.messageId === 'u2');
      expect(texts[u2]).toBe(
        '<context_update>\nMessage sent: 2026-03-09 23:01:00 +03:00 (Mon)\n</context_update>',
      );
      expect(texts.slice(0, u2).every((text) => text == null)).toBe(true);
    });

    it('re-anchors a branch from before the boundary to the conversation anchor', () => {
      const convo = compacted();
      const branch = convo.send(base, minutes(3), { parentId: convo.rows[1].messageId });
      expect(branch.plan.anchorTarget).toBeUndefined();
      expect(branch.plan.anchor).toEqual(convo.anchor);
    });
  });

  describe('conversations started before anchors existed', () => {
    it('anchors to the current state and renders the old history unchanged', () => {
      const rows: TurnContextMessage[] = [
        { messageId: 'u1', isCreatedByUser: true },
        { messageId: 'a1', isCreatedByUser: false },
        { messageId: 'u2', isCreatedByUser: true },
      ];
      const plan = planTurnContext({
        messages: rows,
        conversationAnchor: null,
        snapshot: snapshotOf({ ...base, artifacts: true }, minutes(5)),
        currentIndex: 2,
      });
      expect(plan.anchorTarget).toEqual({ messageId: null });
      expect(plan.anchor.map(({ key }) => key)).toContain('artifacts');
      expect(plan.updates.size).toBe(0);
    });

    it('dates the anchor by the turn that sets it, announcing nothing', () => {
      const plan = planTurnContext({
        messages: [
          { messageId: 'u1', isCreatedByUser: true },
          { messageId: 'a1', isCreatedByUser: false },
          { messageId: 'u2', isCreatedByUser: true },
        ],
        conversationAnchor: null,
        snapshot: snapshotOf(base, '2026-03-11T08:00:00.000Z'),
        currentIndex: 2,
      });
      expect(plan.block).toContain('Current date: 2026-03-11 (Wed)');
      expect(plan.updates.size).toBe(0);
    });

    it('orders a compaction anchor by registry when no earlier anchor exists', () => {
      const plan = planTurnContext({
        messages: [
          { messageId: 'u1', isCreatedByUser: true },
          { messageId: 'a1', isCreatedByUser: false, content: [summaryPart()] },
          { messageId: 'u2', isCreatedByUser: true },
        ],
        snapshot: snapshotOf({ ...base, artifacts: true }, minutes(1)),
        currentIndex: 2,
      });
      expect(plan.anchorTarget).toEqual({ messageId: 'a1' });
      expect(plan.anchor.map(({ key }) => key)).toEqual([
        'artifacts',
        'project',
        'runtime:web_search',
        'date',
        'memory',
      ]);
    });
  });

  describe('memory', () => {
    it('announces a changed memory as the entries it added and removed, keeping the system prompt', () => {
      const convo = new Conversation();
      const first = convo.send(base, minutes(0)).plan;
      const changed = convo.send({ ...base, memory: 'Likes tea. Works in logistics.' }, minutes(1));
      expect(changed.plan.block).toBe(first.block);
      expect(last(changed.texts)).toBe(
        '<context_update>\nMemory about the user changed:\nAdded:\nLikes tea. Works in logistics.\nRemoved:\nLikes tea.\n</context_update>',
      );
      expect(changed.plan.memoryTexts).toEqual([
        'Likes tea.',
        'Memory about the user changed:\nAdded:\nLikes tea. Works in logistics.\nRemoved:\nLikes tea.',
      ]);
    });

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

    it('announces nothing when the memory is the same entries in another order or numbering', () => {
      const convo = new Conversation();
      convo.send({ ...base, memory: formatted(entry('a', '1'), entry('b', '2')) }, minutes(0));
      const same = convo.send(
        { ...base, memory: formatted(entry('b', '2'), entry('a', '1')) },
        minutes(1),
      );
      expect(same.plan.currentEntries).toEqual([]);
    });

    it('tracks the memory a later diff starts from through the stored diffs', () => {
      const convo = new Conversation();
      convo.send({ ...base, memory: formatted(entry('a', '1')) }, minutes(0));
      convo.send({ ...base, memory: formatted(entry('a', '1'), entry('b', '2')) }, minutes(1));
      const third = convo.send({ ...base, memory: formatted(entry('b', '2')) }, minutes(2));
      expect(last(third.texts)).toBe(
        `<context_update>\nMemory about the user changed:\nRemoved:\n${entry('a', '1')}\n</context_update>`,
      );
      expect(third.texts[2]).toContain(`Added:\n${entry('b', '2')}`);
    });

    it('states the whole memory when it appears after the anchor', () => {
      const convo = new Conversation();
      convo.send({ ...base, memory: undefined }, minutes(0));
      const memory = formatted(entry('a', '1'));
      const on = convo.send({ ...base, memory }, minutes(1));
      expect(last(on.texts)).toContain(`Memory about the user:\n${memoryInstructions}`);
      expect(last(on.texts)).toContain(entry('a', '1'));
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
        '<context_update>\nCurrent date changed to: 2026-03-10 (Tue)\n</context_update>',
      );
      const later = convo.send(base, minutes(120));
      expect(later.texts.filter(Boolean)).toHaveLength(1);
    });

    it('renders stored dates the same after the user changes timezone', () => {
      const convo = new Conversation();
      convo.send(base, minutes(0));
      const turn2 = convo.send({ ...base, timestamps: true }, minutes(61));
      const moved = convo.send({ ...base, timezone: 'America/New_York' }, minutes(62));
      expect(moved.texts[2]).toBe(turn2.texts[2]);
      /** The user's local date is the previous day in the new timezone. */
      expect(last(moved.texts)).toBe(
        '<context_update>\nCurrent date changed to: 2026-03-09 (Mon)\n</context_update>',
      );
    });

    it('keeps tracking the date the anchored system prompt states after its source is off', () => {
      const convo = new Conversation();
      convo.send(base, minutes(0));
      const quiet = convo.send({ ...base, webSearch: false }, minutes(61));
      expect(last(quiet.texts)).toContain(
        'Runtime context for the `web_search` tool no longer applies.',
      );
      expect(last(quiet.texts)).toContain('Current date changed to: 2026-03-10 (Tue)');
    });

    it('states the current date when a prompt starts stating one mid-conversation', () => {
      const convo = new Conversation();
      convo.send({ project: 'P' }, minutes(0));
      const on = convo.send({ project: 'P', webSearch: true }, minutes(61));
      expect(last(on.texts)).toBe(
        `<context_update>\nRuntime context for the \`web_search\` tool:\n${WEB_SEARCH_RUNTIME}\nCurrent date: 2026-03-10 (Tue)\n</context_update>`,
      );
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

    it('replays the stored context for a continued response and ignores the new retrieval', () => {
      const convo = new Conversation();
      convo.send({ ...base, rag: 'Passage A' }, minutes(0));
      const plan = planTurnContext({
        messages: convo.branch(convo.rows[1].messageId),
        conversationAnchor: convo.anchor,
        snapshot: snapshotOf({ ...base, rag: 'Passage B' }, minutes(1)),
      });
      expect(plan.updates.get(0)).toBe('<context_update>\nPassage A\n</context_update>');
      expect(plan.currentEntries).toBeUndefined();
    });

    it('stores nothing for an empty retrieval', () => {
      const convo = new Conversation();
      const { plan } = convo.send({ ...base, rag: '  \n' }, minutes(0));
      expect(plan.currentEntries).toEqual([]);
    });
  });

  it('ignores stored entries no source owns and entries that repeat what is known', () => {
    const plan = planTurnContext({
      messages: [
        {
          messageId: 'u1',
          isCreatedByUser: true,
          contextUpdates: [
            { key: 'retired_source', value: 'x' },
            { key: 'project', value: 'Quote prices in EUR.' },
          ],
        },
        { messageId: 'u2', isCreatedByUser: true },
      ],
      conversationAnchor: [{ key: 'project', value: 'Quote prices in EUR.' }],
      snapshot: snapshotOf(base, minutes(1)),
      currentIndex: 1,
    });
    expect(plan.updates.has(0)).toBe(false);
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

  it('leaves the system prompt unchanged by later live changes', () => {
    const agent = initialized();
    applyTurnContext(agent, { block: 'Anchored block.' });
    const before = assembleSystemPrompt(agent);
    agent.dynamicToolContextMap = { queued_code_files: 'another.csv', web_search: 'later' };
    expect(assembleSystemPrompt(agent)).toEqual(before);
  });
});
