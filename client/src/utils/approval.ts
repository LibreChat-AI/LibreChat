import { ContentTypes } from 'librechat-data-provider';
import type { Agents, TMessage, TMessageContentParts } from 'librechat-data-provider';

/**
 * UI-only content-part type used to render an `ask_user_question` pause inline
 * with the assistant's other content parts. It rides on the standard `content`
 * array (which `Agents.MessageContentComplex` allows for arbitrary `type`
 * strings), so it survives SSE, sync, and DB rehydration without a new wire
 * type or an extra field on `TMessage`.
 */
export const ASK_USER_QUESTION = 'ask_user_question' as const;

/**
 * Answer sent when the user explicitly skips a question: the run must resume
 * (a client-side dismiss would leave it paused until expiry — a hung turn),
 * and the model needs to know the user declined rather than answered.
 */
export const ASK_USER_DECLINED_ANSWER = 'The user chose not to answer this question.';
const ASK_USER_QUESTION_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_ASK_USER_QUESTIONS = 4;
const MAX_ASK_USER_QUESTION_HEADER_LENGTH = 80;

/** Shape of the synthetic content part carrying an ask-user pending action. */
export interface AskUserQuestionPart {
  type: typeof ASK_USER_QUESTION;
  [ASK_USER_QUESTION]: {
    actionId: string;
    question: Agents.AskUserQuestionRequest;
    questions?: Agents.AskUserQuestionBatchItem[];
    /** The ask tool call that raised the pause (present from
     *  `@librechat/agents` > 3.3.8) — lets the answer stamp target the exact
     *  tool-call part in multi-ask turns. */
    tool_call_id?: string;
  };
}

/**
 * The synthetic type isn't in the `ContentTypes` union, so this reads the
 * `type` field through a cast rather than a type-predicate (which TS rejects
 * because `AskUserQuestionPart` isn't assignable to the strict
 * `TMessageContentParts` union).
 */
export const isAskUserQuestionPart = (part: Partial<TMessageContentParts> | undefined): boolean =>
  (part as { type?: string } | undefined)?.type === ASK_USER_QUESTION &&
  part != null &&
  ASK_USER_QUESTION in part;

const getToolCallId = (part: TMessageContentParts | undefined): string =>
  (part?.[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined)?.id ?? '';

/** A tool-call value that may carry approval state and/or nested subagent content. */
type ToolCallWithApproval = Agents.ToolCall & {
  approval?: unknown;
  subagent_content?: TMessageContentParts[];
};

/**
 * Tags one tool-call part with the pending action's approval when it matches an
 * `action_request` (joined by `tool_call_id`, NOT position) and is still unresolved.
 *
 * Recurses into a subagent's `subagent_content`: a tool paused INSIDE a subagent
 * lives there, not as a top-level part, so without this the approval never attaches
 * and the user gets no controls. Returns a NEW part only when something changed.
 */
function tagApprovalOnPart(
  part: TMessageContentParts,
  actionId: string,
  requestByToolCallId: Map<string, Agents.ToolApprovalRequest>,
  reviewByToolCallId: Map<string, Agents.ToolReviewConfig>,
): { part: TMessageContentParts; changed: boolean } {
  if (part?.type !== ContentTypes.TOOL_CALL) {
    return { part, changed: false };
  }
  const toolCall = part[ContentTypes.TOOL_CALL] as ToolCallWithApproval | undefined;
  if (!toolCall) {
    return { part, changed: false };
  }

  let nextToolCall = toolCall;
  let changed = false;

  // Descend into nested subagent tool calls first.
  if (Array.isArray(toolCall.subagent_content) && toolCall.subagent_content.length > 0) {
    let nestedChanged = false;
    const nextNested = toolCall.subagent_content.map((nestedPart) => {
      const res = tagApprovalOnPart(nestedPart, actionId, requestByToolCallId, reviewByToolCallId);
      if (res.changed) {
        nestedChanged = true;
      }
      return res.part;
    });
    if (nestedChanged) {
      nextToolCall = { ...nextToolCall, subagent_content: nextNested };
      changed = true;
    }
  }

  // Tag this call itself when it's one of the paused requests and still unresolved
  // (an `output` means the pause already resolved — leave it alone).
  const toolCallId = getToolCallId(part);
  const request = toolCallId ? requestByToolCallId.get(toolCallId) : undefined;
  if (request && (nextToolCall.output?.length ?? 0) === 0) {
    const reviewConfig = reviewByToolCallId.get(toolCallId);
    nextToolCall = {
      ...nextToolCall,
      // A PreToolUse hook may replace the model's original args before asking.
      // The interrupt payload is authoritative so the reviewer sees, edits, and
      // approves the same arguments the resumed tool will actually execute.
      args: request.arguments,
      approval: {
        actionId,
        allowed_decisions: reviewConfig?.allowed_decisions ?? [],
        remember_scope: reviewConfig?.remember_scope,
        remember_unavailable: reviewConfig?.remember_unavailable,
        description: request.description,
        ...(reviewConfig?.allow_always === true && { allow_always: true }),
      },
    };
    changed = true;
  }

  if (!changed) {
    return { part, changed: false };
  }
  return {
    part: { ...part, [ContentTypes.TOOL_CALL]: nextToolCall } as TMessageContentParts,
    changed: true,
  };
}

/**
 * Maps a tool-approval pending action onto a message's tool-call content parts,
 * including tool calls nested inside subagents (see {@link tagApprovalOnPart}).
 *
 * Returns a NEW message only when something changed (referential stability lets
 * React bail out of needless re-renders); otherwise the original is returned.
 */
function applyToolApproval(
  message: TMessage,
  actionId: string,
  payload: Agents.ToolApprovalInterruptPayload,
): TMessage {
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) {
    return message;
  }

  const reviewByToolCallId = new Map<string, Agents.ToolReviewConfig>();
  for (const config of payload.review_configs) {
    reviewByToolCallId.set(config.tool_call_id, config);
  }
  const requestByToolCallId = new Map<string, Agents.ToolApprovalRequest>();
  for (const requestItem of payload.action_requests) {
    requestByToolCallId.set(requestItem.tool_call_id, requestItem);
  }

  let changed = false;
  const nextContent = content.map((part) => {
    const res = tagApprovalOnPart(part, actionId, requestByToolCallId, reviewByToolCallId);
    if (res.changed) {
      changed = true;
    }
    return res.part;
  });

  if (!changed) {
    return message;
  }
  return { ...message, content: nextContent };
}

/**
 * Appends (or refreshes) an ask-user-question content part for the pending
 * action. Idempotent: replaces an existing part with the same `actionId` rather
 * than stacking duplicates on reconnect/replay.
 */
function applyAskUserQuestion(
  message: TMessage,
  actionId: string,
  payload: Agents.AskUserQuestionInterruptPayload,
): TMessage {
  const content = Array.isArray(message.content) ? message.content : [];
  const askPart = {
    type: ASK_USER_QUESTION,
    [ASK_USER_QUESTION]: {
      actionId,
      question: payload.question,
      ...(payload.questions != null && { questions: payload.questions }),
      ...(payload.tool_call_id != null && { tool_call_id: payload.tool_call_id }),
    },
  } as unknown as TMessageContentParts;

  const existingIdx = content.findIndex(
    (part) =>
      isAskUserQuestionPart(part) &&
      (part as unknown as AskUserQuestionPart)[ASK_USER_QUESTION].actionId === actionId,
  );
  if (existingIdx >= 0) {
    const nextContent = [...content];
    nextContent[existingIdx] = askPart;
    return { ...message, content: nextContent };
  }
  return { ...message, content: [...content, askPart] };
}

/**
 * Parse an `ask_user_question` tool call's args into the question request shape.
 * Args arrive as a JSON string on persisted messages (or an object mid-stream);
 * malformed/empty args degrade to `null` so the caller can render a fallback
 * label instead of crashing on model output.
 */
export function parseAskUserQuestionArgs(
  args: string | Record<string, unknown> | undefined,
): Agents.AskUserQuestionRequest | null {
  let parsed: unknown = args;
  if (typeof args === 'string') {
    if (args.trim().length === 0) {
      return null;
    }
    try {
      parsed = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (
    parsed == null ||
    typeof parsed !== 'object' ||
    typeof (parsed as { question?: unknown }).question !== 'string'
  ) {
    return null;
  }
  const request = parsed as {
    question: string;
    description?: unknown;
    options?: unknown;
    multiSelect?: unknown;
  };
  /** Model/persisted args are untrusted — normalize instead of crashing the
   *  message render on shapes like `options: {}` or non-string entries. */
  const options = Array.isArray(request.options)
    ? request.options.filter(
        (option): option is Agents.AskUserQuestionOption =>
          option != null &&
          typeof (option as { label?: unknown }).label === 'string' &&
          typeof (option as { value?: unknown }).value === 'string',
      )
    : undefined;
  return {
    question: request.question,
    description: typeof request.description === 'string' ? request.description : undefined,
    options: options && options.length > 0 ? options : undefined,
    multiSelect: request.multiSelect === true ? true : undefined,
  };
}

/** Parse and validate the batched form of an ask-user tool call. */
export function parseAskUserQuestionsArgs(
  args: string | Record<string, unknown> | undefined,
): Agents.AskUserQuestionsRequest | null {
  let parsed: unknown = args;
  if (typeof args === 'string') {
    if (args.trim().length === 0) {
      return null;
    }
    try {
      parsed = JSON.parse(args);
    } catch {
      return null;
    }
  }
  const rawQuestions =
    parsed != null && typeof parsed === 'object'
      ? (parsed as { questions?: unknown }).questions
      : undefined;
  if (
    !Array.isArray(rawQuestions) ||
    rawQuestions.length === 0 ||
    rawQuestions.length > MAX_ASK_USER_QUESTIONS
  ) {
    return null;
  }
  const questions: Agents.AskUserQuestionBatchItem[] = [];
  const ids = new Set<string>();
  for (const item of rawQuestions) {
    if (item == null || typeof item !== 'object') {
      return null;
    }
    const id = (item as { id?: unknown }).id;
    const request = parseAskUserQuestionArgs(item as Record<string, unknown>);
    if (
      typeof id !== 'string' ||
      !ASK_USER_QUESTION_ID_PATTERN.test(id) ||
      ids.has(id) ||
      request == null
    ) {
      return null;
    }
    ids.add(id);
    const rawHeader = (item as { header?: unknown }).header;
    const header = typeof rawHeader === 'string' ? rawHeader.trim() : '';
    questions.push({
      id,
      ...(header.length > 0 && header.length <= MAX_ASK_USER_QUESTION_HEADER_LENGTH && { header }),
      ...request,
    });
  }
  return { questions };
}

/**
 * Removes the synthetic ask-user-question part for `actionId` from a message.
 * Pure — returns the same message reference when nothing matched.
 *
 * Called when the answer submits successfully: the card is pause-scoped UI, and
 * once the run resumes the server streams new content parts at ABSOLUTE indices
 * continuing after the pre-pause parts — exactly the slot the appended synthetic
 * part occupies. Left in place, it blocks the incoming part at that index and
 * the resumed segment doesn't render until finalize replaces the message.
 */
export function removeAskUserQuestionPart(message: TMessage, actionId: string): TMessage {
  const content = message.content;
  if (!Array.isArray(content)) {
    return message;
  }
  const nextContent = content.filter(
    (part) =>
      !(
        isAskUserQuestionPart(part) &&
        (part as unknown as AskUserQuestionPart)[ASK_USER_QUESTION].actionId === actionId
      ),
  );
  if (nextContent.length === content.length) {
    return message;
  }
  return { ...message, content: nextContent };
}

/**
 * Session-scoped record of answers the user has submitted, keyed by the ask
 * tool_call id. Render-layer fallback for `AskUserQuestionCall`: the SSE
 * step handler evolves its own cached copy of the streaming message, so a
 * store-level `output` stamp can be overwritten by the next streamed event —
 * this survives any message-copy churn until finalize delivers the
 * server-stamped part. Written by {@link resolveAskUserQuestionPart}.
 */
const submittedAskAnswers = new Map<string, string>();

/**
 * Ask actions the user has answered this session. Same rationale as
 * {@link submittedAskAnswers}: the SSE step handler evolves its own cached copy
 * of the streaming message, so the store-level strip below can't reach it —
 * writing that copy back would resurrect an answered card. Keyed by `actionId`
 * and only ever added to by {@link resolveAskUserQuestionPart}, so a step event
 * racing a still-LIVE pause can never mistake its card for an answered one.
 */
const answeredAskActionIds = new Set<string>();

/** The locally-submitted answer for an ask tool_call, if any. */
export function getSubmittedAskAnswer(toolCallId: string | undefined): string | undefined {
  return toolCallId ? submittedAskAnswers.get(toolCallId) : undefined;
}

/** Whether `part` is an ask card whose question the user already answered. */
export const isAnsweredAskUserQuestionPart = (
  part: Partial<TMessageContentParts> | undefined,
): boolean =>
  isAskUserQuestionPart(part) &&
  answeredAskActionIds.has((part as unknown as AskUserQuestionPart)[ASK_USER_QUESTION].actionId);

/**
 * Resolve an answered ask-user-question pause on the client, mirroring the
 * server's resume-time stamp so the durable Q&A card shows the answer the
 * moment the user submits (the server-patched part otherwise only arrives at
 * finalize): removes the synthetic card part for `actionId` AND patches the
 * newest unanswered `ask_user_question` tool_call with `output = answer`
 * (seeding `args` from the synthetic part's question when the streamed args
 * were lost). Pure — returns the input message when nothing matched.
 */
export function resolveAskUserQuestionPart(
  message: TMessage,
  actionId: string,
  resolution: string | Record<string, string>,
): TMessage {
  const content = message.content;
  if (!Array.isArray(content)) {
    return message;
  }
  const syntheticPart = content.find(
    (part) =>
      isAskUserQuestionPart(part) &&
      (part as unknown as AskUserQuestionPart)[ASK_USER_QUESTION].actionId === actionId,
  ) as unknown as AskUserQuestionPart | undefined;
  if (!syntheticPart) {
    return message;
  }
  answeredAskActionIds.add(actionId);
  /** Exact-attribution target when the payload carried the interrupting call's
   *  id — several ask cards in one turn each resolve their own part. Absent
   *  (older server/SDK), the newest-unanswered fallback below applies. */
  const targetToolCallId = syntheticPart[ASK_USER_QUESTION].tool_call_id;
  const questions = syntheticPart[ASK_USER_QUESTION].questions;
  const args =
    questions != null
      ? JSON.stringify({ questions })
      : JSON.stringify(syntheticPart[ASK_USER_QUESTION].question);
  const output =
    typeof resolution === 'string' ? resolution : JSON.stringify({ answers: resolution });

  let patched = false;
  const nextContent: TMessageContentParts[] = [];
  for (const part of content) {
    if (
      isAskUserQuestionPart(part) &&
      (part as unknown as AskUserQuestionPart)[ASK_USER_QUESTION].actionId === actionId
    ) {
      continue; // strip the pause-scoped card
    }
    nextContent.push(part);
  }
  for (let i = nextContent.length - 1; i >= 0; i--) {
    const part = nextContent[i] as { type?: string; tool_call?: Agents.ToolCall } | undefined;
    const toolCall = part?.tool_call;
    if (part?.type !== ContentTypes.TOOL_CALL || toolCall?.name !== ASK_USER_QUESTION) {
      continue;
    }
    if (
      targetToolCallId != null
        ? toolCall.id !== targetToolCallId
        : typeof toolCall.output === 'string' && toolCall.output.length > 0
    ) {
      continue;
    }
    const hasArgs =
      (typeof toolCall.args === 'string' && toolCall.args.trim().length > 0) ||
      (toolCall.args != null && typeof toolCall.args === 'object');
    nextContent[i] = {
      ...(part as object),
      tool_call: {
        ...toolCall,
        ...(hasArgs ? {} : { args }),
        output,
        progress: 1,
      },
    } as TMessageContentParts;
    if (typeof toolCall.id === 'string' && toolCall.id.length > 0) {
      submittedAskAnswers.set(toolCall.id, output);
    }
    patched = true;
    break;
  }

  if (!patched && nextContent.length === content.length) {
    return message;
  }
  return { ...message, content: nextContent };
}

/**
 * Splits a model-supplied catch-all "Other"-style option away from the real
 * choices. The answer UI always renders its own inline free-form row, so a
 * model option like "Other (type your own)" would duplicate it — instead its
 * label becomes the inline input's placeholder. Conservative match: value
 * `other` (the shape the tool description used to suggest) or a label that
 * reads as a free-form invitation.
 */
export function splitOtherOption(options: Agents.AskUserQuestionOption[] | undefined): {
  choices: Agents.AskUserQuestionOption[];
  otherLabel?: string;
} {
  const list = options ?? [];
  const isOther = (option: Agents.AskUserQuestionOption): boolean =>
    option.value.trim().toLowerCase() === 'other' ||
    /^other\b|something else|type (my|your) own|free[- ]?form/i.test(option.label);
  const otherOption = [...list].reverse().find(isOther);
  if (!otherOption) {
    return { choices: list };
  }
  return {
    choices: list.filter((option) => option !== otherOption),
    otherLabel: otherOption.label,
  };
}

/**
 * Finds the live (unanswered) ask-user-question pause across a conversation's
 * messages — the newest synthetic part wins. Drives the composer popover: the
 * part exists exactly while a pause is live (applied on `on_pending_action`,
 * stripped when the answer submits), so its presence IS the popover signal.
 *
 * Answered cards are skipped rather than assumed absent: the strip is a store
 * write, and any holder of an older message copy (the SSE step handler's
 * in-flight cache, a replayed event) can put one back. Honouring it would
 * reopen the popover on a question the user already answered.
 */
export function findLiveAskUserQuestion(messages: TMessage[] | null | undefined): {
  actionId: string;
  question: Agents.AskUserQuestionRequest;
  questions?: Agents.AskUserQuestionBatchItem[];
  messageId: string;
} | null {
  if (!Array.isArray(messages)) {
    return null;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const content = message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j];
      if (isAskUserQuestionPart(part) && !isAnsweredAskUserQuestionPart(part)) {
        const ask = (part as unknown as AskUserQuestionPart)[ASK_USER_QUESTION];
        return {
          actionId: ask.actionId,
          question: ask.question,
          questions: ask.questions,
          messageId: message.messageId,
        };
      }
    }
  }
  return null;
}

/**
 * EVERY live (unanswered) ask pause across the conversation, as the set of
 * tool_call_ids their synthetic parts attribute, plus whether any live part
 * lacks attribution (older payloads). Unlike {@link findLiveAskUserQuestion}
 * (newest-only, the popover's signal), this lets a per-call surface — the
 * streaming progress card — test whether ITS OWN pause is live even when a
 * newer sibling pause exists.
 */
export function collectLiveAskToolCallIds(messages: TMessage[] | null | undefined): {
  ids: string[];
  hasUnattributed: boolean;
} {
  const ids: string[] = [];
  let hasUnattributed = false;
  if (!Array.isArray(messages)) {
    return { ids, hasUnattributed };
  }
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!isAskUserQuestionPart(part) || isAnsweredAskUserQuestionPart(part)) {
        continue;
      }
      const toolCallId = (part as unknown as AskUserQuestionPart)[ASK_USER_QUESTION].tool_call_id;
      if (toolCallId == null) {
        hasUnattributed = true;
      } else {
        ids.push(toolCallId);
      }
    }
  }
  return { ids, hasUnattributed };
}

/**
 * Applies a {@link Agents.PendingAction} onto the target response message,
 * dispatching on the interrupt type. Pure — returns a new message only when the
 * mapping actually changed something.
 */
export function applyPendingAction(
  message: TMessage,
  pendingAction: Agents.PendingAction,
): TMessage {
  const { payload, actionId } = pendingAction;
  if (payload.type === 'tool_approval') {
    return applyToolApproval(message, actionId, payload);
  }
  if (payload.type === 'ask_user_question') {
    return applyAskUserQuestion(message, actionId, payload);
  }
  return message;
}

/**
 * Counts the tool-call content parts already tagged with this action's approval —
 * i.e. how many of a tool-approval pending action's `action_requests` have rendered
 * and been mapped. A multi-tool pause can render its sibling cards across several
 * frames, so the SSE retry compares this against `action_requests.length` to know
 * whether EVERY paused call is tagged yet.
 */
export function countTaggedApprovalParts(message: TMessage, actionId: string): number {
  const content = message.content;
  if (!Array.isArray(content)) {
    return 0;
  }
  const countIn = (parts: TMessageContentParts[]): number => {
    let count = 0;
    for (const part of parts) {
      if (part?.type !== ContentTypes.TOOL_CALL) {
        continue;
      }
      const toolCall = part[ContentTypes.TOOL_CALL] as ToolCallWithApproval | undefined;
      if ((toolCall?.approval as { actionId?: string } | undefined)?.actionId === actionId) {
        count += 1;
      }
      // Nested subagent tool calls count too, so the retry loop's "all tagged" check
      // is reachable for a tool paused inside a subagent.
      if (Array.isArray(toolCall?.subagent_content)) {
        count += countIn(toolCall.subagent_content);
      }
    }
    return count;
  };
  return countIn(content);
}

/** Returns the ask-user-question synthetic part when `part` is one, else undefined. */
export function getAskUserQuestionPart(
  part: TMessageContentParts | undefined,
): AskUserQuestionPart | undefined {
  return isAskUserQuestionPart(part) ? (part as unknown as AskUserQuestionPart) : undefined;
}

/**
 * Resolves the assistant response message a pending action targets within
 * `messages`. Returns the index, or -1 when the assistant placeholder isn't present
 * yet (the caller retries on the next frame).
 *
 * Only ever matches an ASSISTANT message. The `responseMessageId` for a fresh turn
 * is the user message id with a trailing underscore (`<userMsg>_`), so a naive
 * underscore-strip would resolve to the just-created USER message before the
 * assistant placeholder exists — appending the prompt to the wrong bubble and never
 * triggering the retry. Matching strictly on assistant messages avoids that.
 */
export function findPendingActionMessageIndex(
  messages: TMessage[],
  pendingAction: Agents.PendingAction,
): number {
  const isAssistant = (message: TMessage | undefined) => message?.isCreatedByUser === false;
  const { responseMessageId } = pendingAction;
  if (responseMessageId) {
    // When the id is provided, ONLY an exact assistant match counts. A miss means the
    // assistant placeholder for this turn hasn't been inserted yet — return -1 so the
    // caller retries on the next frame. Falling back to the last assistant here would
    // attach the prompt/approval to a PRIOR reply (applyAskUserQuestion always appends),
    // and the retry would never run. The id is the in-flight response, so once it renders
    // the retry resolves it.
    return messages.findIndex(
      (message) => message.messageId === responseMessageId && isAssistant(message),
    );
  }
  /** No responseMessageId: best-effort to the last assistant (the in-flight placeholder). */
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isAssistant(messages[i])) {
      return i;
    }
  }
  return -1;
}
