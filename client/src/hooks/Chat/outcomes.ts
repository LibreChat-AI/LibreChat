import { ContentTypes } from 'librechat-data-provider';
import type { TMessage, TAttachment, UIMappingOptions } from 'librechat-data-provider';
import { isMemoryFailureOutput } from '~/components/Chat/Messages/Content/Parts/MemoryCall';
import { getToolMeta } from '~/components/Chat/Messages/Content/outcome';
import { mergeAttachments } from '~/utils/attachments';
import { mapAttachments } from '~/utils/map';

type ToolContext = {
  content: TMessage['content'];
  attachments: TMessage['attachments'];
  live: TAttachment[] | undefined;
  byToolCall: Record<string, TAttachment[] | undefined>;
  /** Step ids each provider tool-call id already owns, for calls that have no step yet. */
  stepIdsById: Map<string, Set<string>>;
};

const toolContexts = new WeakMap<TMessage, ToolContext>();

/**
 * Built once per message snapshot and live attachment list. The stream reuses a response object
 * across frames and replaces its `content` and `attachments` arrays, so both are checked, not only
 * the object. A tool's attachments reach the live list before the message cache holds them.
 */
const getToolContext = (message: TMessage, live: TAttachment[] | undefined): ToolContext => {
  const cached = toolContexts.get(message);
  if (
    cached &&
    cached.content === message.content &&
    cached.attachments === message.attachments &&
    cached.live === live
  ) {
    return cached;
  }
  const stepIdsById = new Map<string, Set<string>>();
  for (const part of message.content ?? []) {
    if (part?.type !== ContentTypes.TOOL_CALL) {
      continue;
    }
    const { id, stepId } = (part.tool_call ?? {}) as { id?: string; stepId?: string };
    if (!id || !stepId) {
      continue;
    }
    const owned = stepIdsById.get(id) ?? new Set<string>();
    owned.add(stepId);
    stepIdsById.set(id, owned);
  }
  const context: ToolContext = {
    content: message.content,
    attachments: message.attachments,
    live,
    byToolCall: mapAttachments(mergeAttachments(message.attachments, live)),
    stepIdsById,
  };
  toolContexts.set(message, context);
  return context;
};

type MemoryToolName = Parameters<typeof isMemoryFailureOutput>[0];

const isMemoryTool = (name: string | undefined): name is MemoryToolName =>
  name === 'set_memory' || name === 'delete_memory';

type StoredToolCall = Parameters<NonNullable<UIMappingOptions['resolveToolFailure']>>[0];

/**
 * A memory call's output is its own failure message; a background task's output is only its
 * dispatch handle, so its reason stands instead.
 */
const getFailureProse = (toolCall: StoredToolCall, background: boolean) => {
  const { name, output } = toolCall as { name?: string; output?: unknown };
  if (background || typeof output !== 'string' || !output) {
    return undefined;
  }
  if (!isMemoryTool(name)) {
    return undefined;
  }
  return isMemoryFailureOutput(name, output) ? output : undefined;
};

/**
 * The client's own tool outcome rules (`getToolMeta`: memory failure prose, background task
 * status attachments), handed to the parts mapping, which reads only markers stored on the call.
 * A call with no step yet is scoped away from attachments its repeated provider id's other
 * steps own, as `summarizeSpan` does.
 */
const resolveToolFailure = (
  toolCall: StoredToolCall,
  context: ToolContext | undefined,
): ReturnType<NonNullable<UIMappingOptions['resolveToolFailure']>> => {
  const { id, stepId } = toolCall as { id?: string; stepId?: string };
  const siblingStepIds = stepId == null && id ? context?.stepIdsById.get(id) : undefined;
  const meta = getToolMeta(
    { type: ContentTypes.TOOL_CALL, tool_call: toolCall },
    context?.byToolCall,
    siblingStepIds,
  );
  if (meta?.cancelled) {
    return 'cancelled';
  }
  if (!meta?.failed) {
    return undefined;
  }
  return getFailureProse(toolCall, meta.background != null) ?? 'failed';
};

/** Mapping options that resolve a message's tool outcomes against its live attachments too. */
export const getMappingOptions = (live: TAttachment[] | undefined): UIMappingOptions => ({
  resolveToolFailure: (toolCall, message) =>
    resolveToolFailure(toolCall, message ? getToolContext(message, live) : undefined),
});
