import { GraphEvents } from '@librechat/agents';
import type {
  ToolApprovalDecision,
  ToolApprovalDecisionMap,
  AskUserQuestionResolution,
  AskUserQuestionsResolution,
  EventHandler,
  RunStep,
} from '@librechat/agents';
import type { Agents } from 'librechat-data-provider';
import { ASK_USER_QUESTION_TOOL_NAME } from './askUserQuestionTool';
import { isToolApprovalPayloadValid } from './policy';

/**
 * Translate the host-facing approval wire format into the SDK's resume value.
 *
 * The wire format ({@link Agents.ToolApprovalResolution}) is shaped for the UI —
 * a flat `decision` string plus optional `editedArguments` / `responseText`. The
 * SDK consumes a discriminated {@link ToolApprovalDecision} per tool call. This is
 * the single adapter between the two; the resume route maps once, here, instead of
 * branching on `decision` at the call site.
 *
 * Returns the map form (keyed by `tool_call_id`) so a batch that calls the same
 * tool twice resolves unambiguously — by-position ordering breaks with duplicates.
 */
export function mapToolApprovalResolutions(
  resolutions: readonly Agents.ToolApprovalResolution[],
): ToolApprovalDecisionMap {
  const decisions: ToolApprovalDecisionMap = {};
  for (const resolution of resolutions) {
    decisions[resolution.tool_call_id] = toSdkDecision(resolution);
  }
  return decisions;
}

function toSdkDecision(resolution: Agents.ToolApprovalResolution): ToolApprovalDecision {
  switch (resolution.decision) {
    case 'approve':
      return { type: 'approve' };
    case 'reject':
      return { type: 'reject', reason: resolution.reason };
    case 'edit':
      // `editedArguments` is required for edit on the wire; default to {} so a
      // malformed payload re-runs the tool with empty args rather than throwing.
      return { type: 'edit', updatedInput: resolution.editedArguments ?? {} };
    case 'respond':
      return { type: 'respond', responseText: resolution.responseText ?? '' };
    default:
      // Unknown decision (forward-compat / malformed): fail closed by rejecting,
      // never by silently approving a tool the user didn't sanction.
      return { type: 'reject', reason: 'Unrecognized approval decision' };
  }
}

/** Translate the ask-user wire answer into the SDK's resume value. */
export function mapAskUserAnswer(
  resolution: Agents.AskUserQuestionResolution,
): AskUserQuestionResolution {
  return { answer: resolution.answer };
}

/** Translate batched ask-user wire answers into the SDK's resume value. */
export function mapAskUserAnswers(
  resolution: Agents.AskUserQuestionsResolution,
): AskUserQuestionsResolution {
  return { answers: resolution.answers };
}

const MAX_ASK_ANSWER_LENGTH = 16_000;
const ASK_QUESTION_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_ASK_QUESTIONS = 4;

function getBoundedAskUserAnswerEntries(answers: unknown): Array<[string, string]> | undefined {
  if (answers == null || typeof answers !== 'object' || Array.isArray(answers)) {
    return undefined;
  }
  const entries = Object.entries(answers);
  if (
    entries.length === 0 ||
    entries.length > MAX_ASK_QUESTIONS ||
    entries.some(([, value]) => typeof value !== 'string' || value.length > MAX_ASK_ANSWER_LENGTH)
  ) {
    return undefined;
  }
  return entries as Array<[string, string]>;
}

/** Return batched ask-user values when their count and length are bounded. */
export function getBoundedAskUserAnswerValues(answers: unknown): string[] {
  return getBoundedAskUserAnswerEntries(answers)?.map(([, value]) => value) ?? [];
}

/**
 * Serialize every ordering a validated batch can take after the SDK rebuilds
 * its answer map in question order. Batches are capped at four questions, so
 * this remains bounded at 24 candidates and lets pre-controller PII/moderation
 * checks inspect the exact ToolMessage even for a crafted key order.
 */
export function serializeAskUserAnswerVariants(answers: unknown): string[] {
  const entries = getBoundedAskUserAnswerEntries(answers);
  if (entries == null) {
    return [];
  }

  const variants: string[] = [];
  const visit = (remaining: Array<[string, string]>, ordered: Array<[string, string]>) => {
    if (remaining.length === 0) {
      const normalized = Object.create(null) as Record<string, string>;
      for (const [key, value] of ordered) {
        normalized[key] = value;
      }
      variants.push(JSON.stringify({ answers: normalized }));
      return;
    }
    for (let index = 0; index < remaining.length; index++) {
      visit(
        [...remaining.slice(0, index), ...remaining.slice(index + 1)],
        [...ordered, remaining[index]],
      );
    }
  };
  visit(entries, []);
  return variants;
}

interface AskUserResumeBody {
  answer?: unknown;
  answers?: unknown;
}

/** Ask-user answer retained with the job until the generation terminalizes. */
export interface ResolvedAskUserQuestion {
  /** String supports pending records written before the structured question shape. */
  request: Agents.AskUserQuestionRequest | Agents.AskUserQuestionsRequest | string;
  output: string;
  toolCallId?: string;
  /** Stable association for legacy SDK payloads that omitted tool_call_id. */
  contentIndex?: number;
  /** The paused ask part was absent, so this answer must not bind to a later ask. */
  contentMissing?: true;
}

type AskUserResumeResult =
  | { resumeValue: AskUserQuestionResolution | AskUserQuestionsResolution }
  | { status: 400; error: string };

/** Validate an ask-user resume payload and translate it to the SDK contract. */
export function resolveAskUserQuestionResume(
  payload: Agents.AskUserQuestionInterruptPayload,
  body: AskUserResumeBody,
): AskUserResumeResult {
  if (!Array.isArray(payload.questions)) {
    if (typeof body.answer !== 'string' || body.answer.length === 0) {
      return { status: 400, error: 'An answer is required' };
    }
    if (body.answer.length > MAX_ASK_ANSWER_LENGTH) {
      return { status: 400, error: 'Answer exceeds the maximum length' };
    }
    return { resumeValue: mapAskUserAnswer({ answer: body.answer }) };
  }

  if (payload.questions.length === 0 || payload.questions.length > MAX_ASK_QUESTIONS) {
    return { status: 400, error: 'The pending question batch is invalid' };
  }
  if (body.answers == null || typeof body.answers !== 'object' || Array.isArray(body.answers)) {
    return { status: 400, error: 'Answers are required for every question' };
  }

  const submittedAnswers = body.answers as Record<string, unknown>;
  const answers: Record<string, string> = Object.create(null);
  const expectedIds = new Set<string>();
  for (const question of payload.questions) {
    const { id } = question;
    if (typeof id !== 'string' || !ASK_QUESTION_ID_PATTERN.test(id) || expectedIds.has(id)) {
      return { status: 400, error: 'The pending question batch is invalid' };
    }
    expectedIds.add(id);
    const answer = Object.getOwnPropertyDescriptor(submittedAnswers, id)?.value;
    if (typeof answer !== 'string' || answer.length === 0) {
      return { status: 400, error: 'Answers are required for every question' };
    }
    if (answer.length > MAX_ASK_ANSWER_LENGTH) {
      return { status: 400, error: 'An answer exceeds the maximum length' };
    }
    answers[id] = answer;
  }
  if (Object.keys(submittedAnswers).some((id) => !expectedIds.has(id))) {
    return { status: 400, error: 'Answers contain an unknown question id' };
  }
  return { resumeValue: mapAskUserAnswers({ answers }) };
}

/** Build the durable answer stamp committed with the resume ownership CAS. */
export function buildResolvedAskUserQuestion(
  pendingAction: Agents.PendingAction,
  body: AskUserResumeBody,
  contentIndex?: number,
  contentMissing = false,
): ResolvedAskUserQuestion | undefined {
  const payload = pendingAction.payload;
  if (payload?.type !== 'ask_user_question') {
    return undefined;
  }
  if (Array.isArray(payload.questions)) {
    if (body.answers == null || typeof body.answers !== 'object' || Array.isArray(body.answers)) {
      return undefined;
    }
    return {
      request: { questions: payload.questions },
      output: JSON.stringify({ answers: body.answers }),
      ...(payload.tool_call_id && { toolCallId: payload.tool_call_id }),
      ...(!payload.tool_call_id && contentIndex != null && { contentIndex }),
      ...(!payload.tool_call_id && contentMissing && { contentMissing: true as const }),
    };
  }
  if (typeof body.answer !== 'string') {
    return undefined;
  }
  return {
    request: payload.question,
    output: body.answer,
    ...(payload.tool_call_id && { toolCallId: payload.tool_call_id }),
    ...(!payload.tool_call_id && contentIndex != null && { contentIndex }),
    ...(!payload.tool_call_id && contentMissing && { contentMissing: true as const }),
  };
}

/** Add the current answer without losing exact-ID stamps from earlier pauses. */
export function appendResolvedAskUserQuestion(
  retained: readonly ResolvedAskUserQuestion[] | undefined,
  current: ResolvedAskUserQuestion | undefined,
): ResolvedAskUserQuestion[] | undefined {
  if (current == null) {
    return retained != null && retained.length > 0 ? [...retained] : undefined;
  }
  if (current.toolCallId == null) {
    if (current.contentMissing === true) {
      return [...(retained ?? []), current];
    }
    return [
      ...(retained ?? []).filter(
        (answer) =>
          current.contentIndex == null ||
          answer.toolCallId != null ||
          answer.contentIndex !== current.contentIndex,
      ),
      current,
    ];
  }
  return [
    ...(retained ?? []).filter((answer) => answer.toolCallId !== current.toolCallId),
    current,
  ];
}

/**
 * Validate that a set of resolutions covers exactly the tool calls a pending
 * `tool_approval` action is waiting on. Returns the list of `tool_call_id`s that
 * were requested but not decided (empty when the batch is fully resolved), so the
 * resume route can 400 a partial submission instead of driving a half-decided run.
 */
export function findUndecidedToolCalls(
  payload: Agents.ToolApprovalInterruptPayload,
  resolutions: readonly Agents.ToolApprovalResolution[],
): string[] {
  const decided = new Set(resolutions.map((r) => r.tool_call_id));
  return payload.action_requests.map((a) => a.tool_call_id).filter((id) => !decided.has(id));
}

/** Reject ambiguous or foreign decisions before adapting them to the SDK's ID-keyed map. */
export function hasInvalidToolApprovalResolutions(
  payload: Agents.ToolApprovalInterruptPayload,
  resolutions: readonly Agents.ToolApprovalResolution[],
): boolean {
  const requestedIds = new Set(payload.action_requests.map((request) => request.tool_call_id));
  const resolutionIds = new Set<string>();
  for (const resolution of resolutions) {
    if (resolutionIds.has(resolution.tool_call_id) || !requestedIds.has(resolution.tool_call_id)) {
      return true;
    }
    resolutionIds.add(resolution.tool_call_id);
  }
  return false;
}

/**
 * Enforce the policy's per-tool `allowed_decisions`. Returns the `tool_call_id`s
 * whose submitted decision is NOT one the interrupt's `review_configs` permits for
 * that tool — so the resume route can reject a crafted request that, e.g., approves
 * a tool the policy restricted to `reject`/`respond`. A resolution for a tool with
 * no matching review_config (shouldn't happen) is treated as disallowed (fail closed).
 */
export function findDisallowedDecisions(
  payload: Agents.ToolApprovalInterruptPayload,
  resolutions: readonly Agents.ToolApprovalResolution[],
): string[] {
  const allowedByToolCallId = new Map<string, Set<Agents.ToolApprovalDecisionType>>();
  for (const config of payload.review_configs) {
    allowedByToolCallId.set(config.tool_call_id, new Set(config.allowed_decisions));
  }
  return resolutions
    .filter((r) => !allowedByToolCallId.get(r.tool_call_id)?.has(r.decision))
    .map((r) => r.tool_call_id);
}

/**
 * Enforce that `edit` and `respond` decisions carry their required payload. Returns
 * the `tool_call_id`s whose decision is structurally incomplete:
 *   - `edit` without an object `editedArguments`, or
 *   - `respond` without a non-empty `responseText`.
 *
 * Without this, {@link toSdkDecision}'s defensive defaults (`{}` / `''`) would turn a
 * crafted or buggy submission into an empty tool input or an empty synthetic result —
 * resuming the run with behavior the user never actually approved. The route rejects
 * these (400) rather than mapping them.
 */
export function findIncompleteDecisions(
  resolutions: readonly Agents.ToolApprovalResolution[],
): string[] {
  return resolutions
    .filter((r) => {
      if (r.decision === 'edit') {
        return (
          r.editedArguments == null ||
          typeof r.editedArguments !== 'object' ||
          Array.isArray(r.editedArguments)
        );
      }
      if (r.decision === 'respond') {
        return typeof r.responseText !== 'string' || r.responseText.length === 0;
      }
      return false;
    })
    .map((r) => r.tool_call_id);
}

/** Validate and translate one complete tool-approval batch for the resume controller. */
export function resolveToolApprovalResume(
  payload: Agents.ToolApprovalInterruptPayload,
  resolutions: readonly Agents.ToolApprovalResolution[],
):
  | { resumeValue: ToolApprovalDecisionMap }
  | { status: 400; error: string; undecided?: string[]; incomplete?: string[] }
  | { status: 403; error: string; disallowed: string[] } {
  if (!isToolApprovalPayloadValid(payload)) {
    return { status: 400, error: 'Invalid tool approval payload' };
  }
  if (hasInvalidToolApprovalResolutions(payload, resolutions)) {
    return { status: 400, error: 'Invalid tool approval decisions' };
  }
  const undecided = findUndecidedToolCalls(payload, resolutions);
  if (undecided.length > 0) {
    return { status: 400, error: 'Every paused tool call must be decided', undecided };
  }
  const disallowed = findDisallowedDecisions(payload, resolutions);
  if (disallowed.length > 0) {
    return { status: 403, error: 'Decision not permitted for one or more tools', disallowed };
  }
  const incomplete = findIncompleteDecisions(resolutions);
  if (incomplete.length > 0) {
    return {
      status: 400,
      error: 'edit requires editedArguments and respond requires responseText',
      incomplete,
    };
  }
  return { resumeValue: mapToolApprovalResolutions(resolutions) };
}

/**
 * Reconcile persisted tool-step indices with the content being seeded into a
 * rebuilt aggregator.
 *
 * A pause-time index is not durable identity: hosts can prepend content after
 * the step was emitted, and persisted reconstruction can compact sparse
 * content. Tool-call ids are stable across both operations, so use them to
 * relocate a step without mutating the stored object.
 */
type ResumableRunStep = {
  id: string;
  index: number;
  stepDetails: {
    type: string;
    tool_calls?: readonly { id?: string }[];
  };
};

export function normalizeResumeRunStepIndices<T extends ResumableRunStep>(
  runSteps: readonly T[],
  seedContent: readonly ({ type?: string; tool_call?: { id?: string } } | undefined)[] = [],
): T[] {
  const toolCallIndices = new Map<string, number>();
  seedContent.forEach((part, index) => {
    const toolCallId = part?.tool_call?.id;
    if (part?.type === 'tool_call' && typeof toolCallId === 'string') {
      toolCallIndices.set(toolCallId, index);
    }
  });

  return runSteps.map((runStep) => {
    if (runStep.stepDetails.type !== 'tool_calls') {
      return runStep;
    }
    const contentIndex = runStep.stepDetails.tool_calls
      ?.map((toolCall) => (toolCall.id ? toolCallIndices.get(toolCall.id) : undefined))
      .find((index) => index != null);
    return contentIndex != null && contentIndex !== runStep.index
      ? { ...runStep, index: contentIndex }
      : runStep;
  });
}

/**
 * Restore the streamed run-step sidecars that a fresh SDK Run cannot recover
 * from the LangGraph checkpoint by itself.
 *
 * Human-review resume can happen in a later request or process. The checkpoint
 * restarts directly inside ToolNode, so it does not replay ON_RUN_STEP before
 * dispatching ON_RUN_STEP_COMPLETED. Seeding both maps lets the ToolNode emit
 * the original step id and lets the content aggregator resolve that id back to
 * the already-rendered tool card.
 */
export function hydrateResumeRunSteps(
  runSteps: readonly RunStep[],
  stepMap: Map<string, RunStep | undefined> | undefined,
  graph: { toolCallStepIds?: Map<string, string> } | null | undefined,
  seedContent: readonly ({ type?: string; tool_call?: { id?: string } } | undefined)[] = [],
): void {
  for (const runStep of normalizeResumeRunStepIndices(runSteps, seedContent)) {
    if (!runStep?.id) {
      continue;
    }
    stepMap?.set(runStep.id, runStep);
    const stepDetails: ResumableRunStep['stepDetails'] = runStep.stepDetails;
    if (stepDetails.type !== 'tool_calls') {
      continue;
    }
    for (const toolCall of stepDetails.tool_calls ?? []) {
      if (toolCall.id) {
        graph?.toolCallStepIds?.set(toolCall.id, runStep.id);
      }
    }
  }
}

/**
 * Wrap a resume run's event handlers so every content index the rebuilt graph
 * emits is shifted past the pre-pause content.
 *
 * WHY: a resumed run rebuilds the graph from the checkpoint, and the fresh
 * graph assigns content indices from its own empty `contentData` — starting at
 * 0. The host, meanwhile, seeds the (also fresh) content aggregator with the
 * pre-pause parts, which occupy exactly those low indices. Without an offset
 * the resumed model turn collides with the seed: when the types match at an
 * index the new text silently MERGES into a pre-pause part, and when they
 * don't (e.g. a reasoning/`think` part at index 0 with Anthropic models) every
 * delta is dropped with `Content type mismatch` — the entire post-resume
 * output vanishes from both the live stream and the saved message.
 *
 * The index enters the pipeline at exactly one point: `ON_RUN_STEP`'s payload
 * (the `RunStep`, whose `index` every subsequent delta resolves through the
 * aggregator's `stepMap`). `ON_AGENT_UPDATE` carries its own inline index and
 * is offset likewise. All other handlers pass through untouched — same object
 * references, so stateful handler instances keep working.
 */
export function createContentIndexOffsetHandlers(
  handlers: Record<string, EventHandler> | undefined,
  seedContent: Array<{ type?: string; tool_call?: { id?: string; output?: unknown } }> = [],
): Record<string, EventHandler> | undefined {
  const offset = seedContent.length;
  if (handlers == null || !(offset > 0)) {
    return handlers;
  }

  /**
   * Resumed tool steps for calls the PAUSED turn already rendered must land
   * back on their seeded slot — not a fresh offset slot — or the original
   * part stays unresolved while a duplicate completed one appears after the
   * seed (and its output never attaches). Map unresolved seeded tool_calls by
   * id so the resume pass's re-execution (approval flows re-run the approved
   * tool; ask re-runs its body) rebinds to the right index.
   */
  const seededToolCallIndex = new Map<string, number>();
  seedContent.forEach((part, index) => {
    const toolCall = part?.tool_call;
    /**
     * EVERY seeded id maps — including parts already carrying an output. Tool
     * call ids are minted per call by the provider, so a resumed step bearing
     * a seeded id can only be the interrupted batch re-executing (the resume
     * controller pre-stamps the ask part's answer onto the seed, which must
     * not exile its re-run step to a duplicate offset slot).
     */
    if (part?.type === 'tool_call' && typeof toolCall?.id === 'string') {
      seededToolCallIndex.set(toolCall.id, index);
    }
  });

  const wrapped: Record<string, EventHandler> = { ...handlers };

  const runStepHandler = handlers[GraphEvents.ON_RUN_STEP];
  if (runStepHandler) {
    wrapped[GraphEvents.ON_RUN_STEP] = {
      handle: (event, data, metadata, graph) => {
        const runStep = data as
          | {
              index?: number;
              stepDetails?: { type?: string; tool_calls?: Array<{ id?: string }> };
            }
          | undefined;
        if (runStep == null || typeof runStep.index !== 'number') {
          return runStepHandler.handle(event, data, metadata, graph);
        }
        const seededIndex =
          runStep.stepDetails?.type === 'tool_calls'
            ? runStep.stepDetails.tool_calls
                ?.map((call) => (call.id ? seededToolCallIndex.get(call.id) : undefined))
                .find((index) => index != null)
            : undefined;
        const shifted = {
          ...runStep,
          index: seededIndex ?? runStep.index + offset,
        };
        return runStepHandler.handle(event, shifted as typeof data, metadata, graph);
      },
    };
  }

  const agentUpdateHandler = handlers[GraphEvents.ON_AGENT_UPDATE];
  if (agentUpdateHandler) {
    wrapped[GraphEvents.ON_AGENT_UPDATE] = {
      handle: (event, data, metadata, graph) => {
        const update = data as { agent_update?: { index?: number } } | undefined;
        const shifted =
          update?.agent_update != null && typeof update.agent_update.index === 'number'
            ? {
                ...update,
                agent_update: { ...update.agent_update, index: update.agent_update.index + offset },
              }
            : data;
        return agentUpdateHandler.handle(event, shifted as typeof data, metadata, graph);
      },
    };
  }

  return wrapped;
}

/**
 * Locate the ask part a stamp should target. With a `toolCallId` (the SDK
 * surfaces the interrupting call's id on the payload from `@librechat/agents`
 * > 3.3.8) the match is exact — several ask parts in one turn each get their
 * own question/answer. Without one, fall back to the newest ask part that
 * passes `isStampable` (a re-pause targets the newest question; earlier ones
 * already carry their answers).
 */
function findAskPartIndex<
  TPart extends { type?: string; tool_call?: { id?: unknown; name?: unknown } },
>(content: TPart[], toolCallId: string | undefined, isStampable: (part: TPart) => boolean): number {
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i];
    const toolCall = part?.tool_call;
    if (part?.type !== 'tool_call' || toolCall?.name !== ASK_USER_QUESTION_TOOL_NAME) {
      continue;
    }
    if (toolCallId != null && toolCallId.length > 0) {
      if (toolCall.id === toolCallId) {
        return i;
      }
      continue;
    }
    if (isStampable(part)) {
      return i;
    }
  }
  return -1;
}

/** Locate the exact content slot used by pause-time question stamping. */
export function findAskUserQuestionContentIndex<
  TPart extends {
    type?: string;
    tool_call?: { id?: string; name?: string; args?: unknown; output?: unknown };
  },
>(
  content: TPart[],
  toolCallId?: string,
  request?: Agents.AskUserQuestionRequest | Agents.AskUserQuestionsRequest | string,
): number {
  return findAskPartIndex(content, toolCallId, (part) => {
    const toolCall = part.tool_call;
    const hasArgs =
      (typeof toolCall?.args === 'string' && toolCall.args.trim().length > 0) ||
      (toolCall?.args != null &&
        typeof toolCall.args === 'object' &&
        Object.keys(toolCall.args as object).length > 0);
    if (typeof toolCall?.output === 'string' && toolCall.output.length > 0) {
      return false;
    }
    if (!hasArgs) {
      return true;
    }
    if (request == null || typeof toolCall?.args !== 'string') {
      return false;
    }
    try {
      return JSON.stringify(JSON.parse(toolCall.args)) === JSON.stringify(request);
    } catch {
      return false;
    }
  });
}

/**
 * Stamp the answered question onto the paused `ask_user_question` tool-call part
 * before the resume run seeds it back into the content pipeline.
 *
 * WHY the part is otherwise empty: the streamed arg CHUNKS carry no tool name, and
 * the aggregator only accepts name-less arg updates on the completion event — which
 * never fires for this tool (the first pass interrupts mid-execution, and the
 * rebuilt resume run has no step id to complete against). Saved messages therefore
 * showed `args: ""` and no `output`, and the client rendered a "cancelled" tool.
 * The authoritative data exists anyway: the pendingAction payload carries the full
 * question, and the resume request carries the user's answer.
 *
 * Targets the payload's `tool_call_id` part when present (exact attribution for
 * multi-ask turns), else the LAST unanswered ask part. Pure — returns the input
 * array when nothing matched.
 */
export function attachAskUserQuestionAnswer<
  TPart extends { type?: string; tool_call?: { id?: unknown; name?: unknown; output?: unknown } },
>(
  content: TPart[],
  request: Agents.AskUserQuestionRequest | Agents.AskUserQuestionsRequest,
  output: string,
  toolCallId?: string,
): TPart[] {
  if (toolCallId == null) {
    for (let index = content.length - 1; index >= 0; index--) {
      const part = content[index];
      const toolCall = part?.tool_call;
      if (
        part?.type !== 'tool_call' ||
        toolCall?.name !== ASK_USER_QUESTION_TOOL_NAME ||
        (typeof toolCall.output === 'string' && toolCall.output.length > 0)
      ) {
        continue;
      }
      const next = [...content];
      next[index] = {
        ...part,
        tool_call: {
          ...toolCall,
          args: JSON.stringify(request),
          output,
          progress: 1,
        },
      };
      return next;
    }
    return content;
  }
  return attachAskUserQuestionAnswers(content, [{ request, output, toolCallId }]);
}

/** Apply retained ask answers in one content pass for Redis reconstruction. */
export function attachAskUserQuestionAnswers<
  TPart extends { type?: string; tool_call?: { id?: unknown; name?: unknown; output?: unknown } },
>(content: TPart[], answers: readonly ResolvedAskUserQuestion[]): TPart[] {
  if (answers.length === 0) {
    return content;
  }
  const exactAnswers = new Map<string, ResolvedAskUserQuestion>();
  const indexedAnswers = new Map<number, ResolvedAskUserQuestion>();
  const legacyAnswers: ResolvedAskUserQuestion[] = [];
  for (const answer of answers) {
    if (answer.contentMissing === true) {
      continue;
    } else if (answer.toolCallId != null && answer.toolCallId.length > 0) {
      exactAnswers.set(answer.toolCallId, answer);
    } else if (
      answer.contentIndex != null &&
      Number.isSafeInteger(answer.contentIndex) &&
      answer.contentIndex >= 0
    ) {
      indexedAnswers.set(answer.contentIndex, answer);
    } else {
      legacyAnswers.push(answer);
    }
  }

  /** Legacy stamps have no tool-call id, but their array order is the durable
   * association: answers are appended as asks resolve, and tool-call parts are
   * reconstructed in that same chronological order. Walk forward so an
   * earlier accepted answer cannot slide onto a later unanswered ask. */
  let legacyIndex = 0;
  let next: TPart[] | undefined;
  for (let index = 0; index < content.length; index++) {
    const part = content[index];
    const toolCall = part?.tool_call;
    if (part?.type !== 'tool_call' || toolCall?.name !== ASK_USER_QUESTION_TOOL_NAME) {
      continue;
    }
    const toolCallId = typeof toolCall.id === 'string' ? toolCall.id : undefined;
    const exactAnswer = toolCallId != null ? exactAnswers.get(toolCallId) : undefined;
    const indexedAnswer = indexedAnswers.get(index);
    const legacyCandidate = legacyAnswers[legacyIndex];
    if (
      exactAnswer == null &&
      indexedAnswer == null &&
      legacyCandidate != null &&
      typeof toolCall.output === 'string' &&
      toolCall.output.length > 0
    ) {
      try {
        if (
          toolCall.output === legacyCandidate.output &&
          JSON.stringify(JSON.parse((toolCall as { args?: string }).args ?? '')) ===
            JSON.stringify(legacyCandidate.request)
        ) {
          legacyIndex++;
        } else {
          legacyIndex = legacyAnswers.length;
        }
      } catch {
        // Ambiguous legacy metadata must never slide onto a later ask.
        legacyIndex = legacyAnswers.length;
      }
      continue;
    }
    const legacyAnswer =
      exactAnswer == null &&
      legacyIndex < legacyAnswers.length &&
      !(typeof toolCall.output === 'string' && toolCall.output.length > 0)
        ? legacyAnswers[legacyIndex++]
        : undefined;
    const answer = exactAnswer ?? indexedAnswer ?? legacyAnswer;
    if (answer == null) {
      continue;
    }
    if (exactAnswer != null && toolCallId != null) {
      exactAnswers.delete(toolCallId);
    }
    if (indexedAnswer != null) {
      indexedAnswers.delete(index);
    }
    next ??= [...content];
    next[index] = {
      ...part,
      tool_call: {
        ...toolCall,
        args: JSON.stringify(answer.request),
        output: answer.output,
        progress: 1,
      },
    };
  }
  return next ?? content;
}

/**
 * Stamp the question onto the paused `ask_user_question` tool-call part's args
 * at PAUSE time (no answer yet). Companion to
 * {@link attachAskUserQuestionAnswer}: an abandoned/expired/stopped pause never
 * reaches the answer-resume stamp, and the streamed args were dropped by the
 * aggregator (name-less chunks), so without this the persisted unfinished turn
 * carries an empty ask part the record card can't render a question from.
 * Targets the payload's `tool_call_id` part when present, else the newest ask
 * part with empty args and no output. Pure.
 */
export function attachAskUserQuestionArgs<
  TPart extends {
    type?: string;
    tool_call?: { id?: string; name?: string; args?: unknown; output?: unknown };
  },
>(
  content: TPart[],
  request: Agents.AskUserQuestionRequest | Agents.AskUserQuestionsRequest,
  toolCallId?: string,
): TPart[] {
  const index = findAskUserQuestionContentIndex(content, toolCallId, request);
  if (index < 0) {
    return content;
  }
  const part = content[index];
  const next = [...content];
  next[index] = { ...part, tool_call: { ...part.tool_call, args: JSON.stringify(request) } };
  return next;
}
