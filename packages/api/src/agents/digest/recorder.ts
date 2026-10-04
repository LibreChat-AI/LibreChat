import { isFailedToolOutput } from 'librechat-data-provider';
import type { SubagentDigestStatus } from 'librechat-data-provider';
import type { SubagentUpdateEvent } from '@librechat/agents';
import type {
  ActivityRun,
  ActivityLeaf,
  ActivityTree,
  ActivityTurn,
  ActivitySummary,
} from './tree';
import {
  foldTurns,
  emptyFold,
  countLeaves,
  readActivityIntent,
  sanitizeActivityText,
  ACTIVITY_TREE_LIMITS,
  summarizeActivityTree,
} from './tree';

interface RunState {
  run: ActivityRun;
  depth: number;
  maxTurns: number;
  toolByCallId: Map<string, ActivityLeaf>;
  textByStepId: Map<string, ActivityLeaf>;
  callIdsByStepId: Map<string, string[]>;
}

interface ToolCallShape {
  id?: unknown;
  name?: unknown;
  args?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);

const toolCalls = (value: unknown): ToolCallShape[] =>
  Array.isArray(value) ? value.filter((call): call is ToolCallShape => isRecord(call)) : [];

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** Text characters in one message delta; content is measured, never retained. */
function deltaChars(data: Record<string, unknown>): number {
  const delta = isRecord(data.delta) ? data.delta : undefined;
  if (!Array.isArray(delta?.content)) {
    return 0;
  }
  let chars = 0;
  for (const part of delta.content) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      chars += part.text.length;
    }
  }
  return chars;
}

function settleLeaves(run: ActivityRun, status: SubagentDigestStatus, at: number): void {
  for (const turn of run.turns) {
    for (const leaf of turn.children) {
      if (leaf.run != null) {
        settleLeaves(leaf.run, status, at);
      }
      if (leaf.status === 'running') {
        leaf.status = status;
        leaf.endedAt = at;
      }
    }
  }
}

function collectLeaves(
  turns: readonly ActivityTurn[],
  overflow: WeakMap<ActivityTurn, ActivityLeaf[]>,
  into: Set<ActivityLeaf>,
): void {
  for (const turn of turns) {
    for (const leaf of overflow.get(turn) ?? []) {
      into.add(leaf);
    }
    for (const leaf of turn.children) {
      into.add(leaf);
      if (leaf.run != null) {
        collectLeaves(leaf.run.turns, overflow, into);
      }
    }
  }
}

/**
 * Folds one detached child's update stream into its bounded progress tree on the
 * process that owns the child. It reads only identities, tool names, the
 * model-authored `intent` label, the tool-authored `outcome` label, and sizes:
 * tool arguments, outputs, and reply text never enter the tree.
 *
 * A turn is one model response: it opens with the first reply or tool call after
 * every tool call of the previous turn has settled, so tool calls streamed as
 * separate steps of one response stay together. Events from a subagent the child
 * starts (a different `subagentRunId` whose `parentToolCallId` is a recorded call)
 * nest under that call, up to {@link ACTIVITY_TREE_LIMITS.depth} runs deep.
 */
export class ActivityRecorder {
  private readonly tree: ActivityTree;
  private readonly runs = new Map<string, RunState>();
  private readonly callOwners = new Map<string, { leaf: ActivityLeaf; depth: number }>();
  private readonly overflowLeaves = new WeakMap<ActivityTurn, ActivityLeaf[]>();
  private rootRunId?: string;
  private leaves = 0;

  constructor(now: number = Date.now()) {
    this.tree = { version: 1, root: { turns: [] }, updatedAt: now };
  }

  record(event: SubagentUpdateEvent, now: number = Date.now()): void {
    const state = this.runFor(event);
    if (state == null) {
      return;
    }
    this.tree.updatedAt = now;
    if (state.depth === 0) {
      this.tree.thinking = event.phase === 'reasoning_delta' ? true : undefined;
    }
    const data = isRecord(event.data) ? event.data : undefined;
    if (data == null) {
      if (event.phase === 'stop' || event.phase === 'error') {
        this.finishNested(state, event.phase === 'stop' ? 'ok' : 'error', now);
      }
      return;
    }
    switch (event.phase) {
      case 'run_step':
        this.recordStep(state, data, now);
        return;
      case 'tool_calls_dispatched':
        for (const call of toolCalls(data.toolCalls)) {
          const id = nonEmpty(call.id);
          if (id != null) {
            this.ensureTool(state, id, call.name, now);
          }
        }
        return;
      case 'run_step_completed':
        this.recordCompletion(state, data, now);
        return;
      case 'run_step_closed':
        this.recordClose(state, data, now);
        return;
      case 'message_delta':
        this.recordText(state, data, now);
        return;
      case 'stop':
      case 'error':
        this.finishNested(state, event.phase === 'stop' ? 'ok' : 'error', now);
        return;
      default:
        return;
    }
  }

  /** Closes every node still in flight when the task itself settles. */
  settle(status: 'completed' | 'error' | 'cancelled', now: number = Date.now()): void {
    let leafStatus: SubagentDigestStatus = 'error';
    if (status === 'completed') {
      leafStatus = 'ok';
    } else if (status === 'cancelled') {
      leafStatus = 'cancelled';
    }
    settleLeaves(this.tree.root, leafStatus, now);
    this.tree.thinking = undefined;
    this.tree.updatedAt = Math.max(this.tree.updatedAt, now);
  }

  /** An independent copy: callers serialize it while the child keeps recording. */
  snapshot(): ActivityTree {
    return structuredClone(this.tree);
  }

  summary(): ActivitySummary {
    return summarizeActivityTree(this.tree);
  }

  private runFor(event: SubagentUpdateEvent): RunState | undefined {
    const runId = nonEmpty(event.subagentRunId);
    if (runId == null) {
      return undefined;
    }
    const existing = this.runs.get(runId);
    if (existing != null) {
      return existing;
    }
    if (this.rootRunId == null) {
      this.rootRunId = runId;
      return this.addRun(runId, this.tree.root, 0);
    }
    const parentCallId = nonEmpty(event.parentToolCallId);
    const owner = parentCallId == null ? undefined : this.callOwners.get(parentCallId);
    if (owner == null || owner.depth + 1 >= ACTIVITY_TREE_LIMITS.depth) {
      return undefined;
    }
    owner.leaf.run ??= { turns: [] };
    return this.addRun(runId, owner.leaf.run, owner.depth + 1);
  }

  private addRun(runId: string, run: ActivityRun, depth: number): RunState {
    const state: RunState = {
      run,
      depth,
      maxTurns: depth === 0 ? ACTIVITY_TREE_LIMITS.rootTurns : ACTIVITY_TREE_LIMITS.nestedTurns,
      toolByCallId: new Map(),
      textByStepId: new Map(),
      callIdsByStepId: new Map(),
    };
    this.runs.set(runId, state);
    return state;
  }

  private recordStep(state: RunState, data: Record<string, unknown>, now: number): void {
    /** The SDK forwards tool execution requests on this phase with complete args. */
    for (const call of toolCalls(data.toolCalls)) {
      const id = nonEmpty(call.id);
      if (id != null) {
        this.labelTool(this.ensureTool(state, id, call.name, now), call.args);
      }
    }
    const details = isRecord(data.stepDetails) ? data.stepDetails : undefined;
    if (details?.type !== 'tool_calls') {
      return;
    }
    const ids: string[] = [];
    for (const call of toolCalls(details.tool_calls)) {
      const id = nonEmpty(call.id);
      if (id == null) {
        continue;
      }
      ids.push(id);
      const leaf = this.ensureTool(state, id, call.name ?? call.function?.name, now);
      this.labelTool(leaf, call.args ?? call.function?.arguments);
    }
    const stepId = nonEmpty(data.id);
    if (stepId != null && ids.length > 0) {
      state.callIdsByStepId.set(stepId, ids);
    }
  }

  private labelTool(leaf: ActivityLeaf, args: unknown): void {
    if (leaf.label == null) {
      const intent = readActivityIntent(args);
      if (intent != null) {
        leaf.label = intent;
      }
    }
  }

  private recordCompletion(state: RunState, data: Record<string, unknown>, now: number): void {
    const result = isRecord(data.result) ? data.result : undefined;
    const call = isRecord(result?.tool_call) ? result.tool_call : undefined;
    const id = nonEmpty(call?.id);
    if (call == null || id == null) {
      return;
    }
    const leaf = this.ensureTool(state, id, call.name, now);
    const output = typeof call.output === 'string' ? call.output : undefined;
    leaf.status = output != null && isFailedToolOutput(output) ? 'error' : 'ok';
    leaf.endedAt = now;
    if (output != null) {
      leaf.chars = output.length;
    }
    const outcome = sanitizeActivityText(call.outcome, ACTIVITY_TREE_LIMITS.labelChars);
    if (outcome != null) {
      leaf.label = outcome;
    } else {
      this.labelTool(leaf, call.args);
    }
    if (leaf.run != null) {
      settleLeaves(leaf.run, leaf.status, now);
    }
  }

  private recordClose(state: RunState, data: Record<string, unknown>, now: number): void {
    const stepId = nonEmpty(data.id);
    if (stepId == null) {
      return;
    }
    const status = data.status;
    const text = state.textByStepId.get(stepId);
    if (text?.status === 'running') {
      text.status = status === 'cancelled' ? 'cancelled' : 'ok';
      text.endedAt = now;
    }
    if (status !== 'failed' && status !== 'error' && status !== 'cancelled') {
      return;
    }
    for (const callId of state.callIdsByStepId.get(stepId) ?? []) {
      const leaf = state.toolByCallId.get(callId);
      if (leaf?.status === 'running') {
        leaf.status = status === 'cancelled' ? 'cancelled' : 'error';
        leaf.endedAt = now;
      }
    }
  }

  private recordText(state: RunState, data: Record<string, unknown>, now: number): void {
    const chars = deltaChars(data);
    if (chars === 0) {
      return;
    }
    const stepId = nonEmpty(data.id) ?? '';
    let leaf = state.textByStepId.get(stepId);
    if (leaf == null || leaf.status !== 'running') {
      leaf = { kind: 'text', status: 'running', startedAt: now, chars: 0 };
      this.append(state, leaf, now);
      if (state.depth > 0 && !this.isAttached(state.run)) {
        return;
      }
      state.textByStepId.set(stepId, leaf);
    }
    leaf.chars = (leaf.chars ?? 0) + chars;
  }

  private ensureTool(state: RunState, id: string, name: unknown, now: number): ActivityLeaf {
    const existing = state.toolByCallId.get(id);
    if (existing != null) {
      existing.name ??= sanitizeActivityText(name, ACTIVITY_TREE_LIMITS.nameChars);
      return existing;
    }
    const leaf: ActivityLeaf = {
      kind: 'tool',
      name: sanitizeActivityText(name, ACTIVITY_TREE_LIMITS.nameChars) ?? 'tool',
      status: 'running',
      startedAt: now,
    };
    this.append(state, leaf, now);
    if (state.depth > 0 && !this.isAttached(state.run)) {
      return leaf;
    }
    state.toolByCallId.set(id, leaf);
    this.callOwners.set(id, { leaf, depth: state.depth });
    return leaf;
  }

  private append(state: RunState, leaf: ActivityLeaf, now: number): void {
    const turn = this.turnFor(state, leaf.kind, now);
    while (this.leaves >= ACTIVITY_TREE_LIMITS.leaves && this.tree.root.turns.length > 1) {
      this.evictOldest(this.tree.root);
    }
    if (state.depth > 0 && !this.isAttached(state.run)) {
      return;
    }
    if (
      turn.children.length >= ACTIVITY_TREE_LIMITS.turnChildren ||
      this.leaves >= ACTIVITY_TREE_LIMITS.leaves
    ) {
      turn.overflow = (turn.overflow ?? 0) + 1;
      /** Still tracked so its completion updates it instead of counting twice, and
       * released with its turn so a long child cannot grow the lookup maps. */
      const overflowed = this.overflowLeaves.get(turn) ?? [];
      overflowed.push(leaf);
      this.overflowLeaves.set(turn, overflowed);
      return;
    }
    turn.children.push(leaf);
    this.leaves += 1;
  }

  private turnFor(state: RunState, kind: ActivityLeaf['kind'], now: number): ActivityTurn {
    const current = state.run.turns[state.run.turns.length - 1];
    if (current != null && !this.opensTurn(current, kind)) {
      return current;
    }
    for (const leaf of current?.children ?? []) {
      if (leaf.kind === 'text' && leaf.status === 'running') {
        leaf.status = 'ok';
        leaf.endedAt = now;
      }
    }
    const turn: ActivityTurn = { startedAt: now, children: [] };
    state.run.turns.push(turn);
    while (state.run.turns.length > state.maxTurns) {
      this.evictOldest(state.run);
    }
    return turn;
  }

  private opensTurn(turn: ActivityTurn, kind: ActivityLeaf['kind']): boolean {
    let tools = 0;
    let settledTools = 0;
    let openText = false;
    for (const leaf of turn.children) {
      if (leaf.kind === 'tool') {
        tools += 1;
        settledTools += leaf.status === 'running' ? 0 : 1;
      } else {
        openText ||= leaf.status === 'running';
      }
    }
    if (tools > 0) {
      return settledTools === tools;
    }
    return kind === 'text' && turn.children.length > 0 && !openText;
  }

  private evictOldest(run: ActivityRun): void {
    const turn = run.turns.shift();
    if (turn == null) {
      return;
    }
    run.evicted = foldTurns([turn], run.evicted ?? emptyFold(turn.startedAt));
    const evicted = new Set<ActivityLeaf>();
    collectLeaves([turn], this.overflowLeaves, evicted);
    this.leaves -= countLeaves({ turns: [turn] });
    for (const state of this.runs.values()) {
      for (const [key, leaf] of state.toolByCallId) {
        if (evicted.has(leaf)) state.toolByCallId.delete(key);
      }
      for (const [key, leaf] of state.textByStepId) {
        if (evicted.has(leaf)) state.textByStepId.delete(key);
      }
      for (const [key, callIds] of state.callIdsByStepId) {
        if (!callIds.some((callId) => state.toolByCallId.has(callId))) {
          state.callIdsByStepId.delete(key);
        }
      }
    }
    for (const [key, owner] of this.callOwners) {
      if (evicted.has(owner.leaf)) this.callOwners.delete(key);
    }
    for (const [runId, state] of this.runs) {
      if (state.depth > 0 && !this.isAttached(state.run)) this.runs.delete(runId);
    }
  }

  private isAttached(run: ActivityRun): boolean {
    for (const owner of this.callOwners.values()) {
      if (owner.leaf.run === run) return true;
    }
    return false;
  }

  private finishNested(state: RunState, status: SubagentDigestStatus, now: number): void {
    if (state.depth > 0) {
      settleLeaves(state.run, status, now);
    }
  }
}
