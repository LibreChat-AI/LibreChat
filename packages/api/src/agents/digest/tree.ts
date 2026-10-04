import { isFailedToolOutput } from 'librechat-data-provider';
import type { SubagentDigestStatus, SubagentActivityItem } from 'librechat-data-provider';
import type { SubagentTaskSnapshot } from '@librechat/agents';

/**
 * Retention bounds for one task's progress tree. The tree travels inside routed
 * claim responses between replicas, so every bound here caps a wire payload too.
 */
export const ACTIVITY_TREE_LIMITS: Readonly<{
  rootTurns: number;
  nestedTurns: number;
  turnChildren: number;
  leaves: number;
  depth: number;
  nameChars: number;
  labelChars: number;
  foldTools: number;
}> = Object.freeze({
  rootTurns: 48,
  nestedTurns: 12,
  turnChildren: 32,
  leaves: 300,
  /** The task's own run plus two levels of subagents it starts. */
  depth: 3,
  nameChars: 64,
  labelChars: 120,
  foldTools: 16,
});

/** One tool call or text reply inside a turn; a subagent call may hold a nested run. */
export interface ActivityLeaf {
  kind: 'tool' | 'text';
  name?: string;
  label?: string;
  status: SubagentDigestStatus;
  startedAt: number;
  endedAt?: number;
  chars?: number;
  run?: ActivityRun;
}

/** One model response and the tool calls it made. */
export interface ActivityTurn {
  startedAt: number;
  children: ActivityLeaf[];
  /** Children past the per-turn cap: counted, never retained or addressed. */
  overflow?: number;
}

/** Aggregate of turns no longer retained, so their range still reads truthfully. */
export interface ActivityFold {
  turns: number;
  tools: Array<[string, number]>;
  otherTools: number;
  texts: number;
  errors: number;
  startedAt: number;
  endedAt: number;
}

export interface ActivityRun {
  /** Turns `1..evicted.turns`; retained turns are numbered after them. */
  evicted?: ActivityFold;
  turns: ActivityTurn[];
}

/** A task's bounded progress tree. Paths into it are positional and append-only. */
export interface ActivityTree {
  version: 1;
  root: ActivityRun;
  /** Epoch milliseconds of the child's most recent activity. */
  updatedAt: number;
  /** The child is reasoning with no tool call or reply in flight. */
  thinking?: boolean;
  /**
   * Rebuilt from the settlement-time public projection after the owner was gone.
   * Its turn split and paths are a reconstruction and may differ from the live
   * tree's; `partial` means the projection itself kept only the newest activity.
   */
  rebuilt?: { partial: boolean };
}

/** The list-path view: counts plus the node in flight, never the whole tree. */
export interface ActivitySummary {
  turns: number;
  tools: number;
  errors: number;
  updatedAt: number;
  thinking?: boolean;
  active?: { path: string; leaf: ActivityLeaf };
}

/** A task snapshot as the host decorates it for the poll tool. */
export type ActivitySnapshot = SubagentTaskSnapshot & {
  activity?: ActivityTree;
  activitySummary?: ActivitySummary;
};

const STATUSES: ReadonlySet<string> = new Set(['running', 'ok', 'error', 'cancelled']);
const UI_RESOURCE_MARKER = /\\ui\{[\w]+(?:,[\w]+)*\}/g;
/** C0/C1 controls, bidi overrides and isolates, and citation private-use markers. */
const isUnsafeCode = (code: number): boolean =>
  code <= 0x1f ||
  (code >= 0x7f && code <= 0x9f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069) ||
  (code >= 0xe200 && code <= 0xe206);

function replaceUnsafe(value: string): string {
  let line = '';
  for (const char of value) {
    line += isUnsafeCode(char.codePointAt(0) ?? 0) ? ' ' : char;
  }
  return line;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);

const timestamp = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const count = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;

/**
 * Normalizes a model- or tool-authored display string to one bounded line. Labels
 * are the child's own one-line intents, so this only strips rendering markers and
 * control characters; it never reads beyond the string it is given.
 */
export function sanitizeActivityText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string' || maxChars <= 0) {
    return undefined;
  }
  const line = replaceUnsafe(value.replace(UI_RESOURCE_MARKER, '')).replace(/\s+/g, ' ').trim();
  if (line === '') {
    return undefined;
  }
  return line.length <= maxChars ? line : `${line.slice(0, Math.max(1, maxChars - 1))}…`;
}

const coerceArgs = (args: unknown): Record<string, unknown> | undefined => {
  if (isRecord(args)) {
    return args;
  }
  if (typeof args !== 'string' || !args.trimStart().startsWith('{')) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(args);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Reads only the model-authored `intent` label from tool-call arguments. The host
 * injects that label as the first property, and the chat UI only treats a first
 * `intent` key as a label, so a tool's own `intent` business field stays unread.
 */
export function readActivityIntent(args: unknown): string | undefined {
  const parsed = coerceArgs(args);
  if (parsed == null || Object.keys(parsed)[0] !== 'intent') {
    return undefined;
  }
  return sanitizeActivityText(parsed.intent, ACTIVITY_TREE_LIMITS.labelChars);
}

export function emptyFold(at: number): ActivityFold {
  return { turns: 0, tools: [], otherTools: 0, texts: 0, errors: 0, startedAt: at, endedAt: at };
}

const leafEnd = (leaf: ActivityLeaf): number => leaf.endedAt ?? leaf.startedAt;

/** Adds turns to a fold, keeping the most frequent tool names within the bound. */
export function foldTurns(turns: readonly ActivityTurn[], into?: ActivityFold): ActivityFold {
  const fold = into ?? emptyFold(turns[0]?.startedAt ?? 0);
  const tools = new Map<string, number>(fold.tools);
  let otherTools = fold.otherTools;
  for (const turn of turns) {
    fold.turns += 1;
    fold.startedAt = Math.min(fold.startedAt, turn.startedAt);
    otherTools += turn.overflow ?? 0;
    for (const leaf of turn.children) {
      fold.endedAt = Math.max(fold.endedAt, leafEnd(leaf));
      if (leaf.status === 'error') {
        fold.errors += 1;
      }
      if (leaf.kind === 'text') {
        fold.texts += 1;
        continue;
      }
      const name = leaf.name ?? 'tool';
      tools.set(name, (tools.get(name) ?? 0) + 1);
    }
  }
  const ranked = [...tools.entries()].sort((left, right) => right[1] - left[1]);
  fold.tools = ranked.slice(0, ACTIVITY_TREE_LIMITS.foldTools);
  fold.otherTools =
    otherTools +
    ranked.slice(ACTIVITY_TREE_LIMITS.foldTools).reduce((total, [, value]) => total + value, 0);
  return fold;
}

export function countLeaves(run: ActivityRun): number {
  let total = 0;
  for (const turn of run.turns) {
    for (const leaf of turn.children) {
      total += 1 + (leaf.run == null ? 0 : countLeaves(leaf.run));
    }
  }
  return total;
}

/** Walks the root run to the most recent leaf still in flight, through nested runs. */
export function findActiveLeaf(
  run: ActivityRun,
  prefix = '',
): { path: string; leaf: ActivityLeaf } | undefined {
  const base = run.evicted?.turns ?? 0;
  for (let turnIndex = run.turns.length - 1; turnIndex >= 0; turnIndex--) {
    const children = run.turns[turnIndex].children;
    for (let childIndex = children.length - 1; childIndex >= 0; childIndex--) {
      const leaf = children[childIndex];
      if (leaf.status !== 'running') {
        continue;
      }
      const path = `${prefix}${base + turnIndex + 1}.${childIndex + 1}`;
      const nested = leaf.run == null ? undefined : findActiveLeaf(leaf.run, `${path}.`);
      return nested ?? { path, leaf };
    }
  }
  return undefined;
}

/** Root-level counters shared by the full digest and the list summary. */
export function countActivity(run: ActivityRun): { turns: number; tools: number; errors: number } {
  let tools = 0;
  let errors = run.evicted?.errors ?? 0;
  for (const [, value] of run.evicted?.tools ?? []) {
    tools += value;
  }
  tools += run.evicted?.otherTools ?? 0;
  for (const turn of run.turns) {
    tools += turn.overflow ?? 0;
    for (const leaf of turn.children) {
      if (leaf.kind === 'tool') {
        tools += 1;
      }
      if (leaf.status === 'error') {
        errors += 1;
      }
    }
  }
  return { turns: (run.evicted?.turns ?? 0) + run.turns.length, tools, errors };
}

export function summarizeActivityTree(tree: ActivityTree): ActivitySummary {
  const active = findActiveLeaf(tree.root);
  return {
    ...countActivity(tree.root),
    updatedAt: tree.updatedAt,
    ...(tree.thinking === true ? { thinking: true } : {}),
    ...(active == null
      ? {}
      : { active: { path: active.path, leaf: { ...active.leaf, run: undefined } } }),
  };
}

function boundFold(value: unknown): ActivityFold | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const turns = count(value.turns);
  const startedAt = timestamp(value.startedAt);
  const endedAt = timestamp(value.endedAt);
  if (turns == null || turns === 0 || startedAt == null || endedAt == null) {
    return undefined;
  }
  const tools = Array.isArray(value.tools)
    ? value.tools.flatMap((entry): Array<[string, number]> => {
        if (!Array.isArray(entry) || entry.length !== 2) {
          return [];
        }
        const name = sanitizeActivityText(entry[0], ACTIVITY_TREE_LIMITS.nameChars);
        const total = count(entry[1]);
        return name == null || total == null ? [] : [[name, total]];
      })
    : [];
  return {
    turns,
    tools: tools.slice(0, ACTIVITY_TREE_LIMITS.foldTools),
    otherTools: count(value.otherTools) ?? 0,
    texts: count(value.texts) ?? 0,
    errors: count(value.errors) ?? 0,
    startedAt,
    endedAt,
  };
}

interface BoundBudget {
  leaves: number;
}

function boundLeaf(value: unknown, depth: number, budget: BoundBudget): ActivityLeaf | undefined {
  if (!isRecord(value) || budget.leaves <= 0) {
    return undefined;
  }
  const kind = value.kind === 'tool' || value.kind === 'text' ? value.kind : undefined;
  const status =
    typeof value.status === 'string' && STATUSES.has(value.status)
      ? (value.status as SubagentDigestStatus)
      : undefined;
  const startedAt = timestamp(value.startedAt);
  if (kind == null || status == null || startedAt == null) {
    return undefined;
  }
  budget.leaves -= 1;
  const name = sanitizeActivityText(value.name, ACTIVITY_TREE_LIMITS.nameChars);
  const label = sanitizeActivityText(value.label, ACTIVITY_TREE_LIMITS.labelChars);
  const endedAt = timestamp(value.endedAt);
  const chars = count(value.chars);
  const run =
    kind === 'tool' && depth + 1 < ACTIVITY_TREE_LIMITS.depth
      ? boundRun(value.run, depth + 1, budget)
      : undefined;
  return {
    kind,
    status,
    startedAt,
    ...(name == null ? {} : { name }),
    ...(label == null ? {} : { label }),
    ...(endedAt == null ? {} : { endedAt }),
    ...(chars == null ? {} : { chars }),
    ...(run == null ? {} : { run }),
  };
}

function boundRun(value: unknown, depth: number, budget: BoundBudget): ActivityRun | undefined {
  if (!isRecord(value) || !Array.isArray(value.turns)) {
    return undefined;
  }
  const maxTurns = depth === 0 ? ACTIVITY_TREE_LIMITS.rootTurns : ACTIVITY_TREE_LIMITS.nestedTurns;
  /** Owners fold old turns before sending. Re-folding here would renumber nothing
   * but would trust a peer that ignored the bound, so an oversized run is refused. */
  if (value.turns.length > maxTurns) {
    return undefined;
  }
  const evicted = boundFold(value.evicted);
  const turns: ActivityTurn[] = [];
  for (const candidate of value.turns) {
    if (!isRecord(candidate) || !Array.isArray(candidate.children)) {
      return undefined;
    }
    const startedAt = timestamp(candidate.startedAt);
    if (startedAt == null) {
      return undefined;
    }
    const children = candidate.children
      .slice(0, ACTIVITY_TREE_LIMITS.turnChildren)
      .map((child) => boundLeaf(child, depth, budget));
    if (children.some((child) => child == null)) {
      return undefined;
    }
    const overflow =
      (count(candidate.overflow) ?? 0) +
      Math.max(0, candidate.children.length - ACTIVITY_TREE_LIMITS.turnChildren);
    turns.push({
      startedAt,
      children: children as ActivityLeaf[],
      ...(overflow > 0 ? { overflow } : {}),
    });
  }
  return { ...(evicted == null ? {} : { evicted }), turns };
}

/**
 * Validates a tree from another replica or a decorated snapshot and re-applies
 * every bound. A malformed tree is dropped whole rather than renumbered, because a
 * partial tree would hand the model paths that address different nodes.
 */
export function boundActivityTree(value: unknown): ActivityTree | undefined {
  if (!isRecord(value) || value.version !== 1) {
    return undefined;
  }
  const updatedAt = timestamp(value.updatedAt);
  const root = boundRun(value.root, 0, { leaves: ACTIVITY_TREE_LIMITS.leaves });
  if (updatedAt == null || root == null) {
    return undefined;
  }
  const rebuilt = isRecord(value.rebuilt) ? { partial: value.rebuilt.partial === true } : undefined;
  return {
    version: 1,
    root,
    updatedAt,
    ...(value.thinking === true ? { thinking: true } : {}),
    ...(rebuilt == null ? {} : { rebuilt }),
  };
}

const PATH_PATTERN = /^\d{1,6}(?:\.\d{1,6})*$/;

export function boundActivitySummary(value: unknown): ActivitySummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const turns = count(value.turns);
  const tools = count(value.tools);
  const errors = count(value.errors);
  const updatedAt = timestamp(value.updatedAt);
  if (turns == null || tools == null || errors == null || updatedAt == null) {
    return undefined;
  }
  let active: ActivitySummary['active'];
  if (isRecord(value.active) && typeof value.active.path === 'string') {
    const leaf = boundLeaf(value.active.leaf, ACTIVITY_TREE_LIMITS.depth, { leaves: 1 });
    if (leaf != null && value.active.path.length <= 64 && PATH_PATTERN.test(value.active.path)) {
      active = { path: value.active.path, leaf };
    }
  }
  return {
    turns,
    tools,
    errors,
    updatedAt,
    ...(value.thinking === true ? { thinking: true } : {}),
    ...(active == null ? {} : { active }),
  };
}

/** Reads the host decoration from a snapshot without trusting its shape. */
export function snapshotActivity(task: SubagentTaskSnapshot): ActivityTree | undefined {
  const decorated = task as ActivitySnapshot;
  return decorated.activity == null ? undefined : boundActivityTree(decorated.activity);
}

export function snapshotActivitySummary(task: SubagentTaskSnapshot): ActivitySummary | undefined {
  const decorated = task as ActivitySnapshot;
  return decorated.activitySummary == null
    ? undefined
    : boundActivitySummary(decorated.activitySummary);
}

/** Copies a snapshot's bounded decorations onto a rebuilt snapshot. */
export function carryActivity(
  from: SubagentTaskSnapshot,
  to: SubagentTaskSnapshot,
): ActivitySnapshot {
  const activity = snapshotActivity(from);
  const activitySummary = snapshotActivitySummary(from);
  return {
    ...to,
    ...(activity == null ? {} : { activity }),
    ...(activitySummary == null ? {} : { activitySummary }),
  };
}

/** Current SDK results can persist a failure as a completed message, so a
 * completed status is re-checked against the same verdict the live recorder uses. */
const projectionStatus = (
  item: Extract<SubagentActivityItem, { type: 'tool' }>,
): SubagentDigestStatus => {
  if (item.status === 'failed') return 'error';
  if (item.status !== 'completed') return item.status;
  const failed =
    item.inputValidationError === true || (item.output != null && isFailedToolOutput(item.output));
  return failed ? 'error' : 'ok';
};

/**
 * Rebuilds a coarse tree from the durable public activity projection a completed
 * child persisted at settlement. It carries no timings, so every node shares the
 * task's own window; it exists so a finished result can still be navigated after
 * the owning process has gone. Tool results arrive in result order, and a reply
 * after a tool result starts the next turn, so the tree is marked `rebuilt`.
 */
export function activityTreeFromProjection(
  items: readonly SubagentActivityItem[],
  window: { startedAt: number; settledAt: number; truncated?: boolean },
): ActivityTree | undefined {
  const root: ActivityRun = { turns: [] };
  let turn: ActivityTurn | undefined;
  let sawTool = false;
  let leaves = 0;
  const open = (): ActivityTurn => {
    const next: ActivityTurn = { startedAt: window.startedAt, children: [] };
    root.turns.push(next);
    sawTool = false;
    return next;
  };
  for (const item of items) {
    if (item.type !== 'tool' && item.type !== 'writing') {
      continue;
    }
    if (turn == null || (item.type === 'writing' && sawTool)) {
      turn = open();
    }
    if (turn.children.length >= ACTIVITY_TREE_LIMITS.turnChildren) {
      turn.overflow = (turn.overflow ?? 0) + 1;
      continue;
    }
    leaves += 1;
    if (item.type === 'writing') {
      turn.children.push({
        kind: 'text',
        status: 'ok',
        startedAt: window.startedAt,
        endedAt: window.settledAt,
        chars: item.text.length,
      });
      continue;
    }
    sawTool = true;
    const label = readActivityIntent(item.input);
    turn.children.push({
      kind: 'tool',
      name: sanitizeActivityText(item.name, ACTIVITY_TREE_LIMITS.nameChars) ?? 'tool',
      status: projectionStatus(item),
      startedAt: window.startedAt,
      endedAt: window.settledAt,
      ...(label == null ? {} : { label }),
      ...(item.output == null ? {} : { chars: item.output.length }),
    });
  }
  if (leaves === 0) {
    return undefined;
  }
  const evictedTurns = root.turns.splice(
    0,
    Math.max(0, root.turns.length - ACTIVITY_TREE_LIMITS.rootTurns),
  );
  const run: ActivityRun =
    evictedTurns.length === 0 ? root : { evicted: foldTurns(evictedTurns), turns: root.turns };
  return boundActivityTree({
    version: 1,
    root: run,
    updatedAt: window.settledAt,
    rebuilt: { partial: window.truncated === true },
  });
}
