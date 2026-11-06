import type {
  SubagentDigest,
  SubagentDigestNode,
  SubagentDigestStatus,
} from 'librechat-data-provider';
import type {
  ActivityFold,
  ActivityLeaf,
  ActivityRun,
  ActivityTree,
  ActivityTurn,
  ActivitySummary,
} from './tree';
import { countActivity, findActiveLeaf, foldTurns } from './tree';

/**
 * Output bounds for one digest. 4,000 characters is about a thousand tokens: enough
 * for a folded history plus the open turn, small against the 100,000-character
 * bound on a collected background result.
 */
export const DIGEST_LIMITS: Readonly<{
  chars: number;
  expandNodes: number;
  argChars: number;
}> = Object.freeze({ chars: 4_000, expandNodes: 40, argChars: 64 });

/** A positional address: alternating turn and child numbers, optionally ending in a range. */
export interface DigestPath {
  text: string;
  segments: number[];
  rangeEnd?: number;
}

export interface DigestCursor {
  text: string;
  turn: number;
  child?: number;
}

export interface DigestRequest {
  expand?: DigestPath;
  since?: DigestCursor;
}

interface RenderContext {
  now: number;
  labelChars: number;
}

interface Shape {
  /** Turns before the open one that keep their own folded line. */
  individual: number;
  /** Aligned range lines for the turns before those. */
  ranges: number;
  /** Children of the open turn listed individually. */
  window: number;
  labelChars: number;
  /** Nested runs opened along the active path. */
  depth: number;
}

const DEFAULT_SHAPES: readonly Shape[] = [
  { individual: 5, ranges: 3, window: 12, labelChars: 72, depth: 2 },
  { individual: 3, ranges: 2, window: 8, labelChars: 48, depth: 2 },
  { individual: 1, ranges: 2, window: 5, labelChars: 32, depth: 1 },
  { individual: 0, ranges: 1, window: 3, labelChars: 0, depth: 0 },
];

const EXPAND_LABEL_CHARS: readonly number[] = [120, 48, 0];
const CHUNK_SIZES: readonly number[] = [5, 10, 25, 50, 100, 250, 500, 1_000, 10_000];
const PATH_PATTERN = /^(\d{1,6}(?:\.\d{1,6}){0,7})(?:-(\d{1,6}))?$/;
const CURSOR_PATTERN = /^(\d{1,6})(?:\.(\d{1,6}))?$/;

const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/** Form writers and some providers send `""` for an unset optional argument. */
function presentArg(value: unknown): unknown {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Reads the optional navigation arguments. Both are positional addresses taken from
 * an earlier digest, so a malformed one is reported rather than guessed at.
 */
export function parseDigestRequest(
  args: Record<string, unknown>,
): { request: DigestRequest } | { error: string } {
  const expand = presentArg(args.expand);
  const since = presentArg(args.since);
  if (expand != null && since != null) {
    return { error: 'Pass either expand or since, not both.' };
  }
  if (expand != null) {
    const match = typeof expand === 'string' ? PATH_PATTERN.exec(expand) : null;
    const segments = match?.[1].split('.').map(Number) ?? [];
    const rangeEnd = match?.[2] == null ? undefined : Number(match[2]);
    if (
      typeof expand !== 'string' ||
      match == null ||
      !segments.every(positive) ||
      (rangeEnd != null && rangeEnd < segments[segments.length - 1])
    ) {
      return {
        error: 'expand must be a node path from activity.nodes, such as "3", "3.2", or "1-14".',
      };
    }
    return { request: { expand: { text: expand, segments, rangeEnd } } };
  }
  if (since != null) {
    const match = typeof since === 'string' ? CURSOR_PATTERN.exec(since) : null;
    const zero =
      match != null && (Number(match[1]) === 0 || (match[2] != null && Number(match[2]) === 0));
    if (typeof since !== 'string' || match == null || zero) {
      return { error: 'since must be an activity.cursor value, such as "7" or "7.3".' };
    }
    return {
      request: {
        since: {
          text: since,
          turn: Number(match[1]),
          ...(match[2] == null ? {} : { child: Number(match[2]) }),
        },
      },
    };
  }
  return { request: {} };
}

const leafEnd = (leaf: ActivityLeaf, now: number): number =>
  leaf.endedAt ?? (leaf.status === 'running' ? now : leaf.startedAt);

const span = (start: number, end: number): number => Math.max(0, Math.round(end - start));

function clipLabel(label: string | undefined, maxChars: number): string | undefined {
  if (label == null || maxChars <= 0) {
    return undefined;
  }
  return label.length <= maxChars ? label : `${label.slice(0, maxChars - 1)}…`;
}

const plural = (total: number, noun: string): string => `${total} ${noun}${total === 1 ? '' : 's'}`;

function formatCounts(entries: ReadonlyArray<[string, number]>, other: number): string {
  const shown = entries
    .slice(0, 4)
    .map(([name, total]) => (total > 1 ? `${name} ×${total}` : name));
  const hidden = other + entries.slice(4).reduce((total, [, value]) => total + value, 0);
  return hidden > 0 ? `${shown.join(', ')} +${hidden} more` : shown.join(', ');
}

function leafCounts(leaves: readonly ActivityLeaf[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const leaf of leaves) {
    const name = leaf.kind === 'text' ? 'text' : (leaf.name ?? 'tool');
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

function foldSummary(fold: ActivityFold): string {
  const entries: Array<[string, number]> = [...fold.tools];
  if (fold.texts > 0) {
    entries.push(['text', fold.texts]);
  }
  entries.sort((left, right) => right[1] - left[1]);
  return formatCounts(entries, fold.otherTools);
}

function aggregateStatus(leaves: readonly ActivityLeaf[]): SubagentDigestStatus {
  let status: SubagentDigestStatus = 'ok';
  for (const leaf of leaves) {
    if (leaf.status === 'running') {
      return 'running';
    }
    if (leaf.status === 'error') {
      status = 'error';
    } else if (leaf.status === 'cancelled' && status === 'ok') {
      status = 'cancelled';
    }
  }
  return status;
}

const errorCount = (leaves: readonly ActivityLeaf[]): number =>
  leaves.reduce((total, leaf) => total + (leaf.status === 'error' ? 1 : 0), 0);

function leafNode(
  leaf: ActivityLeaf,
  path: string,
  context: RenderContext,
  folded: boolean,
): SubagentDigestNode {
  const label = clipLabel(leaf.label, context.labelChars);
  const nested = leaf.run == null ? undefined : countActivity(leaf.run);
  return {
    path,
    kind: leaf.kind,
    status: leaf.status,
    ...(leaf.kind === 'tool' && leaf.name != null ? { name: leaf.name } : {}),
    ...(label == null ? {} : { label }),
    ms: span(leaf.startedAt, leafEnd(leaf, context.now)),
    ...(leaf.chars == null || leaf.chars === 0 ? {} : { chars: leaf.chars }),
    ...(nested == null
      ? {}
      : {
          summary: `${plural(nested.turns, 'turn')}, ${plural(nested.tools, 'tool')}`,
          ...(nested.errors > 0 ? { errors: nested.errors } : {}),
          ...(folded ? { folded: true as const } : {}),
        }),
  };
}

function turnNode(
  turn: ActivityTurn,
  path: string,
  context: RenderContext,
  folded: boolean,
): SubagentDigestNode {
  const end = turn.children.reduce(
    (latest, leaf) => Math.max(latest, leafEnd(leaf, context.now)),
    turn.startedAt,
  );
  const errors = errorCount(turn.children);
  return {
    path,
    kind: 'turn',
    status: aggregateStatus(turn.children),
    ms: span(turn.startedAt, end),
    ...(folded
      ? { summary: formatCounts(leafCounts(turn.children), turn.overflow ?? 0), folded: true }
      : {}),
    ...(errors > 0 ? { errors } : {}),
  };
}

function foldNode(fold: ActivityFold, path: string, evicted: boolean): SubagentDigestNode {
  return {
    path,
    kind: 'range',
    status: fold.errors > 0 ? 'error' : 'ok',
    ms: span(fold.startedAt, fold.endedAt),
    summary: foldSummary(fold),
    ...(fold.errors > 0 ? { errors: fold.errors } : {}),
    folded: true,
    ...(evicted ? { evicted: true as const } : {}),
  };
}

function turnRangeNode(
  turns: readonly ActivityTurn[],
  path: string,
  context: RenderContext,
): SubagentDigestNode {
  const leaves = turns.flatMap((turn) => turn.children);
  const status = aggregateStatus(leaves);
  const fold = foldTurns(turns);
  return {
    ...foldNode(fold, path, false),
    status,
    ms: span(
      fold.startedAt,
      leaves.reduce((latest, leaf) => Math.max(latest, leafEnd(leaf, context.now)), fold.endedAt),
    ),
  };
}

function childRangeNode(
  leaves: readonly ActivityLeaf[],
  path: string,
  context: RenderContext,
): SubagentDigestNode {
  const start = leaves.reduce((first, leaf) => Math.min(first, leaf.startedAt), Infinity);
  const end = leaves.reduce((last, leaf) => Math.max(last, leafEnd(leaf, context.now)), 0);
  const errors = errorCount(leaves);
  return {
    path,
    kind: 'range',
    status: aggregateStatus(leaves),
    ms: Number.isFinite(start) ? span(start, end) : 0,
    summary: formatCounts(leafCounts(leaves), 0),
    ...(errors > 0 ? { errors } : {}),
    folded: true,
  };
}

/** Splits turn numbers into ranges aligned to round sizes, so they read stably across polls. */
function alignedChunks(first: number, last: number, maxChunks: number): Array<[number, number]> {
  if (last < first) {
    return [];
  }
  for (const size of CHUNK_SIZES) {
    const chunks: Array<[number, number]> = [];
    let start = first;
    while (start <= last) {
      const end = Math.min(last, (Math.floor((start - 1) / size) + 1) * size);
      chunks.push([start, end]);
      start = end + 1;
    }
    if (chunks.length <= Math.max(1, maxChunks)) {
      return chunks;
    }
  }
  return [[first, last]];
}

function rangeNodes(
  run: ActivityRun,
  fromIndex: number,
  toIndex: number,
  prefix: string,
  context: RenderContext,
  maxChunks: number,
): SubagentDigestNode[] {
  const base = run.evicted?.turns ?? 0;
  return alignedChunks(base + fromIndex + 1, base + toIndex, maxChunks).map(([start, end]) => {
    const turns = run.turns.slice(start - base - 1, end - base);
    if (start === end) {
      return turnNode(turns[0], `${prefix}${start}`, context, true);
    }
    return turnRangeNode(turns, `${prefix}${start}-${end}`, context);
  });
}

function openTurnNodes(
  turn: ActivityTurn,
  path: string,
  context: RenderContext,
  shape: Shape,
  firstChild = 0,
): SubagentDigestNode[] {
  const nodes = [turnNode(turn, path, context, false)];
  const children = turn.children;
  const start = Math.max(firstChild, children.length - shape.window);
  if (start > firstChild) {
    nodes.push(
      childRangeNode(
        children.slice(firstChild, start),
        `${path}.${firstChild + 1}-${start}`,
        context,
      ),
    );
  }
  for (let index = start; index < children.length; index++) {
    const leaf = children[index];
    const childPath = `${path}.${index + 1}`;
    const onPath =
      leaf.run != null &&
      shape.depth > 0 &&
      (leaf.status === 'running' || index === children.length - 1);
    nodes.push(leafNode(leaf, childPath, context, leaf.run != null && !onPath));
    if (onPath && leaf.run != null) {
      nodes.push(
        ...runNodes(leaf.run, `${childPath}.`, context, {
          ...shape,
          individual: Math.min(shape.individual, 2),
          ranges: 1,
          window: Math.min(shape.window, 6),
          depth: shape.depth - 1,
        }),
      );
    }
  }
  return nodes;
}

/** Folded history plus the newest turn opened, recursing along the active path. */
function runNodes(
  run: ActivityRun,
  prefix: string,
  context: RenderContext,
  shape: Shape,
): SubagentDigestNode[] {
  const base = run.evicted?.turns ?? 0;
  const nodes: SubagentDigestNode[] = [];
  if (run.evicted != null) {
    nodes.push(foldNode(run.evicted, `${prefix}1-${base}`, true));
  }
  const last = run.turns.length - 1;
  if (last < 0) {
    return nodes;
  }
  const firstIndividual = Math.max(0, last - shape.individual);
  nodes.push(...rangeNodes(run, 0, firstIndividual, prefix, context, shape.ranges));
  for (let index = firstIndividual; index < last; index++) {
    nodes.push(turnNode(run.turns[index], `${prefix}${base + index + 1}`, context, true));
  }
  nodes.push(...openTurnNodes(run.turns[last], `${prefix}${base + last + 1}`, context, shape));
  return nodes;
}

function sinceNodes(
  run: ActivityRun,
  since: DigestCursor,
  context: RenderContext,
  shape: Shape,
): SubagentDigestNode[] {
  const base = run.evicted?.turns ?? 0;
  const nodes: SubagentDigestNode[] = [];
  if (run.evicted != null && since.turn < base) {
    nodes.push(foldNode(run.evicted, `1-${base}`, true));
  }
  const groups: Array<{ index: number; firstChild: number }> = [];
  for (let index = 0; index < run.turns.length; index++) {
    const number = base + index + 1;
    if (number < since.turn || (number === since.turn && since.child == null)) {
      continue;
    }
    const firstChild = number === since.turn ? (since.child ?? 0) : 0;
    if (firstChild < run.turns[index].children.length) {
      groups.push({ index, firstChild });
    }
  }
  const detailed = groups.slice(-(shape.individual + 1));
  const folded = groups.slice(0, groups.length - detailed.length);
  if (folded.length > 0) {
    /** New turns are consecutive, so older ones fold into aligned ranges. */
    nodes.push(
      ...rangeNodes(
        run,
        folded[0].index,
        folded[folded.length - 1].index + 1,
        '',
        context,
        shape.ranges,
      ),
    );
  }
  for (const group of detailed) {
    nodes.push(
      ...openTurnNodes(
        run.turns[group.index],
        `${base + group.index + 1}`,
        context,
        shape,
        group.firstChild,
      ),
    );
  }
  return nodes;
}

function runHeaderNodes(
  run: ActivityRun,
  prefix: string,
  context: RenderContext,
): SubagentDigestNode[] {
  const base = run.evicted?.turns ?? 0;
  const nodes: SubagentDigestNode[] =
    run.evicted == null ? [] : [foldNode(run.evicted, `${prefix}1-${base}`, true)];
  if (run.turns.length <= DIGEST_LIMITS.expandNodes) {
    run.turns.forEach((turn, index) => {
      nodes.push(turnNode(turn, `${prefix}${base + index + 1}`, context, true));
    });
    return nodes;
  }
  return [...nodes, ...rangeNodes(run, 0, run.turns.length, prefix, context, 20)];
}

function turnRange(
  run: ActivityRun,
  prefix: string,
  first: number,
  last: number,
  context: RenderContext,
): SubagentDigestNode[] {
  const base = run.evicted?.turns ?? 0;
  const nodes: SubagentDigestNode[] = [];
  if (run.evicted != null && first <= base) {
    nodes.push(foldNode(run.evicted, `${prefix}1-${base}`, true));
  }
  const fromIndex = Math.max(first, base + 1) - base - 1;
  const toIndex = Math.min(last - base, run.turns.length);
  if (toIndex <= fromIndex) {
    return nodes;
  }
  if (toIndex - fromIndex <= DIGEST_LIMITS.expandNodes) {
    for (let index = fromIndex; index < toIndex; index++) {
      nodes.push(turnNode(run.turns[index], `${prefix}${base + index + 1}`, context, true));
    }
    return nodes;
  }
  return [...nodes, ...rangeNodes(run, fromIndex, toIndex, prefix, context, 20)];
}

function childNodes(
  turn: ActivityTurn,
  path: string,
  first: number,
  last: number,
  context: RenderContext,
): SubagentDigestNode[] {
  const leaves = turn.children.slice(first - 1, last);
  if (leaves.length > DIGEST_LIMITS.expandNodes) {
    const shown = leaves.slice(-DIGEST_LIMITS.expandNodes);
    const hiddenEnd = first - 1 + leaves.length - shown.length;
    return [
      childRangeNode(
        leaves.slice(0, leaves.length - shown.length),
        `${path}.${first}-${hiddenEnd}`,
        context,
      ),
      ...shown.map((leaf, index) =>
        leafNode(leaf, `${path}.${hiddenEnd + index + 1}`, context, leaf.run != null),
      ),
    ];
  }
  return leaves.map((leaf, index) =>
    leafNode(leaf, `${path}.${first + index}`, context, leaf.run != null),
  );
}

/**
 * Resolves one address and returns that node with its direct children folded.
 * Turn numbers sit at even positions and child numbers at odd ones, so `3.2.1` is
 * the first turn of the run started by turn 3's second child.
 */
function expandNodes(
  tree: ActivityTree,
  target: DigestPath,
  context: RenderContext,
): { nodes: SubagentDigestNode[]; note?: string } {
  let run = tree.root;
  let prefix = '';
  let turn: ActivityTurn | undefined;
  let turnPath = '';
  const notFound = { nodes: [], note: `No node at ${target.text}.` };
  for (let position = 0; position < target.segments.length; position++) {
    const value = target.segments[position];
    const last = position === target.segments.length - 1;
    if (position % 2 === 0) {
      const base = run.evicted?.turns ?? 0;
      if (last && target.rangeEnd != null) {
        const nodes = turnRange(run, prefix, value, target.rangeEnd, context);
        return nodes.length === 0 ? notFound : { nodes };
      }
      if (value <= base && run.evicted != null) {
        return {
          nodes: [foldNode(run.evicted, `${prefix}1-${base}`, true)],
          note: `Turn ${prefix}${value} is summarized only; its detail is no longer retained.`,
        };
      }
      turn = run.turns[value - base - 1];
      if (turn == null) {
        return notFound;
      }
      turnPath = `${prefix}${value}`;
      if (last) {
        return {
          nodes: [
            turnNode(turn, turnPath, context, false),
            ...childNodes(turn, turnPath, 1, turn.children.length, context),
          ],
        };
      }
      continue;
    }
    if (turn == null) {
      return notFound;
    }
    if (last && target.rangeEnd != null) {
      const nodes = childNodes(turn, turnPath, value, target.rangeEnd, context);
      return nodes.length === 0 ? notFound : { nodes };
    }
    const leaf = turn.children[value - 1];
    if (leaf == null) {
      return notFound;
    }
    const leafPath = `${turnPath}.${value}`;
    if (last) {
      return {
        nodes: [
          leafNode(leaf, leafPath, context, false),
          ...(leaf.run == null ? [] : runHeaderNodes(leaf.run, `${leafPath}.`, context)),
        ],
      };
    }
    if (leaf.run == null) {
      return notFound;
    }
    run = leaf.run;
    prefix = `${leafPath}.`;
  }
  return notFound;
}

/** The last root-level node such that it and every node before it have settled. */
function settledCursor(run: ActivityRun): string | undefined {
  const base = run.evicted?.turns ?? 0;
  let cursor: string | undefined = base > 0 ? `${base}` : undefined;
  for (let index = 0; index < run.turns.length; index++) {
    const children = run.turns[index].children;
    for (let child = 0; child < children.length; child++) {
      if (children[child].status === 'running') {
        return cursor;
      }
      cursor = `${base + index + 1}.${child + 1}`;
    }
  }
  return cursor;
}

function headline(
  run: ActivityRun,
  state: { updatedAt: number; thinking?: boolean; activePath?: string },
  context: RenderContext,
  running: boolean,
): Omit<SubagentDigest, 'nodes'> {
  const totals = countActivity(run);
  const idle = running && state.activePath == null;
  return {
    ...totals,
    ...(state.activePath == null ? {} : { active: state.activePath }),
    ...(idle && state.thinking === true ? { phase: 'thinking' as const } : {}),
    ...(idle ? { idle_ms: span(state.updatedAt, context.now) } : {}),
  };
}

const fits = (digest: SubagentDigest): boolean =>
  JSON.stringify(digest).length <= DIGEST_LIMITS.chars;

/** Drops the oldest nodes until the digest fits; the newest carry the active path. */
function clamp(digest: SubagentDigest): SubagentDigest {
  const nodes = [...digest.nodes];
  let clamped: SubagentDigest = { ...digest, nodes, truncated: true };
  while (nodes.length > 0 && !fits(clamped)) {
    nodes.shift();
    clamped = { ...digest, nodes: [...nodes], truncated: true };
  }
  return clamped;
}

function rebuiltDescription(rebuilt: { partial: boolean }): string {
  const base =
    'Rebuilt from the saved activity summary after the process that ran this subagent ended; paths from earlier checks may not match.';
  return rebuilt.partial ? `${base} The summary kept only the newest activity.` : base;
}

function joinNotes(...notes: Array<string | undefined>): string | undefined {
  const present = notes.filter((note): note is string => note != null);
  return present.length === 0 ? undefined : present.join(' ');
}

/**
 * Renders a navigable digest of one task's progress tree. With no request it
 * returns the folded history and the open turn along the active path; `since`
 * returns only nodes after a cursor; `expand` returns one node and its direct
 * children. Every form is bounded by {@link DIGEST_LIMITS.chars}.
 */
export function renderDigest(
  tree: ActivityTree,
  options: { now: number; running: boolean; request?: DigestRequest },
): SubagentDigest {
  const { now, running, request } = options;
  const active = findActiveLeaf(tree.root);
  const cursor = settledCursor(tree.root);
  const head = headline(
    tree.root,
    { updatedAt: tree.updatedAt, thinking: tree.thinking, activePath: active?.path },
    { now, labelChars: 0 },
    running,
  );
  const withCursor = {
    ...head,
    ...(cursor == null ? {} : { cursor }),
    ...(tree.rebuilt?.partial === true ? { truncated: true as const } : {}),
  };
  const rebuiltNote = tree.rebuilt == null ? undefined : rebuiltDescription(tree.rebuilt);

  if (request?.expand != null) {
    const expand = request.expand;
    let digest: SubagentDigest = { ...withCursor, nodes: [], expanded: expand.text };
    for (const labelChars of EXPAND_LABEL_CHARS) {
      const { nodes, note } = expandNodes(tree, expand, { now, labelChars });
      const combined = joinNotes(rebuiltNote, note);
      digest = {
        ...withCursor,
        expanded: expand.text,
        nodes,
        ...(combined == null ? {} : { note: combined }),
      };
      if (fits(digest)) {
        return digest;
      }
    }
    return clamp(digest);
  }

  const since = request?.since;
  let digest: SubagentDigest = { ...withCursor, nodes: [] };
  for (const [index, shape] of DEFAULT_SHAPES.entries()) {
    const context = { now, labelChars: shape.labelChars };
    const nodes =
      since == null
        ? runNodes(tree.root, '', context, shape)
        : sinceNodes(tree.root, since, context, shape);
    digest = {
      ...withCursor,
      ...(since == null ? {} : { since: since.text }),
      nodes,
      ...(index > 0 ? { truncated: true as const } : {}),
    };
    const note = joinNotes(
      rebuiltNote,
      since != null && nodes.length === 0 ? `No new activity since ${since.text}.` : undefined,
    );
    if (note != null) {
      digest.note = note;
    }
    if (fits(digest)) {
      return digest;
    }
  }
  return clamp(digest);
}

/** The list-path digest: counts plus the node in flight, never history. */
export function renderSummaryDigest(
  summary: ActivitySummary,
  options: { now: number; running: boolean },
): SubagentDigest {
  const context = { now: options.now, labelChars: 72 };
  return {
    turns: summary.turns,
    tools: summary.tools,
    errors: summary.errors,
    ...(summary.active == null ? {} : { active: summary.active.path }),
    ...(options.running && summary.active == null && summary.thinking === true
      ? { phase: 'thinking' as const }
      : {}),
    ...(options.running && summary.active == null
      ? { idle_ms: span(summary.updatedAt, options.now) }
      : {}),
    nodes:
      summary.active == null
        ? []
        : [leafNode(summary.active.leaf, summary.active.path, context, false)],
  };
}
