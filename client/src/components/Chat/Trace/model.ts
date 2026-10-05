import type { TTraceRecord } from 'librechat-data-provider';

/** `simple` lists the model calls and tools grouped into steps; `full` lists every span as recorded. */
export type TraceMode = 'simple' | 'full';

/** `sequence` gives every record one equal block in ledger order; `time` scales by recorded time. */
export type TraceScale = 'sequence' | 'time';

export type TraceSpan = { start: number; end: number };

/**
 * Spend over a set of records. A total that silently skips a model call without a price, with or
 * without usage, would under-report, so `costOf` gives one only when every model call has a price.
 */
type Spend = { cost: number; priced: number; unpriced: number };

const noSpend = (): Spend => ({ cost: 0, priced: 0, unpriced: 0 });

function spendOn(spend: Spend, record: TTraceRecord): void {
  if (record.cost != null) {
    spend.priced++;
    spend.cost += record.cost;
  } else if (record.kind === 'generation') {
    spend.unpriced++;
  }
}

const costOf = (spend: Spend): number | undefined =>
  spend.priced > 0 && spend.unpriced === 0 ? spend.cost : undefined;

export type TraceWindow = TraceSpan;

export type TraceNode = {
  record: TTraceRecord;
  start: number;
  /** Absent while the record is still running: it has a start, not a duration. */
  end?: number;
  /** First streamed token, clamped inside the record's own span. */
  firstToken?: number;
  /** Depth in the ledger tree of the active mode: 0 for a root under its turn or step. */
  depth: number;
  parentId: string | null;
  childIds: string[];
  /** The parent the active mode shows: the nearest shown ancestor. */
  viewParentId: string | null;
  viewChildIds: string[];
  /** Whether the active mode lists the record. */
  shown: boolean;
  stepKey: string | null;
  /** Order among shown records: the record's position on the sequence scale. */
  sequence: number;
  /** The saved agent the record ran under: its nearest `agent` ancestor's. */
  agentId?: string;
};

export type TraceStep = {
  key: string;
  messageId: string;
  /** 1-based among the turn's response-run steps; the title run numbers its own. */
  index: number;
  origin: 'run' | 'title';
  generationId: string | null;
  /**
   * The tool round that ran the step's calls. A model call asks for one round, so a step holding
   * several is one an approval paused: the round is recorded again when it resumes, with the same
   * calls, and the last record is the one that ran them.
   */
  roundId: string | null;
  agentId?: string;
  rootIds: string[];
  start: number;
  end: number;
  recordCount: number;
  errorCount: number;
  toolCalls: number;
  /** Tool call counts by tool name, in first-call order. */
  toolNames: Map<string, number>;
  /** What the step's records cost, when every model call among them has a price. */
  cost?: number;
  sequence: TraceSpan;
};

export type TraceTurn = {
  key: string;
  messageId: string;
  start: number;
  end: number;
  rootIds: string[];
  stepKeys: string[];
  /** Response-run steps only; a title run's steps are not counted as work of the response. */
  steps: number;
  recordCount: number;
  errorCount: number;
  generations: number;
  /** Model calls that wrote an activity label; they are spend, not work of the response. */
  labels: number;
  toolCalls: number;
  /**
   * Some of the response's records hang from a parent that is not loaded. Records load newest
   * first and a run's root starts first, so this is what a record limit leaves of a response it
   * cut: its end.
   */
  split: boolean;
  /** Saved agents that ran in the response, each with the record that stands for it. */
  agents: Array<{ agentId: string; recordId: string }>;
  /** What the response's records cost, title and label calls included, when every model call has a
   *  price and the whole response is loaded. */
  cost?: number;
  sequence: TraceSpan;
};

export type TraceSummary = {
  duration: number;
  turns: number;
  generations: number;
  labels: number;
  toolCalls: number;
  errors: number;
  running: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost?: number;
};

export type TraceModel = {
  mode: TraceMode;
  nodes: Map<string, TraceNode>;
  steps: Map<string, TraceStep>;
  turns: TraceTurn[];
  start: number;
  end: number;
  /** Shown records: the extent of the sequence scale. */
  count: number;
  summary: TraceSummary;
};

/** `position` and `setSize` count the row's visible siblings, as a tree item's ARIA position does. */
type RowPlacement = {
  key: string;
  expanded: boolean;
  position: number;
  setSize: number;
  level: number;
};

export type TraceRow =
  | (RowPlacement & { type: 'turn'; turn: TraceTurn })
  | (RowPlacement & { type: 'step'; step: TraceStep })
  | (RowPlacement & { type: 'record'; node: TraceNode; hasChildren: boolean });

export type TraceFilter = {
  collapsed: ReadonlySet<string>;
  query: string;
  window: TraceWindow | null;
  scale: TraceScale;
  /** The labels a row shows for its record (kind, status, preview), which search also matches. */
  labelsFor?: (record: TTraceRecord) => readonly string[];
};

const EMPTY_SUMMARY: TraceSummary = {
  duration: 0,
  turns: 0,
  generations: 0,
  labels: 0,
  toolCalls: 0,
  errors: 0,
  running: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

const EMPTY_SPAN: TraceSpan = { start: 0, end: 0 };

export const turnKey = (messageId: string): string => `turn:${messageId}`;
/** Keyed by the step's own record, so a fold survives an older page renumbering the steps. */
export const stepKey = (messageId: string, origin: TraceStep['origin'], anchorId: string): string =>
  `step:${messageId}:${origin}:${anchorId}`;

/** Ties at one millisecond are broken causally: the model call that asked comes before the tool that ran. */
const KIND_ORDER: Record<TTraceRecord['kind'], number> = {
  agent: 0,
  span: 0,
  generation: 1,
  tool: 2,
  event: 3,
};

const byStart = (nodes: Map<string, TraceNode>) => (a: string, b: string) => {
  const left = nodes.get(a);
  const right = nodes.get(b);
  return (
    (left?.start ?? 0) - (right?.start ?? 0) ||
    KIND_ORDER[left?.record.kind ?? 'span'] - KIND_ORDER[right?.record.kind ?? 'span'] ||
    a.localeCompare(b)
  );
};

const LABEL_ROLES: ReadonlySet<TTraceRecord['role']> = new Set([
  'stepLabel',
  'reasoningLabel',
  'phaseLabel',
]);

/** A model call that wrote one of the activity labels the chat shows while a response runs. */
export function isLabelRecord(record: TTraceRecord): boolean {
  return LABEL_ROLES.has(record.role);
}

/** A model call of the response itself: it starts a step, and the chat's message describes it. */
export function isModelCall(record: TTraceRecord): boolean {
  return record.kind === 'generation' && !isLabelRecord(record);
}

/** A tool, or the round of tool calls a host ran without recording each one. */
export function isToolWork(record: TTraceRecord): boolean {
  return record.kind === 'tool' || record.role === 'tools';
}

/** The records the simple mode lists: what the model did, anything that failed, and the title run. */
function isSimpleRecord(record: TTraceRecord): boolean {
  return (
    record.kind === 'generation' ||
    isToolWork(record) ||
    record.status === 'error' ||
    record.origin === 'title'
  );
}

/** The records others hang from: what the model called. A failed wrapper stays visible but holds nothing. */
function isStepAnchor(record: TTraceRecord): boolean {
  return record.kind === 'generation' || isToolWork(record);
}

function toNode(record: TTraceRecord): TraceNode | null {
  const start = Date.parse(record.startTime);
  if (!Number.isFinite(start)) {
    return null;
  }
  const parsedEnd = record.endTime != null ? Date.parse(record.endTime) : Number.NaN;
  const end = Number.isFinite(parsedEnd) ? Math.max(parsedEnd, start) : undefined;
  const parsedToken =
    record.completionStartTime != null ? Date.parse(record.completionStartTime) : Number.NaN;
  const firstToken = Number.isFinite(parsedToken)
    ? Math.min(Math.max(parsedToken, start), end ?? parsedToken)
    : undefined;
  return {
    record,
    start,
    end,
    firstToken,
    depth: 0,
    parentId: null,
    childIds: [],
    viewParentId: null,
    viewChildIds: [],
    shown: true,
    stepKey: null,
    sequence: 0,
  };
}

/**
 * Cuts every parent cycle so each record hangs from exactly one root. A record
 * whose parent is unloaded, belongs to another turn, or closes a loop becomes a
 * root of its own turn instead of disappearing.
 */
function resolveParents(nodes: Map<string, TraceNode>): void {
  for (const [id, node] of nodes) {
    const parentId = node.record.parentId;
    const parent = parentId != null ? nodes.get(parentId) : undefined;
    node.parentId =
      parent != null && parentId !== id && parent.record.messageId === node.record.messageId
        ? parentId
        : null;
  }

  const settled = new Set<string>();
  for (const id of nodes.keys()) {
    const path = new Set<string>();
    let current: string | null = id;
    let previous: string | null = null;
    while (current != null && !settled.has(current)) {
      if (path.has(current)) {
        const cutAt = nodes.get(previous ?? current);
        if (cutAt) {
          cutAt.parentId = null;
        }
        break;
      }
      path.add(current);
      previous = current;
      current = nodes.get(current)?.parentId ?? null;
    }
    for (const visited of path) {
      settled.add(visited);
    }
  }
}

/** Nearest model/tool ancestor, cached across both projections with iterative path compression. */
function nearestStepAncestor(
  nodes: Map<string, TraceNode>,
  node: TraceNode,
  ancestors: Map<string, string | null>,
): string | null {
  const path: string[] = [];
  let current = node;
  let result: string | null;
  for (;;) {
    const cached = ancestors.get(current.record.id);
    if (cached !== undefined) {
      result = cached;
      break;
    }
    path.push(current.record.id);
    const parent = current.parentId != null ? nodes.get(current.parentId) : undefined;
    if (parent == null || isStepAnchor(parent.record)) {
      result = parent?.record.id ?? null;
      break;
    }
    current = parent;
  }
  for (const id of path) {
    ancestors.set(id, result);
  }
  return result;
}

/**
 * Whether the simple mode lists a record. A turn that has no model call, tool or
 * failure yet (a run still starting, or cancelled early) lists its wrappers
 * instead, so the ledger can show that something is running rather than nothing.
 */
function isListed(node: TraceNode, turnsWithWork: ReadonlySet<string>): boolean {
  return (
    isSimpleRecord(node.record) ||
    (node.parentId == null && !turnsWithWork.has(node.record.messageId))
  );
}

function turnsWithSimpleRecords(nodes: Map<string, TraceNode>): Set<string> {
  const turns = new Set<string>();
  for (const node of nodes.values()) {
    if (isSimpleRecord(node.record)) {
      turns.add(node.record.messageId);
    }
  }
  return turns;
}

/** Hangs every shown record from its nearest shown ancestor; the full mode shows them all. */
function resolveViewTree(
  nodes: Map<string, TraceNode>,
  mode: TraceMode,
  turnsWithWork: ReadonlySet<string>,
  ancestors: Map<string, string | null>,
): void {
  for (const node of nodes.values()) {
    node.shown = mode === 'full' || isListed(node, turnsWithWork);
  }
  for (const [id, node] of nodes) {
    if (!node.shown) {
      continue;
    }
    node.viewParentId =
      mode === 'full' ? node.parentId : nearestStepAncestor(nodes, node, ancestors);
    if (node.viewParentId != null) {
      nodes.get(node.viewParentId)?.viewChildIds.push(id);
    }
  }
}

/**
 * The model calls and tools that hang directly from a turn once every other
 * span is rolled up, whichever mode is active: steps are defined by these in
 * both modes, so a turn's step count reads the same however it is listed.
 */
function stepRoots(
  nodes: Map<string, TraceNode>,
  turnsWithWork: ReadonlySet<string>,
  ancestors: Map<string, string | null>,
): Map<string, string[]> {
  const roots = new Map<string, string[]>();
  for (const [id, node] of nodes) {
    if (!isListed(node, turnsWithWork)) {
      continue;
    }
    const ancestor = nearestStepAncestor(nodes, node, ancestors);
    if (ancestor != null) {
      continue;
    }
    const turnRoots = roots.get(node.record.messageId) ?? [];
    turnRoots.push(id);
    roots.set(node.record.messageId, turnRoots);
  }
  return roots;
}

/**
 * Groups a turn's roots into steps: each model call starts one and the tools
 * that follow it belong to it, so a step reads as "the model decided, then
 * these ran". Tools before the first model call (a turn whose earlier records
 * sit on an unloaded page) form a step of their own, as they do in the chat's
 * own record of the response. Failed spans before any step join the first one,
 * and a turn with nothing else is one step. A title run's records form their own.
 */
function groupSteps(
  turn: TraceTurn,
  nodes: Map<string, TraceNode>,
  steps: Map<string, TraceStep>,
  rootIds: readonly string[],
  privateWrappers: ReadonlySet<string>,
): number {
  let namedCalls = 0;
  const compare = byStart(nodes);
  const rootsByOrigin = new Map<TraceStep['origin'], string[]>();
  for (const id of rootIds) {
    const origin = nodes.get(id)?.record.origin ?? 'run';
    const roots = rootsByOrigin.get(origin) ?? [];
    roots.push(id);
    rootsByOrigin.set(origin, roots);
  }

  const unloadedParentOf = (id: string): string | undefined => {
    const parentId = nodes.get(id)?.record.parentId;
    return parentId != null && !nodes.has(parentId) ? parentId : undefined;
  };
  /**
   * A record limit cuts a long response's earliest records, its root and graph among them, so a
   * walk can end at a wrapper that only frames one model call. That wrapper is no lane of its
   * own: the lane is the unloaded parent it shares with the tool round the model call asked for.
   */
  const laneAbove = (id: string): string | undefined =>
    nodes.get(id)?.record.role === 'plumbing' ? unloadedParentOf(id) : undefined;
  /** A wrapper's branch immediately below its structural root, cached for nested failure rows. */
  const branches = new Map<string, string>();
  const branchOf = (id: string): string => {
    const path: string[] = [];
    let current = id;
    let branch: string;
    for (;;) {
      const cached = branches.get(current);
      if (cached != null) {
        branch = cached;
        break;
      }
      path.push(current);
      const parent = nodes.get(current)?.parentId;
      if (parent == null) {
        branch = laneAbove(current) ?? current;
        break;
      }
      if (nodes.get(parent)?.parentId == null) {
        /** A wrapper framing one model call is never a lane, so when the cut left the graph as
         *  the topmost loaded record, the lane is that graph, where its tool rounds hang too. */
        const framing = nodes.get(current)?.record.role === 'plumbing';
        branch = laneAbove(parent) ?? (framing ? parent : current);
        break;
      }
      current = parent;
    }
    for (const entry of path) {
      branches.set(entry, branch);
    }
    return branch;
  };
  /** Unloaded parents remain distinct: merging them would guess at absent lane relationships. */
  const laneOf = (id: string): string => {
    const node = nodes.get(id);
    if (node?.parentId != null) {
      return branchOf(node.parentId);
    }
    return unloadedParentOf(id) ?? '';
  };

  for (const [origin, roots] of rootsByOrigin) {
    roots.sort(compare);
    const groups: Array<{ rootIds: string[]; lane: string }> = [];
    const latestByLane = new Map<string, { rootIds: string[]; lane: string }>();
    /** Model calls whose lane is a private wrapper, until the round each asked for arrives. */
    const waiting = new Set<{ rootIds: string[]; lane: string }>();
    let leading: string[] = [];
    for (const id of roots) {
      const record = nodes.get(id)?.record;
      const lane = laneOf(id);
      const current = groups[groups.length - 1];
      /** The cut can fall inside a model call's own wrappers. Its lane is then one of those
       *  wrappers, which names no lane at all, so the round it asked for, arriving in a lane no
       *  model call holds, is its round rather than a step of its own. That is only known when
       *  one such model call is still waiting for its round: with two (parallel agents cut at
       *  the same place) nothing says which asked, so the round leads a step of its own. */
      const asked =
        record != null && isToolWork(record) && !latestByLane.has(lane) && waiting.size === 1
          ? waiting.values().next().value
          : undefined;
      /** A tool whose lane has no model call loaded yet (an older page holds it) leads its own step.
       *  A label's model call describes a step; it never starts one. */
      if (
        record != null &&
        (isModelCall(record) || (isToolWork(record) && !latestByLane.has(lane) && asked == null))
      ) {
        const group = { rootIds: [...leading, id], lane };
        groups.push(group);
        latestByLane.set(lane, group);
        leading = [];
        if (isModelCall(record) && privateWrappers.has(lane)) {
          waiting.add(group);
        }
      } else if (current == null) {
        leading.push(id);
      } else {
        (latestByLane.get(lane) ?? asked ?? current).rootIds.push(id);
        if (asked != null) {
          latestByLane.set(lane, asked);
          waiting.delete(asked);
        }
      }
    }
    if (leading.length > 0) {
      groups.push({ rootIds: leading, lane: laneOf(leading[0]) });
    }
    groups.forEach(({ rootIds }, index) => {
      const generationId = rootIds.find(isGenerationId(nodes)) ?? null;
      let roundId: string | null = null;
      for (const id of rootIds) {
        if (nodes.get(id)?.record.role === 'tools') {
          roundId = id;
        }
      }
      const key = stepKey(turn.messageId, origin, generationId ?? rootIds[0]);
      const step: TraceStep = {
        key,
        messageId: turn.messageId,
        index: index + 1,
        origin,
        generationId,
        roundId,
        agentId: nodes.get(generationId ?? rootIds[0])?.agentId,
        rootIds,
        start: Number.POSITIVE_INFINITY,
        end: Number.NEGATIVE_INFINITY,
        recordCount: 0,
        errorCount: 0,
        toolCalls: 0,
        toolNames: new Map(),
        sequence: EMPTY_SPAN,
      };
      const spend = noSpend();
      const stack = [...rootIds].reverse();
      while (stack.length > 0) {
        const node = nodes.get(stack.pop() ?? '');
        if (!node || node.stepKey === key) {
          continue;
        }
        node.stepKey = key;
        step.recordCount++;
        step.start = Math.min(step.start, node.start);
        step.end = Math.max(step.end, node.end ?? node.start);
        if (node.record.status === 'error') {
          step.errorCount++;
        }
        /** Names stand in for tools that were never recorded, so only for the round that ran, and
         *  only when it holds no recorded tool of its own to count instead. */
        const named =
          node.record.id === roundId && !node.childIds.some(isToolWorkId(nodes))
            ? (node.record.tools ?? [])
            : [];
        namedCalls += named.length;
        for (const name of node.record.kind === 'tool' ? [node.record.name] : named) {
          step.toolCalls++;
          step.toolNames.set(name, (step.toolNames.get(name) ?? 0) + 1);
        }
        for (let i = node.viewChildIds.length - 1; i >= 0; i--) {
          stack.push(node.viewChildIds[i]);
        }
      }
      /** Spend is the whole subtree's, not the listed projection's: the simple mode rolls spans
       *  and events up out of sight, and any record may carry a cost. */
      const below = [...rootIds];
      const counted = new Set<string>();
      while (below.length > 0) {
        const id = below.pop() ?? '';
        const node = nodes.get(id);
        if (!node || counted.has(id)) {
          continue;
        }
        counted.add(id);
        spendOn(spend, node.record);
        below.push(...node.childIds);
      }
      step.cost = costOf(spend);
      steps.set(key, step);
      turn.stepKeys.push(key);
    });
    if (origin === 'run') {
      turn.steps = groups.length;
    }
  }

  turn.stepKeys.sort((a, b) => {
    const left = steps.get(a);
    const right = steps.get(b);
    return (
      (left?.start ?? 0) - (right?.start ?? 0) ||
      (left?.origin === 'title' ? 1 : 0) - (right?.origin === 'title' ? 1 : 0)
    );
  });
  return namedCalls;
}

const isToolWorkId = (nodes: Map<string, TraceNode>) => (id: string) => {
  const record = nodes.get(id)?.record;
  return record != null && isToolWork(record);
};

const isGenerationId = (nodes: Map<string, TraceNode>) => (id: string) => {
  const record = nodes.get(id)?.record;
  return record != null && isModelCall(record);
};

/** Stamps each record with its nearest `agent` ancestor's saved agent, caching every path walked. */
function resolveAgents(nodes: Map<string, TraceNode>): void {
  const resolved = new Map<string, string | undefined>();
  for (const node of nodes.values()) {
    const path: TraceNode[] = [];
    let current: TraceNode | undefined = node;
    let agentId: string | undefined;
    while (current != null) {
      if (resolved.has(current.record.id)) {
        agentId = resolved.get(current.record.id);
        break;
      }
      path.push(current);
      if (current.record.agentId != null) {
        agentId = current.record.agentId;
        break;
      }
      current = current.parentId != null ? nodes.get(current.parentId) : undefined;
    }
    for (const visited of path) {
      resolved.set(visited.record.id, agentId);
      visited.agentId = agentId;
    }
  }
}

/** Walks a shown subtree in ledger order, setting depth and the sequence position. */
function numberSubtree(nodes: Map<string, TraceNode>, rootIds: string[], next: number): number {
  const compare = byStart(nodes);
  let sequence = next;
  const stack = rootIds.map((id) => ({ id, depth: 0 })).reverse();
  while (stack.length > 0) {
    const entry = stack.pop();
    const node = entry ? nodes.get(entry.id) : undefined;
    if (!entry || !node) {
      continue;
    }
    node.depth = entry.depth;
    node.sequence = sequence++;
    node.viewChildIds.sort(compare);
    for (let i = node.viewChildIds.length - 1; i >= 0; i--) {
      stack.push({ id: node.viewChildIds[i], depth: entry.depth + 1 });
    }
  }
  return sequence;
}

/** Projects a flat, possibly partial record list into turns of record trees. */
export function buildTraceModel(
  records: readonly TTraceRecord[],
  mode: TraceMode = 'simple',
  /** Older records are still to load, so the oldest loaded response may not be all there. */
  hasOlder = false,
): TraceModel {
  const nodes = new Map<string, TraceNode>();
  const steps = new Map<string, TraceStep>();
  for (const record of records) {
    const node = toNode(record);
    if (node) {
      nodes.set(record.id, node);
    }
  }
  if (nodes.size === 0) {
    return { mode, nodes, steps, turns: [], start: 0, end: 0, count: 0, summary: EMPTY_SUMMARY };
  }

  resolveParents(nodes);
  resolveAgents(nodes);
  const turnsWithWork = turnsWithSimpleRecords(nodes);
  const ancestors = new Map<string, string | null>();
  resolveViewTree(nodes, mode, turnsWithWork, ancestors);
  const rootsByTurn = stepRoots(nodes, turnsWithWork, ancestors);

  const turnsByMessage = new Map<string, TraceTurn>();
  const summary: TraceSummary = { ...EMPTY_SUMMARY };
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  const spend = noSpend();
  const spendByTurn = new Map<string, Spend>();

  for (const [id, node] of nodes) {
    const { record } = node;
    const nodeEnd = node.end ?? node.start;
    start = Math.min(start, node.start);
    end = Math.max(end, nodeEnd);

    if (node.parentId != null) {
      nodes.get(node.parentId)?.childIds.push(id);
    }

    let turn = turnsByMessage.get(record.messageId);
    if (!turn) {
      turn = {
        key: turnKey(record.messageId),
        messageId: record.messageId,
        start: node.start,
        end: nodeEnd,
        rootIds: [],
        stepKeys: [],
        steps: 0,
        recordCount: 0,
        errorCount: 0,
        generations: 0,
        labels: 0,
        toolCalls: 0,
        split: false,
        agents: [],
        sequence: EMPTY_SPAN,
      };
      turnsByMessage.set(record.messageId, turn);
    }
    turn.start = Math.min(turn.start, node.start);
    turn.end = Math.max(turn.end, nodeEnd);
    turn.recordCount++;
    if (node.parentId == null) {
      turn.rootIds.push(id);
    }

    if (record.status === 'error') {
      turn.errorCount++;
      summary.errors++;
    } else if (record.status === 'running') {
      summary.running++;
    }
    if (record.kind === 'tool') {
      turn.toolCalls++;
      summary.toolCalls++;
    }
    if (record.agentId != null && !turn.agents.some((agent) => agent.agentId === record.agentId)) {
      turn.agents.push({ agentId: record.agentId, recordId: id });
    }
    if (record.kind === 'generation') {
      if (isLabelRecord(record)) {
        turn.labels++;
        summary.labels++;
      } else {
        turn.generations++;
        summary.generations++;
      }
      const input = record.usage?.input ?? 0;
      const output = record.usage?.output ?? 0;
      const total = record.usage?.total ?? input + output;
      summary.inputTokens += input;
      summary.outputTokens += output;
      summary.totalTokens += total;
    }
    spendOn(spend, record);
    let turnSpend = spendByTurn.get(record.messageId);
    if (turnSpend == null) {
      turnSpend = noSpend();
      spendByTurn.set(record.messageId, turnSpend);
    }
    spendOn(turnSpend, record);
  }

  const compare = byStart(nodes);
  const turns = [...turnsByMessage.values()].sort((a, b) => a.start - b.start);
  /**
   * Parents a record limit cut off, and which of them frame a single model call. The SDK wraps
   * each model call in wrappers of its own, so an unloaded parent whose loaded children are only
   * such wrappers and a model call is one of those, wherever in the chain the cut fell. A graph
   * is told apart by what else hangs from it: the tool rounds.
   */
  const shared = new Set<string>();
  const privateWrappers = new Set<string>();
  for (const node of nodes.values()) {
    const { parentId, role, origin, messageId } = node.record;
    if (parentId == null || nodes.has(parentId)) {
      continue;
    }
    if (role === 'plumbing' || role === 'model') {
      privateWrappers.add(parentId);
    } else {
      shared.add(parentId);
    }
    const turn = origin == null ? turnsByMessage.get(messageId) : undefined;
    if (turn != null) {
      turn.split = true;
    }
  }
  for (const id of shared) {
    privateWrappers.delete(id);
  }
  let sequence = 0;
  for (const turn of turns) {
    turn.rootIds.sort(compare);
    for (const id of turn.rootIds) {
      const stack = [{ id, depth: 0 }];
      while (stack.length > 0) {
        const entry = stack.pop();
        const node = entry ? nodes.get(entry.id) : undefined;
        if (!entry || !node) {
          continue;
        }
        node.childIds.sort(compare);
        stack.push(...node.childIds.map((childId) => ({ id: childId, depth: entry.depth + 1 })));
      }
    }
    const namedCalls = groupSteps(
      turn,
      nodes,
      steps,
      rootsByTurn.get(turn.messageId) ?? [],
      privateWrappers,
    );
    turn.toolCalls += namedCalls;
    summary.toolCalls += namedCalls;
    const turnSequenceStart = sequence;
    if (mode === 'simple') {
      for (const key of turn.stepKeys) {
        const step = steps.get(key);
        if (!step) {
          continue;
        }
        const stepSequenceStart = sequence;
        sequence = numberSubtree(nodes, step.rootIds, sequence);
        step.sequence = { start: stepSequenceStart, end: sequence };
      }
    } else {
      sequence = numberSubtree(nodes, turn.rootIds, sequence);
    }
    turn.sequence = { start: turnSequenceStart, end: sequence };
  }

  summary.turns = turns.length;
  summary.duration = end - start;
  const total = costOf(spend);
  if (total != null) {
    summary.cost = total;
  }
  /**
   * A response that is not all loaded holds only its newest records, and their sum is not its
   * cost. A missing parent proves a cut (`split`), but a page can also end between a response's
   * traces, its title run loaded and its own run not, with every parent in place. So while older
   * records remain, the oldest loaded response is not known to be whole.
   */
  turns.forEach((turn, index) => {
    const partial = turn.split || (hasOlder && index === 0);
    turn.cost = partial ? undefined : costOf(spendByTurn.get(turn.messageId) ?? noSpend());
  });
  return { mode, nodes, steps, turns, start, end, count: sequence, summary };
}

/** A record's extent on the active scale; a running record is a start with no width. */
export function spanOf(node: TraceNode, scale: TraceScale): TraceSpan {
  if (scale === 'sequence') {
    return { start: node.sequence, end: node.sequence + 1 };
  }
  return { start: node.start, end: node.end ?? node.start };
}

export function stepSpan(step: TraceStep, scale: TraceScale): TraceSpan {
  return scale === 'sequence' ? step.sequence : { start: step.start, end: step.end };
}

export function turnSpan(turn: TraceTurn, scale: TraceScale): TraceSpan {
  return scale === 'sequence' ? turn.sequence : { start: turn.start, end: turn.end };
}

/** The whole trace on the active scale: recorded time, or one unit per shown record. */
export function boundsOf(model: TraceModel, scale: TraceScale): TraceSpan {
  return scale === 'sequence'
    ? { start: 0, end: model.count }
    : { start: model.start, end: model.end };
}

function matchesQuery(
  node: TraceNode,
  query: string,
  labelsFor: TraceFilter['labelsFor'],
): boolean {
  if (!query) {
    return true;
  }
  const { record } = node;
  return [record.name, record.model, record.statusMessage, ...(labelsFor?.(record) ?? [])].some(
    (value) => value != null && value.toLowerCase().includes(query),
  );
}

function overlapsWindow(node: TraceNode, window: TraceWindow | null, scale: TraceScale): boolean {
  if (window == null) {
    return true;
  }
  const span = spanOf(node, scale);
  return scale === 'sequence'
    ? span.start < window.end && span.end > window.start
    : span.start <= window.end && span.end >= window.start;
}

/** Shown records that match the filter, plus every shown ancestor so a match keeps its context. */
function visibleIds(
  model: TraceModel,
  query: string,
  window: TraceWindow | null,
  scale: TraceScale,
  labelsFor: TraceFilter['labelsFor'],
): Set<string> {
  const visible = new Set<string>();
  for (const [id, node] of model.nodes) {
    if (
      !node.shown ||
      !matchesQuery(node, query, labelsFor) ||
      !overlapsWindow(node, window, scale)
    ) {
      continue;
    }
    let current: string | null = id;
    while (current != null && !visible.has(current)) {
      visible.add(current);
      current = model.nodes.get(current)?.viewParentId ?? null;
    }
  }
  return visible;
}

type Group = { key: string; rootIds: string[] };

/**
 * The ledger's rows in display order. A search or interval selection expands
 * everything it keeps, so a match is never hidden inside a folded parent.
 */
export function flattenRows(
  model: TraceModel,
  { collapsed, query, window, scale, labelsFor }: TraceFilter,
): TraceRow[] {
  const normalizedQuery = query.trim().toLowerCase();
  const filtering = normalizedQuery !== '' || window != null;
  const visible = filtering ? visibleIds(model, normalizedQuery, window, scale, labelsFor) : null;
  const rows: TraceRow[] = [];
  const grouped = model.mode === 'simple';
  const recordLevel = grouped ? 3 : 2;

  const keptRoots = (rootIds: string[]) =>
    visible ? rootIds.filter((id) => visible.has(id)) : rootIds;
  const groupsOf = (turn: TraceTurn): Group[] => {
    const groups = grouped
      ? turn.stepKeys.map((key) => ({
          key,
          rootIds: keptRoots(model.steps.get(key)?.rootIds ?? []),
        }))
      : [{ key: turn.key, rootIds: keptRoots(turn.rootIds) }];
    return visible ? groups.filter((group) => group.rootIds.length > 0) : groups;
  };
  const turns = model.turns.flatMap((turn) => {
    const groups = groupsOf(turn);
    return visible && groups.length === 0 ? [] : [{ turn, groups }];
  });

  const pushRecords = (rootIds: string[]) => {
    const stack = rootIds
      .map((id, index) => ({ id, position: index + 1, setSize: rootIds.length }))
      .reverse();
    while (stack.length > 0) {
      const entry = stack.pop();
      const node = entry != null ? model.nodes.get(entry.id) : undefined;
      if (entry == null || !node) {
        continue;
      }
      const children = visible
        ? node.viewChildIds.filter((childId) => visible.has(childId))
        : node.viewChildIds;
      const expanded = filtering || !collapsed.has(entry.id);
      rows.push({
        type: 'record',
        key: entry.id,
        node,
        expanded,
        hasChildren: children.length > 0,
        position: entry.position,
        setSize: entry.setSize,
        level: node.depth + recordLevel,
      });
      if (!expanded) {
        continue;
      }
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ id: children[i], position: i + 1, setSize: children.length });
      }
    }
  };

  turns.forEach(({ turn, groups }, turnIndex) => {
    const turnExpanded = filtering || !collapsed.has(turn.key);
    rows.push({
      type: 'turn',
      key: turn.key,
      turn,
      expanded: turnExpanded,
      position: turnIndex + 1,
      setSize: turns.length,
      level: 1,
    });
    if (!turnExpanded) {
      return;
    }
    if (!grouped) {
      pushRecords(groups[0]?.rootIds ?? []);
      return;
    }
    groups.forEach((group, groupIndex) => {
      const step = model.steps.get(group.key);
      if (!step) {
        return;
      }
      const expanded = filtering || !collapsed.has(step.key);
      rows.push({
        type: 'step',
        key: step.key,
        step,
        expanded,
        position: groupIndex + 1,
        setSize: groups.length,
        level: 2,
      });
      if (expanded) {
        pushRecords(group.rootIds);
      }
    });
  });
  return rows;
}

/** Ids a user can fold: every turn, every step, and every shown record with shown children. */
export function collapsibleKeys(model: TraceModel): string[] {
  const keys = model.turns.map((turn) => turn.key);
  if (model.mode === 'simple') {
    keys.push(...model.steps.keys());
  }
  for (const [id, node] of model.nodes) {
    if (node.shown && node.viewChildIds.length > 0) {
      keys.push(id);
    }
  }
  return keys;
}

/**
 * Packs shown records into a fixed number of overview lanes the way a network
 * waterfall does: each record takes the first lane free at its start.
 */
export function assignLanes(model: TraceModel, laneCount: number): Map<string, number> {
  const laneEnds: number[] = [];
  const lanes = new Map<string, number>();
  const ordered = [...model.nodes.values()]
    .filter((node) => node.shown)
    .sort((a, b) => a.start - b.start || a.depth - b.depth);
  for (const node of ordered) {
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= node.start);
    if (lane === -1) {
      lane = laneEnds.length < laneCount ? laneEnds.length : laneCount - 1;
    }
    laneEnds[lane] = Math.max(laneEnds[lane] ?? 0, node.end ?? node.start);
    lanes.set(node.record.id, lane);
  }
  return lanes;
}

/** On the sequence scale nothing overlaps, so lanes separate kinds: model calls, tools, the rest. */
export function sequenceLane(record: TTraceRecord): number {
  if (isModelCall(record)) {
    return 0;
  }
  return isToolWork(record) ? 1 : 2;
}

/** Clamps a zoom window inside the trace and keeps it at least `minSpan` wide. */
export function clampWindow(
  window: TraceWindow,
  bounds: TraceSpan,
  minSpan = 1,
): TraceWindow | null {
  const total = bounds.end - bounds.start;
  if (total <= 0) {
    return null;
  }
  const requested = window.end - window.start;
  const span = Math.min(Math.max(requested, minSpan), total);
  if (span >= total) {
    return null;
  }
  /** A window narrower than allowed widens around its own centre rather than drifting right. */
  const from = span > requested ? (window.start + window.end - span) / 2 : window.start;
  const start = Math.min(Math.max(from, bounds.start), bounds.end - span);
  return { start, end: start + span };
}

/**
 * Keeps a zoom window on the records still loaded: the part of it inside the
 * trace, or none when it covers none of the trace. A window that already fits
 * is returned as is.
 */
export function fitWindow(
  window: TraceWindow,
  bounds: TraceSpan,
  minSpan = minimumSpan(bounds),
): TraceWindow | null {
  const start = Math.max(window.start, bounds.start);
  const end = Math.min(window.end, bounds.end);
  if (end <= start) {
    return null;
  }
  if (start === window.start && end === window.end) {
    return window;
  }
  return clampWindow({ start, end }, bounds, minSpan);
}

export const ZOOM_STEP = 0.5;
const PAN_STEP = 0.1;

/** Rescales `view` by `factor` around `anchor`, a position on the active scale. */
export function zoomWindow(
  bounds: TraceSpan,
  view: TraceWindow | null,
  factor: number,
  anchor?: number,
  minSpan = minimumSpan(bounds),
): TraceWindow | null {
  const current = view ?? bounds;
  const pivot = anchor ?? (current.start + current.end) / 2;
  const start = pivot - (pivot - current.start) * factor;
  const end = pivot + (current.end - pivot) * factor;
  return clampWindow({ start, end }, bounds, minSpan);
}

export function panWindow(
  bounds: TraceSpan,
  view: TraceWindow | null,
  direction: -1 | 1,
  minSpan = minimumSpan(bounds),
): TraceWindow | null {
  if (!view) {
    return null;
  }
  const shift = (view.end - view.start) * PAN_STEP * direction;
  return clampWindow({ start: view.start + shift, end: view.end + shift }, bounds, minSpan);
}

/**
 * Carries a window across a model change. On the time scale it is fitted to the
 * records still loaded. On the sequence scale positions renumber when records
 * arrive or leave, so the window follows the records it covered and clears when
 * either edge is gone.
 */
export function rebaseWindow(
  view: TraceWindow,
  previous: TraceModel,
  next: TraceModel,
  scale: TraceScale,
): TraceWindow | null {
  const bounds = boundsOf(next, scale);
  const minSpan = minimumSpan(bounds, scale);
  if (scale === 'time') {
    return fitWindow(view, bounds, minSpan);
  }
  const firstIndex = Math.floor(view.start);
  const lastIndex = Math.ceil(view.end) - 1;
  const first = recordAt(previous, firstIndex);
  const last = recordAt(previous, lastIndex);
  const nextFirst = first != null ? next.nodes.get(first.record.id) : undefined;
  const nextLast = last != null ? next.nodes.get(last.record.id) : undefined;
  if (nextFirst?.shown !== true || nextLast?.shown !== true) {
    return null;
  }
  return clampWindow(
    {
      start: nextFirst.sequence + (view.start - firstIndex),
      end: nextLast.sequence + (view.end - lastIndex),
    },
    bounds,
    minSpan,
  );
}

function recordAt(model: TraceModel, sequence: number): TraceNode | undefined {
  for (const node of model.nodes.values()) {
    if (node.shown && node.sequence === sequence) {
      return node;
    }
  }
  return undefined;
}

/** The narrowest zoom: one record on the sequence scale, a thousandth of the trace on time. */
export function minimumSpan(bounds: TraceSpan, scale: TraceScale = 'time'): number {
  return scale === 'sequence' ? 1 : Math.max((bounds.end - bounds.start) / 1000, 1);
}
