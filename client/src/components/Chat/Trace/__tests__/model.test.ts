import type { TTraceRecord } from 'librechat-data-provider';
import type { TraceFilter } from '../model';
import {
  spanOf,
  stepKey,
  turnKey,
  boundsOf,
  panWindow,
  fitWindow,
  zoomWindow,
  assignLanes,
  clampWindow,
  flattenRows,
  minimumSpan,
  rebaseWindow,
  sequenceLane,
  buildTraceModel,
  collapsibleKeys,
} from '../model';

const BASE = Date.UTC(2026, 8, 12, 11, 30, 0);
const at = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();

function record(overrides: Partial<TTraceRecord> & Pick<TTraceRecord, 'id'>): TTraceRecord {
  return {
    traceId: 'trace-1',
    messageId: 'response-1',
    parentId: null,
    kind: 'span',
    name: overrides.id,
    startTime: at(0),
    endTime: at(1000),
    status: 'ok',
    ...overrides,
  };
}

const noFilter: TraceFilter = {
  collapsed: new Set<string>(),
  query: '',
  window: null,
  scale: 'time',
};
const rowKeys = (rows: ReturnType<typeof flattenRows>) => rows.map((row) => row.key);
const step = (anchorId: string, messageId = 'response-1') => stepKey(messageId, 'run', anchorId);

/** An agent turn as the SDK exports it: an agent span holding model calls, tools, and chain spans. */
const agentTurn: TTraceRecord[] = [
  record({ id: 'root', kind: 'agent', name: 'AgentGraph', startTime: at(0), endTime: at(10_000) }),
  record({ id: 'chain', parentId: 'root', name: 'chain', startTime: at(0), endTime: at(9000) }),
  record({
    id: 'llm-1',
    parentId: 'chain',
    kind: 'generation',
    name: 'llm',
    model: 'gpt-5',
    startTime: at(100),
    endTime: at(2000),
  }),
  record({ id: 'dispatch', parentId: 'chain', name: 'tool-dispatch', startTime: at(2100) }),
  record({
    id: 'search-1',
    parentId: 'dispatch',
    kind: 'tool',
    name: 'web_search',
    startTime: at(2200),
    endTime: at(3000),
  }),
  record({
    id: 'fetch',
    parentId: 'search-1',
    name: 'fetch',
    startTime: at(2300),
    endTime: at(2900),
  }),
  record({
    id: 'search-2',
    parentId: 'dispatch',
    kind: 'tool',
    name: 'web_search',
    startTime: at(3100),
    endTime: at(3500),
  }),
  record({ id: 'checkpoint', parentId: 'chain', name: 'checkpoint', startTime: at(3600) }),
  record({
    id: 'llm-2',
    parentId: 'chain',
    kind: 'generation',
    name: 'llm',
    model: 'gpt-5',
    startTime: at(4000),
    endTime: at(9000),
  }),
  record({
    id: 'title-llm',
    traceId: 'trace-title',
    kind: 'generation',
    name: 'llm',
    origin: 'title',
    startTime: at(9500),
    endTime: at(10_000),
  }),
];

describe('buildTraceModel', () => {
  it('nests records under their parents and orders turns and siblings by start', () => {
    const model = buildTraceModel(
      [
        record({
          id: 'late-turn-root',
          messageId: 'response-2',
          startTime: at(5000),
          endTime: at(6000),
        }),
        record({
          id: 'tool',
          parentId: 'root',
          kind: 'tool',
          startTime: at(600),
          endTime: at(900),
        }),
        record({
          id: 'llm',
          parentId: 'root',
          kind: 'generation',
          startTime: at(100),
          endTime: at(500),
        }),
        record({ id: 'root', kind: 'agent', startTime: at(0), endTime: at(1000) }),
      ],
      'full',
    );

    expect(model.turns.map((turn) => turn.messageId)).toEqual(['response-1', 'response-2']);
    expect(model.nodes.get('root')?.childIds).toEqual(['llm', 'tool']);
    expect(model.nodes.get('tool')?.depth).toBe(1);
    expect(rowKeys(flattenRows(model, noFilter))).toEqual([
      turnKey('response-1'),
      'root',
      'llm',
      'tool',
      turnKey('response-2'),
      'late-turn-root',
    ]);
  });

  it('keeps records with a missing, cross-turn or cyclic parent as roots instead of dropping them', () => {
    const model = buildTraceModel(
      [
        record({ id: 'orphan', parentId: 'not-loaded' }),
        record({ id: 'other-turn', messageId: 'response-2', parentId: 'orphan' }),
        record({ id: 'a', parentId: 'b', startTime: at(10) }),
        record({ id: 'b', parentId: 'a', startTime: at(20) }),
        record({ id: 'self', parentId: 'self', startTime: at(30) }),
      ],
      'full',
    );

    const keys = rowKeys(flattenRows(model, noFilter));
    expect(new Set(keys)).toEqual(
      new Set([
        turnKey('response-1'),
        turnKey('response-2'),
        'orphan',
        'other-turn',
        'a',
        'b',
        'self',
      ]),
    );
    expect(keys).toHaveLength(7);
    expect(model.nodes.get('other-turn')?.parentId).toBeNull();
    expect(model.nodes.get('self')?.parentId).toBeNull();
    const cycle = [model.nodes.get('a'), model.nodes.get('b')];
    expect(cycle.filter((node) => node?.parentId == null)).toHaveLength(1);
  });

  it('keeps a running record as a start with no invented duration', () => {
    const model = buildTraceModel([
      record({ id: 'root', startTime: at(0), endTime: at(2000) }),
      record({
        id: 'running',
        parentId: 'root',
        status: 'running',
        startTime: at(3000),
        endTime: undefined,
      }),
    ]);

    expect(model.nodes.get('running')?.end).toBeUndefined();
    expect(model.end).toBe(BASE + 3000);
    expect(model.summary.running).toBe(1);
  });

  it('clamps first-token time inside the record and repairs an end before its start', () => {
    const model = buildTraceModel([
      record({
        id: 'llm',
        kind: 'generation',
        startTime: at(1000),
        endTime: at(3000),
        completionStartTime: at(5000),
      }),
      record({ id: 'backwards', startTime: at(1000), endTime: at(500) }),
      record({ id: 'invalid', startTime: 'not a date' }),
    ]);

    expect(model.nodes.get('llm')?.firstToken).toBe(BASE + 3000);
    expect(model.nodes.get('backwards')?.end).toBe(BASE + 1000);
    expect(model.nodes.has('invalid')).toBe(false);
  });

  it('summarizes generations, tools, tokens, cost and errors', () => {
    const model = buildTraceModel([
      record({ id: 'root', kind: 'agent', startTime: at(0), endTime: at(4000) }),
      record({
        id: 'llm-1',
        parentId: 'root',
        kind: 'generation',
        usage: { input: 100, output: 20, total: 120 },
        cost: 0.01,
      }),
      record({
        id: 'llm-2',
        parentId: 'root',
        kind: 'generation',
        usage: { input: 10, output: 5 },
        cost: 0.005,
      }),
      record({ id: 'tool', parentId: 'root', kind: 'tool', status: 'error' }),
    ]);

    expect(model.summary).toEqual({
      duration: 4000,
      turns: 1,
      generations: 2,
      labels: 0,
      toolCalls: 1,
      errors: 1,
      running: 0,
      inputTokens: 110,
      outputTokens: 25,
      totalTokens: 135,
      cost: expect.closeTo(0.015),
    });
    expect(model.turns[0].errorCount).toBe(1);
  });

  it('totals cost per step and per response under the same rule as the whole trace', () => {
    const model = buildTraceModel([
      record({ id: 'llm-1', kind: 'generation', cost: 0.01, startTime: at(0) }),
      record({ id: 'tool', kind: 'tool', cost: 0.002, startTime: at(100) }),
      record({ id: 'llm-2', kind: 'generation', startTime: at(1000) }),
      record({
        id: 'other',
        messageId: 'response-2',
        kind: 'generation',
        cost: 0.5,
        startTime: at(5000),
      }),
      record({
        id: 'other-title',
        messageId: 'response-2',
        traceId: 'title',
        origin: 'title',
        kind: 'generation',
        cost: 0.001,
        startTime: at(5100),
      }),
    ]);
    const [first, second] = model.turns;
    const stepCosts = (turn: typeof first) =>
      turn.stepKeys.map((key) => model.steps.get(key)?.cost);

    expect(stepCosts(first)).toEqual([expect.closeTo(0.012), undefined]);
    /** One unpriced model call leaves its step, its response and the trace without a total. */
    expect(first.cost).toBeUndefined();
    expect(model.summary.cost).toBeUndefined();
    /** A response's total counts its title run, which its own steps do not. */
    expect(stepCosts(second)).toEqual([expect.closeTo(0.5), expect.closeTo(0.001)]);
    expect(second.cost).toBeCloseTo(0.501);
  });

  it('gives no cost to a response the record limit cut, whose loaded records are not all it spent', () => {
    const model = buildTraceModel([
      record({ id: 'llm', parentId: 'not-loaded', kind: 'generation', cost: 0.2 }),
      record({ id: 'whole', messageId: 'response-2', kind: 'generation', cost: 0.5 }),
    ]);
    const [cut, whole] = model.turns;

    expect(cut.split).toBe(true);
    expect(cut.cost).toBeUndefined();
    expect(model.steps.get(cut.stepKeys[0])?.cost).toBeCloseTo(0.2);
    expect(whole.cost).toBeCloseTo(0.5);
  });

  it('gives the oldest loaded response no cost while older records remain, parents intact or not', () => {
    /** A page that ended between a response's traces: its title run loaded, its own run not. */
    const records = [
      record({
        id: 'title',
        traceId: 'title-trace',
        origin: 'title',
        kind: 'generation',
        cost: 0.001,
      }),
      record({
        id: 'newer',
        messageId: 'response-2',
        kind: 'generation',
        cost: 0.5,
        startTime: at(9000),
      }),
    ];
    const paging = buildTraceModel(records, 'simple', true);
    const settled = buildTraceModel(records, 'simple', false);

    expect(paging.turns[0].split).toBe(false);
    expect(paging.turns.map((turn) => turn.cost)).toEqual([undefined, expect.closeTo(0.5)]);
    expect(settled.turns.map((turn) => turn.cost)).toEqual([
      expect.closeTo(0.001),
      expect.closeTo(0.5),
    ]);
  });

  it('counts what a step spent in records the simple mode rolls out of sight', () => {
    const records = [
      record({ id: 'tool', kind: 'tool', cost: 0.01, startTime: at(0) }),
      record({ id: 'hidden-span', parentId: 'tool', cost: 0.04, startTime: at(10) }),
      record({
        id: 'nested-llm',
        parentId: 'hidden-span',
        kind: 'generation',
        cost: 0.1,
        startTime: at(20),
      }),
    ];
    for (const mode of ['simple', 'full'] as const) {
      const model = buildTraceModel(records, mode);
      expect(model.nodes.get('hidden-span')?.shown).toBe(mode === 'full');
      expect(model.steps.get(model.turns[0].stepKeys[0])?.cost).toBeCloseTo(0.15);
      expect(model.turns[0].cost).toBeCloseTo(0.15);
    }
  });

  it('withholds the cost total when any model call has no price, with or without usage', () => {
    const priced = record({ id: 'priced', kind: 'generation', usage: { total: 100 }, cost: 0.02 });
    const withUsage = buildTraceModel([
      priced,
      record({ id: 'unpriced', kind: 'generation', usage: { total: 50 } }),
    ]);
    const withoutUsage = buildTraceModel([priced, record({ id: 'bare', kind: 'generation' })]);
    const toolOnly = buildTraceModel([priced, record({ id: 'tool', kind: 'tool' })]);

    expect(withUsage.summary.cost).toBeUndefined();
    expect(withUsage.summary.totalTokens).toBe(150);
    expect(withoutUsage.summary.cost).toBeUndefined();
    expect(toolOnly.summary.cost).toBeCloseTo(0.02);
  });

  it('keeps the last copy of a record loaded twice', () => {
    const model = buildTraceModel([
      record({ id: 'root', status: 'running', endTime: undefined }),
      record({ id: 'root', status: 'ok' }),
    ]);

    expect(model.nodes.size).toBe(1);
    expect(model.nodes.get('root')?.record.status).toBe('ok');
  });
});

describe('simple mode', () => {
  const model = buildTraceModel(agentTurn);

  it('lists only model calls and tools, each hung from its nearest listed ancestor', () => {
    const shown = [...model.nodes.values()].filter((node) => node.shown).map((n) => n.record.id);
    expect(shown.sort()).toEqual(['llm-1', 'llm-2', 'search-1', 'search-2', 'title-llm']);
    expect(model.nodes.get('search-1')?.viewParentId).toBeNull();
    expect(model.nodes.get('fetch')?.shown).toBe(false);
    expect(model.nodes.get('llm-1')?.depth).toBe(0);
  });

  it('starts a step at each model call and gives it the tools that ran after it', () => {
    const turn = model.turns[0];
    expect(turn.steps).toBe(2);
    expect(turn.stepKeys).toEqual([
      step('llm-1'),
      step('llm-2'),
      stepKey('response-1', 'title', 'title-llm'),
    ]);
    expect(model.steps.get(step('llm-1'))).toMatchObject({
      index: 1,
      origin: 'run',
      generationId: 'llm-1',
      rootIds: ['llm-1', 'search-1', 'search-2'],
      start: BASE + 100,
      end: BASE + 3500,
      recordCount: 3,
      toolCalls: 2,
    });
    expect([...(model.steps.get(step('llm-1'))?.toolNames ?? [])]).toEqual([['web_search', 2]]);
    expect(model.steps.get(step('llm-2'))).toMatchObject({
      generationId: 'llm-2',
      rootIds: ['llm-2'],
    });
    expect(model.steps.get(stepKey('response-1', 'title', 'title-llm'))).toMatchObject({
      origin: 'title',
      rootIds: ['title-llm'],
    });
  });

  it('keeps a failed span visible so an error is never hidden by the roll-up', () => {
    const failed = buildTraceModel([
      record({ id: 'root', kind: 'agent', startTime: at(0), endTime: at(3000) }),
      record({
        id: 'llm',
        parentId: 'root',
        kind: 'generation',
        startTime: at(0),
        endTime: at(1000),
      }),
      record({
        id: 'dispatch',
        parentId: 'root',
        name: 'tool-dispatch',
        status: 'error',
        statusMessage: 'Host tool execution failed',
        startTime: at(1500),
        endTime: at(1600),
      }),
    ]);

    expect(rowKeys(flattenRows(failed, noFilter))).toEqual([
      turnKey('response-1'),
      step('llm'),
      'llm',
      'dispatch',
    ]);
    expect(failed.steps.get(step('llm'))?.errorCount).toBe(1);
  });

  it('gives tools that ran before any model call their own step, and a turn with no model call one step', () => {
    const leading = buildTraceModel([
      record({ id: 'early', kind: 'tool', startTime: at(0), endTime: at(100) }),
      record({ id: 'llm', kind: 'generation', startTime: at(200), endTime: at(300) }),
      record({ id: 'late', kind: 'tool', startTime: at(400), endTime: at(500) }),
      record({ id: 'llm-2', kind: 'generation', startTime: at(600), endTime: at(700) }),
    ]);
    const toolsOnly = buildTraceModel([record({ id: 'only', kind: 'tool' })]);

    expect(leading.steps.get(step('early'))?.rootIds).toEqual(['early']);
    expect(leading.steps.get(step('llm'))?.rootIds).toEqual(['llm', 'late']);
    expect([...(leading.steps.get(step('llm'))?.toolNames.keys() ?? [])]).toEqual(['late']);
    expect(leading.steps.get(step('llm-2'))?.rootIds).toEqual(['llm-2']);
    expect(leading.turns[0].steps).toBe(3);
    expect(toolsOnly.turns[0].steps).toBe(1);
    expect(toolsOnly.steps.get(step('only'))).toMatchObject({
      generationId: null,
      rootIds: ['only'],
    });
  });

  it('keeps a failed wrapper visible without folding the model calls beneath it into one step', () => {
    const failed = buildTraceModel([
      record({ id: 'root', kind: 'agent', status: 'error', startTime: at(0), endTime: at(3000) }),
      record({
        id: 'llm-1',
        parentId: 'root',
        kind: 'generation',
        startTime: at(100),
        endTime: at(1000),
      }),
      record({
        id: 'llm-2',
        parentId: 'root',
        kind: 'generation',
        startTime: at(1500),
        endTime: at(2500),
      }),
    ]);

    expect(failed.turns[0].steps).toBe(2);
    expect(failed.nodes.get('llm-1')?.viewParentId).toBeNull();
    expect(rowKeys(flattenRows(failed, noFilter))).toEqual([
      turnKey('response-1'),
      step('llm-1'),
      'root',
      'llm-1',
      step('llm-2'),
      'llm-2',
    ]);
  });

  it('carries a sequence window across a page that renumbers the records', () => {
    const previous = buildTraceModel([
      record({ id: 'a', kind: 'generation', startTime: at(0), endTime: at(100) }),
      record({ id: 'b', kind: 'generation', startTime: at(200), endTime: at(300) }),
    ]);
    const withOlder = buildTraceModel([
      record({ id: 'z', kind: 'generation', startTime: at(-500), endTime: at(-400) }),
      record({ id: 'a', kind: 'generation', startTime: at(0), endTime: at(100) }),
      record({ id: 'b', kind: 'generation', startTime: at(200), endTime: at(300) }),
    ]);
    const without = buildTraceModel([
      record({ id: 'b', kind: 'generation', startTime: at(200), endTime: at(300) }),
    ]);

    expect(rebaseWindow({ start: 0, end: 1 }, previous, withOlder, 'sequence')).toEqual({
      start: 1,
      end: 2,
    });
    expect(rebaseWindow({ start: 0, end: 1 }, previous, without, 'sequence')).toBeNull();
    const inTime = { start: BASE, end: BASE + 50 };
    expect(rebaseWindow(inTime, previous, previous, 'time')).toBe(inTime);
  });

  it('orders a model call before the tool it asked for when both start in the same millisecond', () => {
    const tied = buildTraceModel([
      record({ id: 'a-tool', kind: 'tool', name: 'web_search', startTime: at(0), endTime: at(50) }),
      record({ id: 'b-llm', kind: 'generation', startTime: at(0), endTime: at(10) }),
    ]);

    expect(tied.turns[0].steps).toBe(1);
    expect(tied.steps.get(step('b-llm'))?.rootIds).toEqual(['b-llm', 'a-tool']);
    expect(tied.nodes.get('b-llm')?.sequence).toBe(0);
  });

  it('shows a title run recorded as a plain span as its own Title step', () => {
    const titled = buildTraceModel([
      record({ id: 'llm', kind: 'generation', startTime: at(0), endTime: at(100) }),
      record({
        id: 'title-chain',
        traceId: 'trace-title',
        name: 'chain',
        origin: 'title',
        startTime: at(200),
        endTime: at(300),
      }),
    ]);

    expect(titled.nodes.get('title-chain')?.shown).toBe(true);
    expect(titled.turns[0].steps).toBe(1);
    expect(rowKeys(flattenRows(titled, noFilter))).toEqual([
      turnKey('response-1'),
      step('llm'),
      'llm',
      stepKey('response-1', 'title', 'title-chain'),
      'title-chain',
    ]);
  });

  it.each(['simple', 'full'] as const)(
    'bounds ancestry work for deeply nested failed wrappers in %s mode',
    (mode) => {
      const count = 3000;
      let kindReads = 0;
      const records = Array.from({ length: count }, (_, index) => {
        const entry = record({
          id: `failed-${index}`,
          parentId: index > 0 ? `failed-${index - 1}` : null,
          status: 'error',
        });
        Object.defineProperty(entry, 'kind', {
          get: () => {
            kindReads++;
            return 'span';
          },
        });
        return entry;
      }).reverse();
      const nested = buildTraceModel(records, mode);
      expect(nested.count).toBe(count);
      expect(nested.turns[0].steps).toBe(1);
      expect([...nested.steps.values()][0].recordCount).toBe(count);
      expect(kindReads).toBeLessThan(count * 60);
    },
  );

  it('keeps parallel tools in their own lanes across wrapper pagination', () => {
    const records = [
      record({ id: 'root', kind: 'agent', startTime: at(0), endTime: at(10_000) }),
      record({ id: 'lane-a', parentId: 'root', startTime: at(0), endTime: at(5000) }),
      record({ id: 'lane-b', parentId: 'root', startTime: at(0), endTime: at(5000) }),
      record({
        id: 'llm-a',
        parentId: 'lane-a',
        kind: 'generation',
        startTime: at(100),
        endTime: at(1000),
      }),
      record({
        id: 'llm-b',
        parentId: 'lane-b',
        kind: 'generation',
        startTime: at(200),
        endTime: at(1200),
      }),
      record({
        id: 'tool-a',
        parentId: 'lane-a',
        kind: 'tool',
        startTime: at(1100),
        endTime: at(2000),
      }),
      record({
        id: 'tool-b',
        parentId: 'lane-b',
        kind: 'tool',
        startTime: at(1300),
        endTime: at(2100),
      }),
    ];
    for (const mode of ['simple', 'full'] as const) {
      for (const page of [records.slice(3), records.slice(1), records]) {
        const lanes = buildTraceModel(page, mode);
        expect(lanes.steps.get(step('llm-a'))?.rootIds).toEqual(['llm-a', 'tool-a']);
        expect(lanes.steps.get(step('llm-b'))?.rootIds).toEqual(['llm-b', 'tool-b']);
      }
    }
  });

  it('keeps unrelated unloaded parents separate until their connecting wrapper arrives', () => {
    const partial = [
      record({ id: 'llm', parentId: 'chain', kind: 'generation', startTime: at(100) }),
      record({ id: 'tool', parentId: 'dispatch', kind: 'tool', startTime: at(200) }),
    ];
    const before = buildTraceModel(partial);
    expect(before.steps.get(step('llm'))?.rootIds).toEqual(['llm']);
    expect(before.steps.get(step('tool'))?.rootIds).toEqual(['tool']);
    const after = buildTraceModel([
      record({ id: 'root', kind: 'agent' }),
      record({ id: 'chain', parentId: 'root' }),
      record({ id: 'dispatch', parentId: 'chain' }),
      ...partial,
    ]);
    expect(after.steps.get(step('llm'))?.rootIds).toEqual(['llm', 'tool']);
    expect(after.turns[0].steps).toBe(1);
  });

  it('keeps a tool whose lane has no loaded model call in a step of its own lane', () => {
    const paged = buildTraceModel([
      record({ id: 'root', kind: 'agent', startTime: at(0), endTime: at(10_000) }),
      record({ id: 'lane-a', parentId: 'root', startTime: at(0), endTime: at(5000) }),
      record({ id: 'lane-b', parentId: 'root', startTime: at(0), endTime: at(5000) }),
      record({
        id: 'llm-a',
        parentId: 'lane-a',
        kind: 'generation',
        startTime: at(100),
        endTime: at(1000),
      }),
      record({
        id: 'tool-b',
        parentId: 'lane-b',
        kind: 'tool',
        startTime: at(1300),
        endTime: at(2100),
      }),
    ]);

    expect(paged.steps.get(step('llm-a'))?.rootIds).toEqual(['llm-a']);
    expect(paged.steps.get(step('tool-b'))?.rootIds).toEqual(['tool-b']);
  });

  it('lists the wrappers of a turn that has no model call, tool or failure yet', () => {
    const starting = buildTraceModel([
      record({
        id: 'root',
        kind: 'agent',
        status: 'running',
        startTime: at(0),
        endTime: undefined,
      }),
      record({
        id: 'chain',
        parentId: 'root',
        status: 'running',
        startTime: at(0),
        endTime: undefined,
      }),
    ]);

    expect(starting.nodes.get('root')?.shown).toBe(true);
    expect(starting.nodes.get('chain')?.shown).toBe(false);
    expect(rowKeys(flattenRows(starting, noFilter))).toEqual([
      turnKey('response-1'),
      step('root'),
      'root',
    ]);
  });

  it('keeps a step key stable when an older page adds an earlier model call', () => {
    const newest = buildTraceModel([
      record({ id: 'llm-2', kind: 'generation', startTime: at(4000), endTime: at(5000) }),
    ]);
    const complete = buildTraceModel([
      record({ id: 'llm-1', kind: 'generation', startTime: at(0), endTime: at(1000) }),
      record({ id: 'llm-2', kind: 'generation', startTime: at(4000), endTime: at(5000) }),
    ]);

    expect(newest.turns[0].stepKeys).toEqual([step('llm-2')]);
    expect(newest.steps.get(step('llm-2'))?.index).toBe(1);
    expect(complete.turns[0].stepKeys).toEqual([step('llm-1'), step('llm-2')]);
    expect(complete.steps.get(step('llm-2'))?.index).toBe(2);
  });

  it('numbers shown records in ledger order for the sequence scale', () => {
    const order = ['llm-1', 'search-1', 'search-2', 'llm-2', 'title-llm'];
    expect(order.map((id) => model.nodes.get(id)?.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(model.count).toBe(5);
    expect(model.steps.get(step('llm-1'))?.sequence).toEqual({ start: 0, end: 3 });
    expect(model.turns[0].sequence).toEqual({ start: 0, end: 5 });
    expect(spanOf(model.nodes.get('search-2') as never, 'sequence')).toEqual({ start: 2, end: 3 });
    expect(boundsOf(model, 'sequence')).toEqual({ start: 0, end: 5 });
    expect(boundsOf(model, 'time')).toEqual({ start: BASE, end: BASE + 10_000 });
  });

  it('lays rows out as turn, steps, then records', () => {
    const rows = flattenRows(model, noFilter);
    expect(rows.map((row) => [row.key, row.level])).toEqual([
      [turnKey('response-1'), 1],
      [step('llm-1'), 2],
      ['llm-1', 3],
      ['search-1', 3],
      ['search-2', 3],
      [step('llm-2'), 2],
      ['llm-2', 3],
      [stepKey('response-1', 'title', 'title-llm'), 2],
      ['title-llm', 3],
    ]);
    expect(rows[1]).toMatchObject({ type: 'step', position: 1, setSize: 3 });
    expect(rows[2]).toMatchObject({ type: 'record', position: 1, setSize: 3 });
  });

  it('folds a step and a turn, and offers steps as collapsible keys', () => {
    expect(
      rowKeys(flattenRows(model, { ...noFilter, collapsed: new Set([step('llm-1')]) })),
    ).toEqual([
      turnKey('response-1'),
      step('llm-1'),
      step('llm-2'),
      'llm-2',
      stepKey('response-1', 'title', 'title-llm'),
      'title-llm',
    ]);
    expect(
      rowKeys(flattenRows(model, { ...noFilter, collapsed: new Set([turnKey('response-1')]) })),
    ).toEqual([turnKey('response-1')]);
    expect(new Set(collapsibleKeys(model))).toEqual(
      new Set([
        turnKey('response-1'),
        step('llm-1'),
        step('llm-2'),
        stepKey('response-1', 'title', 'title-llm'),
      ]),
    );
  });

  it('focuses the ledger on a record range on the sequence scale', () => {
    const rows = flattenRows(model, {
      ...noFilter,
      scale: 'sequence',
      window: { start: 1, end: 3 },
    });

    expect(rowKeys(rows)).toEqual([turnKey('response-1'), step('llm-1'), 'search-1', 'search-2']);
  });

  it('shows every span again in full mode', () => {
    const full = buildTraceModel(agentTurn, 'full');
    expect(rowKeys(flattenRows(full, noFilter))).toEqual([
      turnKey('response-1'),
      'root',
      'chain',
      'llm-1',
      'dispatch',
      'search-1',
      'fetch',
      'search-2',
      'checkpoint',
      'llm-2',
      'title-llm',
    ]);
    expect(full.nodes.get('fetch')?.depth).toBe(4);
    expect(full.turns[0].steps).toBe(2);
    expect(full.count).toBe(10);
  });
});

describe('flattenRows', () => {
  const model = buildTraceModel(
    [
      record({ id: 'root', kind: 'agent', startTime: at(0), endTime: at(10_000) }),
      record({
        id: 'llm',
        parentId: 'root',
        kind: 'generation',
        model: 'gpt-5',
        startTime: at(0),
        endTime: at(2000),
      }),
      record({
        id: 'tool',
        parentId: 'root',
        kind: 'tool',
        name: 'web_search',
        startTime: at(5000),
        endTime: at(6000),
      }),
      record({
        id: 'nested',
        parentId: 'tool',
        name: 'fetch',
        startTime: at(5100),
        endTime: at(5900),
      }),
    ],
    'full',
  );

  it('places each row among its visible siblings rather than the whole list', () => {
    const placements = flattenRows(model, noFilter).map(({ key, position, setSize }) => [
      key,
      position,
      setSize,
    ]);

    expect(placements).toEqual([
      [turnKey('response-1'), 1, 1],
      ['root', 1, 1],
      ['llm', 1, 2],
      ['tool', 2, 2],
      ['nested', 1, 1],
    ]);
    expect(
      flattenRows(model, { ...noFilter, query: 'fetch' }).find((row) => row.key === 'tool'),
    ).toMatchObject({ position: 1, setSize: 1 });
  });

  it('hides the descendants of a collapsed record and turn', () => {
    expect(rowKeys(flattenRows(model, { ...noFilter, collapsed: new Set(['tool']) }))).toEqual([
      turnKey('response-1'),
      'root',
      'llm',
      'tool',
    ]);
    expect(
      rowKeys(flattenRows(model, { ...noFilter, collapsed: new Set([turnKey('response-1')]) })),
    ).toEqual([turnKey('response-1')]);
  });

  it('keeps search matches and their ancestors, even inside collapsed parents', () => {
    const rows = flattenRows(model, {
      ...noFilter,
      collapsed: new Set(['root', 'tool']),
      query: 'FETCH',
    });

    expect(rowKeys(rows)).toEqual([turnKey('response-1'), 'root', 'tool', 'nested']);
  });

  it('matches on model names', () => {
    expect(rowKeys(flattenRows(model, { ...noFilter, query: 'gpt-5' }))).toEqual([
      turnKey('response-1'),
      'root',
      'llm',
    ]);
  });

  it('focuses the ledger on records active at any point in the interval', () => {
    const rows = flattenRows(model, {
      ...noFilter,
      window: { start: BASE + 5500, end: BASE + 7000 },
    });

    expect(rowKeys(rows)).toEqual([turnKey('response-1'), 'root', 'tool', 'nested']);
  });

  it('matches the localized labels a row shows rather than internal kind names', () => {
    const labelsFor = (entry: TTraceRecord) => [
      entry.kind === 'generation' ? 'Modellaufruf' : 'Schritt',
      entry.status === 'ok' ? 'Abgeschlossen' : 'Fehler',
    ];

    expect(rowKeys(flattenRows(model, { ...noFilter, query: 'modellauf', labelsFor }))).toEqual([
      turnKey('response-1'),
      'root',
      'llm',
    ]);
    expect(flattenRows(model, { ...noFilter, query: 'generation', labelsFor })).toEqual([]);
  });

  it('drops turns with nothing left to show', () => {
    expect(flattenRows(model, { ...noFilter, query: 'no such record' })).toEqual([]);
  });

  it('offers every turn and parent as a collapsible key', () => {
    expect(new Set(collapsibleKeys(model))).toEqual(
      new Set([turnKey('response-1'), 'root', 'tool']),
    );
  });
});

describe('windows', () => {
  const bounds = { start: BASE, end: BASE + 10_000 };

  it('clamps a window inside the trace and clears it when it covers everything', () => {
    expect(clampWindow({ start: BASE - 5000, end: BASE + 1000 }, bounds)).toEqual({
      start: BASE,
      end: BASE + 6000,
    });
    expect(clampWindow({ start: BASE - 1, end: BASE + 20_000 }, bounds)).toBeNull();
  });

  it('fits a window to a trace that shrank, and drops one that no longer covers it', () => {
    const inside = { start: BASE + 1000, end: BASE + 2000 };
    expect(fitWindow(inside, bounds)).toBe(inside);
    expect(fitWindow({ start: BASE - 3000, end: BASE + 2000 }, bounds)).toEqual({
      start: BASE,
      end: BASE + 2000,
    });
    expect(fitWindow({ start: BASE - 3000, end: BASE - 1000 }, bounds)).toBeNull();
    expect(fitWindow({ start: BASE - 3000, end: BASE }, bounds)).toBeNull();
  });

  it('zooms around an anchor and pans within bounds', () => {
    const zoomed = zoomWindow(bounds, null, 0.5, BASE + 2000);
    expect(zoomed).toEqual({ start: BASE + 1000, end: BASE + 6000 });
    expect(zoomWindow(bounds, zoomed, 2, BASE + 2000)).toBeNull();
    expect(panWindow(bounds, { start: BASE + 9000, end: BASE + 10_000 }, 1)).toEqual({
      start: BASE + 9000,
      end: BASE + 10_000,
    });
    expect(panWindow(bounds, { start: BASE + 1000, end: BASE + 2000 }, -1)).toEqual({
      start: BASE + 900,
      end: BASE + 1900,
    });
  });

  it('never zooms below one record on the sequence scale', () => {
    const records = { start: 0, end: 8 };
    expect(minimumSpan(records, 'sequence')).toBe(1);
    expect(minimumSpan(bounds, 'time')).toBe(10);
    expect(zoomWindow(records, { start: 3, end: 4 }, 0.5, 3.5, 1)).toEqual({ start: 3, end: 4 });
  });
});

describe('lanes', () => {
  it('reuses a lane once its record ends and caps the lane count', () => {
    const model = buildTraceModel(
      [
        record({ id: 'a', startTime: at(0), endTime: at(1000) }),
        record({ id: 'b', startTime: at(500), endTime: at(1500) }),
        record({ id: 'c', startTime: at(1000), endTime: at(2000) }),
        record({ id: 'd', startTime: at(1200), endTime: at(1300) }),
      ],
      'full',
    );

    const lanes = assignLanes(model, 2);
    expect(lanes.get('a')).toBe(0);
    expect(lanes.get('b')).toBe(1);
    expect(lanes.get('c')).toBe(0);
    expect(lanes.get('d')).toBe(1);
  });

  it('packs only the records the mode shows', () => {
    const model = buildTraceModel([
      record({ id: 'span', startTime: at(0), endTime: at(1000) }),
      record({ id: 'llm', kind: 'generation', startTime: at(500), endTime: at(1500) }),
    ]);

    expect(assignLanes(model, 2).get('llm')).toBe(0);
    expect(assignLanes(model, 2).has('span')).toBe(false);
  });

  it('separates kinds on the sequence scale', () => {
    expect(sequenceLane(record({ id: 'g', kind: 'generation' }))).toBe(0);
    expect(sequenceLane(record({ id: 't', kind: 'tool' }))).toBe(1);
    expect(sequenceLane(record({ id: 'e', kind: 'event' }))).toBe(2);
  });
});

/** A response as the agents SDK exports it: wrappers around each model call, tool rounds the host ran, label calls. */
const sdkRun: TTraceRecord[] = [
  record({ id: 'run', kind: 'agent', role: 'run', name: 'AgentGraph', endTime: at(9000) }),
  record({
    id: 'scout',
    parentId: 'run',
    role: 'agent',
    agentId: 'agent_scout',
    name: 'agent_scout',
    endTime: at(9000),
  }),
  record({ id: 'graph', parentId: 'scout', kind: 'agent', role: 'run', name: 'AgentGraph' }),
  record({ id: 'node-1', parentId: 'graph', kind: 'agent', role: 'plumbing', name: 'agent' }),
  record({
    id: 'llm-1',
    parentId: 'node-1',
    kind: 'generation',
    role: 'model',
    name: 'llm',
    startTime: at(100),
    endTime: at(1000),
    usage: { input: 100, output: 10, total: 110 },
  }),
  record({
    id: 'label-1',
    parentId: 'graph',
    kind: 'generation',
    role: 'stepLabel',
    name: 'StepLabel',
    startTime: at(1050),
    endTime: at(1400),
    usage: { input: 20, output: 5, total: 25 },
  }),
  record({
    id: 'round-1',
    parentId: 'graph',
    role: 'tools',
    name: 'tool-dispatch',
    startTime: at(1100),
    endTime: at(3000),
  }),
  record({ id: 'node-2', parentId: 'graph', kind: 'agent', role: 'plumbing', name: 'agent' }),
  record({
    id: 'llm-2',
    parentId: 'node-2',
    kind: 'generation',
    role: 'model',
    name: 'llm',
    startTime: at(3100),
    endTime: at(4000),
    usage: { input: 200, output: 20, total: 220 },
  }),
];

describe('roles', () => {
  const model = buildTraceModel(sdkRun, 'simple');
  const [turn] = model.turns;

  it('counts a label call as spend, never as a model call or a step of the response', () => {
    expect(turn.steps).toBe(2);
    expect(turn.generations).toBe(2);
    expect(turn.labels).toBe(1);
    expect(model.summary).toMatchObject({ generations: 2, labels: 1, totalTokens: 355 });
  });

  it('lists a tool round the host ran and the label beside the model call that led to them', () => {
    const first = model.steps.get(turn.stepKeys[0]);
    expect(first?.generationId).toBe('llm-1');
    expect(first?.rootIds).toEqual(['llm-1', 'label-1', 'round-1']);
    expect(model.nodes.get('round-1')?.shown).toBe(true);
    expect(model.nodes.get('node-1')?.shown).toBe(false);
    expect(sequenceLane(sdkRun[6])).toBe(1);
    expect(sequenceLane(sdkRun[5])).toBe(2);
  });

  it('stamps every record beneath a saved agent with that agent', () => {
    expect(model.nodes.get('llm-2')?.agentId).toBe('agent_scout');
    expect(model.nodes.get('round-1')?.agentId).toBe('agent_scout');
    expect(model.nodes.get('run')?.agentId).toBeUndefined();
    expect(model.steps.get(turn.stepKeys[1])?.agentId).toBe('agent_scout');
    expect(turn.agents).toEqual([{ agentId: 'agent_scout', recordId: 'scout' }]);
  });
});

describe('a response cut by the record limit', () => {
  /** The newest records of a long run: its root, agent and graph started first, so they are the ones not loaded. */
  const round = (index: number): TTraceRecord[] => [
    record({
      id: `node-${index}`,
      parentId: 'unloaded-graph',
      kind: 'agent',
      role: 'plumbing',
      name: 'agent',
      startTime: at(index * 1000),
    }),
    record({
      id: `call-${index}`,
      parentId: `node-${index}`,
      role: 'plumbing',
      name: 'AgentModelCall',
      startTime: at(index * 1000 + 10),
    }),
    record({
      id: `llm-${index}`,
      parentId: `call-${index}`,
      kind: 'generation',
      role: 'model',
      name: 'llm',
      startTime: at(index * 1000 + 20),
    }),
    record({
      id: `round-${index}`,
      parentId: 'unloaded-graph',
      role: 'tools',
      name: 'tool-dispatch',
      startTime: at(index * 1000 + 500),
    }),
  ];

  it('keeps each tool round in the step of the model call that asked for it', () => {
    const model = buildTraceModel([...round(0), ...round(1), ...round(2)], 'simple');
    const [turn] = model.turns;

    expect(turn.steps).toBe(3);
    expect(turn.stepKeys.map((key) => model.steps.get(key)?.rootIds)).toEqual([
      ['llm-0', 'round-0'],
      ['llm-1', 'round-1'],
      ['llm-2', 'round-2'],
    ]);
  });
});

describe('a cut inside a model call’s own wrappers', () => {
  const wrapped = (index: number, withNode: boolean): TTraceRecord[] => [
    ...(withNode
      ? [
          record({
            id: `node-${index}`,
            parentId: 'unloaded-graph',
            kind: 'agent',
            role: 'plumbing',
            name: 'agent',
            startTime: at(index * 1000),
          }),
        ]
      : []),
    record({
      id: `call-${index}`,
      parentId: `node-${index}`,
      role: 'plumbing',
      name: 'AgentModelCall',
      startTime: at(index * 1000 + 10),
    }),
    record({
      id: `llm-${index}`,
      parentId: `call-${index}`,
      kind: 'generation',
      role: 'model',
      name: 'llm',
      startTime: at(index * 1000 + 20),
    }),
    record({
      id: `round-${index}`,
      parentId: 'unloaded-graph',
      role: 'tools',
      name: 'tool-dispatch',
      tools: ['bash_tool', 'read_file'],
      startTime: at(index * 1000 + 500),
    }),
  ];

  it('gives the round to the model call whose wrapper the cut removed', () => {
    const model = buildTraceModel([...wrapped(0, false), ...wrapped(1, true)], 'simple');
    const [turn] = model.turns;

    expect(turn.split).toBe(true);
    expect(turn.stepKeys.map((key) => model.steps.get(key)?.rootIds)).toEqual([
      ['llm-0', 'round-0'],
      ['llm-1', 'round-1'],
    ]);
  });

  it('counts a round’s tools from the names the trace recorded for it', () => {
    const model = buildTraceModel(wrapped(1, true), 'simple');
    const [turn] = model.turns;

    expect(turn.toolCalls).toBe(2);
    expect(model.summary.toolCalls).toBe(2);
    expect([...(model.steps.get(turn.stepKeys[0])?.toolNames ?? [])]).toEqual([
      ['bash_tool', 1],
      ['read_file', 1],
    ]);
  });

  it('does not guess which of two cut model calls asked for a round', () => {
    /** Two parallel agents, both cut inside their wrappers, both model calls before either round. */
    const lane = (name: string, start: number): TTraceRecord[] => [
      record({
        id: `call-${name}`,
        parentId: `node-${name}`,
        role: 'plumbing',
        startTime: at(start),
      }),
      record({
        id: `llm-${name}`,
        parentId: `call-${name}`,
        kind: 'generation',
        role: 'model',
        startTime: at(start + 10),
      }),
      record({
        id: `round-${name}`,
        parentId: `graph-${name}`,
        role: 'tools',
        tools: ['bash_tool'],
        startTime: at(start + 1000),
      }),
    ];
    const model = buildTraceModel([...lane('a', 0), ...lane('b', 100)], 'simple');
    const [turn] = model.turns;
    const steps = turn.stepKeys.map((key) => model.steps.get(key)?.rootIds);

    expect(steps).toEqual([['llm-a'], ['llm-b'], ['round-a'], ['round-b']]);
    expect(turn.toolCalls).toBe(2);
  });

  it('counts recorded tools once when the round that holds them is also named', () => {
    const model = buildTraceModel(
      [
        ...wrapped(1, true),
        record({
          id: 'bash',
          parentId: 'round-1',
          kind: 'tool',
          name: 'bash_tool',
          startTime: at(1600),
        }),
        record({
          id: 'read',
          parentId: 'round-1',
          kind: 'tool',
          name: 'read_file',
          startTime: at(1700),
        }),
      ],
      'simple',
    );

    expect(model.turns[0].toolCalls).toBe(2);
    expect(model.summary.toolCalls).toBe(2);
  });

  it('does not call a whole response split', () => {
    expect(buildTraceModel(sdkRun, 'simple').turns[0].split).toBe(false);
  });
});

describe('every place a record limit can cut an SDK run', () => {
  /** The order the SDK's spans really start in: each wrapper before what it frames, the round last. */
  const rounds = 6;
  const run: TTraceRecord[] = [
    record({ id: 'root', kind: 'agent', role: 'run', name: 'AgentGraph', startTime: at(0) }),
    record({ id: 'saved', parentId: 'root', role: 'agent', agentId: 'agent_a', startTime: at(1) }),
    record({ id: 'graph', parentId: 'saved', kind: 'agent', role: 'run', startTime: at(2) }),
  ];
  for (let index = 0; index < rounds; index++) {
    const start = 100 + index * 100;
    run.push(
      record({
        id: `node-${index}`,
        parentId: 'graph',
        kind: 'agent',
        role: 'plumbing',
        startTime: at(start),
      }),
      record({
        id: `call-${index}`,
        parentId: `node-${index}`,
        role: 'plumbing',
        startTime: at(start + 1),
      }),
      record({
        id: `prompt-${index}`,
        parentId: `call-${index}`,
        role: 'plumbing',
        startTime: at(start + 2),
      }),
      record({
        id: `llm-${index}`,
        parentId: `call-${index}`,
        kind: 'generation',
        role: 'model',
        startTime: at(start + 3),
      }),
    );
    if (index < rounds - 1) {
      run.push(
        record({
          id: `label-${index}`,
          parentId: 'root',
          kind: 'generation',
          role: 'stepLabel',
          startTime: at(start + 40),
        }),
        record({
          id: `round-${index}`,
          parentId: 'graph',
          role: 'tools',
          startTime: at(start + 50),
        }),
      );
    }
  }
  const newestFirst = [...run].sort((a, b) => b.startTime.localeCompare(a.startTime));

  it.each(newestFirst.map((_, index) => index + 1))(
    'keeps one step per model call with its own round when the newest %i records load',
    (keep) => {
      const loaded = newestFirst.slice(0, keep);
      const model = buildTraceModel(loaded, 'simple');
      const [turn] = model.turns;
      const steps = turn.stepKeys.map((key) => model.steps.get(key)?.rootIds ?? []);
      const roleOf = (id: string) => model.nodes.get(id)?.record.role;

      const stepOf = new Map(steps.flatMap((rootIds, index) => rootIds.map((id) => [id, index])));
      const loadedModelCalls = loaded.filter((entry) => entry.role === 'model').length;
      let orphans = 0;
      for (const entry of loaded) {
        if (roleOf(entry.id) !== 'tools') {
          continue;
        }
        const asker = `llm-${entry.id.split('-')[1]}`;
        if (model.nodes.has(asker)) {
          expect(stepOf.get(entry.id)).toBe(stepOf.get(asker));
        } else {
          orphans++;
        }
      }
      /** Only the oldest loaded round can have lost its model call to the cut, and it alone adds a step. */
      expect(orphans).toBeLessThanOrEqual(1);
      expect(turn.steps).toBe(loadedModelCalls + orphans);
      expect(turn.split).toBe(keep < run.length);
    },
  );
});
