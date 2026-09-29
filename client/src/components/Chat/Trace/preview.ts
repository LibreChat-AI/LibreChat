import { ContentTypes } from 'librechat-data-provider';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import type { TraceModel } from './model';
import { getActivityLabelPart, getActivityLabelText, isPhaseActivityLabel } from '~/utils';
import { isModelCall, isToolWork } from './model';
import { hasParallelLanes } from '~/utils/lanes';

const PREVIEW_LENGTH = 160;
const ELLIPSIS = '…';

/** `args` is the one-line preview; `input` and `output` are what the chat's own tool card holds. */
export type ToolCallPreview = { name: string; args: string; input?: string; output?: string };

/** What one model call of a response produced: the text it wrote and the tools it called. */
export type StepPreview = { text: string; toolCalls: ToolCallPreview[] };

/**
 * A response's previews by model call. `finalOnly` marks a message that kept
 * only its final text (stored as flat text, or with intermediate output
 * filtered out), which belongs to the last model call, not the first.
 */
export type MessagePreview = {
  steps: StepPreview[];
  finalOnly: boolean;
  /** Agents ran in parallel lanes, whose output cannot be told apart by order. */
  parallel: boolean;
  /** The activity labels the chat showed, in the order they were written, by the kind of label. */
  labels: Record<LabelRole, string[]>;
};

type LabelRole = 'stepLabel' | 'phaseLabel';

function compact(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > PREVIEW_LENGTH
    ? `${collapsed.slice(0, PREVIEW_LENGTH).trimEnd()}${ELLIPSIS}`
    : collapsed;
}

function textOf(value: string | { value?: string } | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  return value?.value ?? '';
}

function argsPreview(args: string | object | undefined): string {
  if (args == null) {
    return '';
  }
  let parsed: unknown = args;
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args);
    } catch {
      return compact(args);
    }
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return compact(typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
  }
  const pairs = Object.entries(parsed).map(
    ([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  );
  return compact(pairs.join(', '));
}

function contentOf(value: string | object | null | undefined): string | undefined {
  if (value == null || value === '') {
    return undefined;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

type ToolCallPart = Extract<TMessageContentParts, { type: ContentTypes.TOOL_CALL }>['tool_call'];

/** A tool call's name and arguments, whichever of the persisted call shapes carries them. */
function callOf(call: ToolCallPart | undefined): ToolCallPreview | null {
  if (call == null) {
    return null;
  }
  if ('function' in call && call.function != null) {
    const { name, arguments: input, output } = call.function;
    return { name, args: argsPreview(input), input: contentOf(input), output: contentOf(output) };
  }
  if ('name' in call && typeof call.name === 'string') {
    return {
      name: call.name,
      args: argsPreview(call.args),
      input: contentOf(call.args),
      output: 'output' in call ? contentOf(call.output) : undefined,
    };
  }
  return null;
}

/** The run step a persisted tool call belongs to; parallel calls of one round share it. */
function runStepOf(call: ToolCallPart | undefined): string | undefined {
  return call != null && 'stepId' in call && typeof call.stepId === 'string'
    ? call.stepId
    : undefined;
}

/**
 * Splits a response's content into what each model call produced. A model call
 * may reason, write text and request tools, in that order, so a new call begins
 * where a tool call is followed by reasoning or text, or by a tool call from
 * another run step (consecutive tool-only calls). Parallel calls share a step.
 */
export function buildMessagePreview(message: TMessage | undefined): MessagePreview {
  const parts: TMessageContentParts[] = message?.content ?? [];
  const steps: StepPreview[] = [];
  let current: StepPreview | null = null;
  let afterToolCall = false;
  let lastRunStep: string | undefined;
  let roundAgent: string | undefined;
  const parallel = hasParallelLanes(parts);
  const labels: MessagePreview['labels'] = { stepLabel: [], phaseLabel: [] };
  let sealed = false;
  const begin = () => {
    current = { text: '', toolCalls: [] };
    steps.push(current);
    afterToolCall = false;
    sealed = false;
    return current;
  };
  /** A handoff: output from another agent is that agent's own model call. */
  const handoff = (part: TMessageContentParts): boolean => {
    const agentId = part.agentId;
    const changed = agentId != null && roundAgent != null && agentId !== roundAgent;
    roundAgent = agentId ?? roundAgent;
    return changed && current != null;
  };
  for (const part of parts) {
    /** A streaming message writes parts at provider indexes, so the array can hold holes. */
    if (part == null) {
      continue;
    }
    if (part.type === ContentTypes.ACTIVITY_LABEL) {
      const label = getActivityLabelPart(part);
      const text = getActivityLabelText(label);
      if (text) {
        labels[isPhaseActivityLabel(label) ? 'phaseLabel' : 'stepLabel'].push(text);
      }
      continue;
    }
    if (part.type === ContentTypes.TOOL_CALL) {
      const runStep = runStepOf(part.tool_call);
      const handedOff = handoff(part);
      const nextRound =
        handedOff ||
        (afterToolCall && runStep != null && lastRunStep != null && runStep !== lastRunStep);
      const step = current == null || sealed || nextRound ? begin() : current;
      const call = callOf(part.tool_call);
      if (call != null) {
        step.toolCalls.push(call);
      }
      afterToolCall = true;
      lastRunStep = runStep ?? lastRunStep;
      continue;
    }
    if (part.type === ContentTypes.THINK) {
      const handedOff = handoff(part);
      if (current == null || sealed || afterToolCall || handedOff) {
        begin();
      }
      continue;
    }
    /** Compaction is a model call of its own; its round previews nothing, but it holds its place. */
    if (part.type === ContentTypes.SUMMARY) {
      begin();
      sealed = true;
      continue;
    }
    if (part.type === ContentTypes.STEER) {
      sealed = true;
      continue;
    }
    if (part.type !== ContentTypes.TEXT) {
      continue;
    }
    const handedOff = handoff(part);
    const step = current == null || sealed || afterToolCall || handedOff ? begin() : current;
    step.text = compact(`${step.text} ${textOf(part.text)}`);
  }
  /** A run that failed or never finished kept its early text, not a final answer. */
  const endedEarly =
    message?.error === true ||
    message?.unfinished === true ||
    parts.some((part) => part?.type === ContentTypes.ERROR);
  /** A failed turn's row stores the failure as its text; the model never wrote it. */
  if (steps.length === 0 && message?.text && !endedEarly) {
    return {
      steps: [{ text: compact(message.text), toolCalls: [] }],
      finalOnly: true,
      parallel,
      labels,
    };
  }
  const finalOnly =
    !endedEarly &&
    !sealed &&
    steps.length === 1 &&
    steps[0].toolCalls.length === 0 &&
    steps[0].text !== '';
  return { steps, finalOnly, parallel, labels };
}

export function buildStepPreviews(message: TMessage | undefined): StepPreview[] {
  return buildMessagePreview(message).steps;
}

/**
 * The one-line preview each ledger row shows beside its record's name, taken
 * from the chat's own message rather than from the tracing backend: the text a
 * model call wrote, or the arguments a tool was called with. Built once per
 * model in one pass over every step, so search and rendering never rescan a
 * step per row. Only a step's own roots have a preview: the message describes
 * the response's calls, not what ran inside a tool (a subagent's model calls, a
 * tool's nested calls). Tool records are matched to the message's tool calls by
 * name, in the order they ran within their step; same-name calls that started in
 * the same millisecond have no reliable order and get none. The turn a page
 * boundary splits (`partialMessageId`) is matched from its end (`alignTurns`).
 */
/** How a response's steps line up with its message's rounds: `offset` rounds ran before its first loaded step. */
export type TurnAlignment = { message: MessagePreview; offset: number; split: boolean };

/**
 * Lines each response's steps up with its message's rounds, or leaves the response out when the
 * two cannot be trusted to match. There is no call id shared by a trace and a message, so the
 * match is by order, and an order is only evidence when something else agrees with it:
 *
 * - A whole response must match round for round. Filtering, incomplete traces and silent calls
 *   can remove rounds on either side, and an unequal count cannot be aligned by ordinal.
 * - The response a record limit split is matched from its end. Records load newest first, so what
 *   is loaded is the end of the response and its steps are the message's last rounds. That holds
 *   only for a response the limit really cut (`turn.split`): the oldest loaded response is often
 *   whole, with the next page holding an older response, and a whole response that disagrees with
 *   its message is simply unmatched.
 * - Wherever the trace names the tools of a round, the message's round must name the same tools.
 *   One disagreement means the order is off somewhere, so the whole response goes unmatched rather
 *   than showing one round's arguments and output under another's name.
 */
export function alignTurns(
  model: TraceModel,
  previewsByMessage: ReadonlyMap<string, MessagePreview>,
  partialMessageId?: string,
): Map<string, TurnAlignment> {
  const alignments = new Map<string, TurnAlignment>();
  for (const turn of model.turns) {
    const message = previewsByMessage.get(turn.messageId);
    if (message == null || message.parallel || message.finalOnly) {
      continue;
    }
    const split = turn.split && turn.messageId === partialMessageId;
    const missing = message.steps.length - turn.steps;
    if (split ? missing < 0 : missing !== 0) {
      continue;
    }
    alignments.set(turn.messageId, { message, offset: missing, split });
  }
  for (const step of model.steps.values()) {
    const alignment = step.origin === 'run' ? alignments.get(step.messageId) : undefined;
    if (alignment == null) {
      continue;
    }
    const round = alignment.message.steps[alignment.offset + step.index - 1];
    if (!namesAgree(model, step.rootIds, round?.toolCalls ?? [])) {
      alignments.delete(step.messageId);
    }
  }
  return alignments;
}

/**
 * Whether every round the trace names in a step names exactly the message round's calls. A round
 * an approval paused is recorded again when it resumes, so a step may hold several records, and
 * each holds the same calls; two same-name calls in one record are two calls, never a repeat.
 */
function namesAgree(
  model: TraceModel,
  rootIds: readonly string[],
  calls: readonly ToolCallPreview[],
): boolean {
  for (const id of rootIds) {
    const tools = model.nodes.get(id)?.record.tools;
    if (tools == null) {
      continue;
    }
    if (tools.length !== calls.length || tools.some((name, at) => name !== calls[at].name)) {
      return false;
    }
  }
  return true;
}

export function buildPreviewIndex(
  model: TraceModel,
  previewsByMessage: ReadonlyMap<string, MessagePreview>,
  partialMessageId?: string,
  alignments: ReadonlyMap<string, TurnAlignment> = alignTurns(
    model,
    previewsByMessage,
    partialMessageId,
  ),
): Map<string, string> {
  const index = new Map<string, string>();
  const stepsByTurn = new Map(model.turns.map((turn) => [turn.messageId, turn.steps]));
  for (const step of model.steps.values()) {
    const message = previewsByMessage.get(step.messageId);
    if (message == null || message.parallel || step.origin === 'title') {
      continue;
    }
    if (message.finalOnly) {
      const text = message.steps[0]?.text;
      if (step.index === stepsByTurn.get(step.messageId) && step.generationId != null && text) {
        index.set(step.generationId, text);
      }
      continue;
    }
    const alignment = alignments.get(step.messageId);
    const round = alignment?.message.steps[alignment.offset + step.index - 1];
    if (alignment == null || !round) {
      continue;
    }
    /** The cut is by record, not by round, so the first loaded step of a split response may hold
     *  only the last of its round's tools, and counting those from the round's first call would
     *  show one call's arguments under another. */
    const boundary = alignment.split && step.index === 1;
    const callsByName = new Map<string, string[]>();
    for (const call of round.toolCalls) {
      const bucket = callsByName.get(call.name);
      if (bucket == null) {
        callsByName.set(call.name, [call.args]);
      } else {
        bucket.push(call.args);
      }
    }
    const startsByName = new Map<string, Map<number, number>>();
    const roots = step.rootIds.flatMap((id) => {
      const node = model.nodes.get(id);
      return node != null ? [node] : [];
    });
    for (const node of roots) {
      if (node.record.kind !== 'tool') {
        continue;
      }
      const starts = startsByName.get(node.record.name) ?? new Map<number, number>();
      starts.set(node.start, (starts.get(node.start) ?? 0) + 1);
      startsByName.set(node.record.name, starts);
    }
    const ordinals = new Map<string, number>();
    for (const node of roots) {
      const { record } = node;
      if (isModelCall(record)) {
        if (round.text) {
          index.set(record.id, round.text);
        }
        continue;
      }
      if (record.kind !== 'tool' || boundary) {
        continue;
      }
      const ordinal = ordinals.get(record.name) ?? 0;
      ordinals.set(record.name, ordinal + 1);
      const ambiguous = (startsByName.get(record.name)?.get(node.start) ?? 0) > 1;
      const args = callsByName.get(record.name)?.[ordinal];
      if (!ambiguous && args) {
        index.set(record.id, args);
      }
    }
  }
  return index;
}

/** Previews for every response in a conversation, keyed by its message id. */
export function buildPreviews(
  messages: readonly TMessage[] | undefined,
): Map<string, MessagePreview> {
  const previews = new Map<string, MessagePreview>();
  for (const message of messages ?? []) {
    if (message.isCreatedByUser) {
      continue;
    }
    previews.set(message.messageId, buildMessagePreview(message));
  }
  return previews;
}

/** What the chat's messages say about records the trace only names: tool rounds and activity labels. */
export type ActivityIndex = {
  /** The calls of a tool round the host ran without recording each one, by the round's record id. */
  calls: Map<string, ToolCallPreview[]>;
  /** The text a label's model call wrote, by its record id. */
  labels: Map<string, string>;
  /** Tool calls the trace holds no record of, by response: what a turn's own count misses. */
  unrecordedCalls: Map<string, number>;
  /** Steps of a response that ran before its first loaded one, so its steps keep their real numbers. */
  stepOffsets: Map<string, number>;
};

const hasToolRecord = (model: TraceModel) => (id: string) => {
  const record = model.nodes.get(id)?.record;
  return record != null && isToolWork(record);
};

/**
 * Attributes the message's tool calls and activity labels to trace records. A
 * round's calls go to its one tool-round record that holds no recorded tools (a
 * round re-entered after an approval pause has several, and only the last one
 * ran them). Labels pair with their model calls in the order both were written,
 * and only when the counts agree, under the rule the previews follow.
 */
export function buildActivityIndex(
  model: TraceModel,
  previewsByMessage: ReadonlyMap<string, MessagePreview>,
  partialMessageId?: string,
  alignments: ReadonlyMap<string, TurnAlignment> = alignTurns(
    model,
    previewsByMessage,
    partialMessageId,
  ),
): ActivityIndex {
  const calls: ActivityIndex['calls'] = new Map();
  const labels: ActivityIndex['labels'] = new Map();
  const unrecordedCalls: ActivityIndex['unrecordedCalls'] = new Map();
  const stepOffsets: ActivityIndex['stepOffsets'] = new Map();

  for (const step of model.steps.values()) {
    const alignment = step.origin === 'run' ? alignments.get(step.messageId) : undefined;
    if (alignment == null) {
      continue;
    }
    if (alignment.offset > 0) {
      stepOffsets.set(step.messageId, alignment.offset);
    }
    const round = alignment.message.steps[alignment.offset + step.index - 1];
    /** A round that holds recorded tools is described by them, not by the message. */
    const ran = step.roundId != null ? model.nodes.get(step.roundId) : undefined;
    const target = ran != null && !ran.childIds.some(hasToolRecord(model)) ? step.roundId : null;
    if (target == null || round == null || round.toolCalls.length === 0) {
      continue;
    }
    calls.set(target, round.toolCalls);
    /** A round the trace names is already counted from its names. */
    if (model.nodes.get(target)?.record.tools == null) {
      unrecordedCalls.set(
        step.messageId,
        (unrecordedCalls.get(step.messageId) ?? 0) + round.toolCalls.length,
      );
    }
  }

  const labelRecords = new Map<string, Record<LabelRole, Array<{ id: string; start: number }>>>();
  for (const node of model.nodes.values()) {
    const { role, messageId, id } = node.record;
    if (role !== 'stepLabel' && role !== 'phaseLabel') {
      continue;
    }
    const byRole = labelRecords.get(messageId) ?? { stepLabel: [], phaseLabel: [] };
    byRole[role].push({ id, start: node.start });
    labelRecords.set(messageId, byRole);
  }
  for (const [messageId, byRole] of labelRecords) {
    const message = previewsByMessage.get(messageId);
    if (message == null || message.parallel) {
      continue;
    }
    /** One notion of a cut response, the alignment's: its matched rounds are what vouch for reading
     *  the labels from the end. A response that merely lost a record is whole, and pairs only when
     *  the counts agree. */
    const split = alignments.get(messageId)?.split === true;
    for (const role of ['stepLabel', 'phaseLabel'] as const) {
      const records = byRole[role];
      const texts = message.labels[role];
      const missing = texts.length - records.length;
      if (split ? missing < 0 : missing !== 0) {
        continue;
      }
      records.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
      records.forEach((record, index) => labels.set(record.id, texts[missing + index]));
    }
  }
  return { calls, labels, unrecordedCalls, stepOffsets };
}
