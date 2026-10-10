import type { SubagentActivityItem } from 'librechat-data-provider';

const MAX_ACTIVITY_ITEMS = 100;
const MAX_ACTIVITY_BYTES = 64 * 1024;
const MAX_ACTIVITY_TEXT_BYTES = 32 * 1024;
const MAX_TOOL_INPUT_BYTES = 8 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 16 * 1024;
const MAX_TOOL_NAME_BYTES = 512;
const MAX_TOOL_CALL_ID_BYTES = 512;

type Projection = {
  activity: SubagentActivityItem[];
  truncated: boolean;
};

type MutableToolActivity = Extract<SubagentActivityItem, { type: 'tool' }>;
type ProjectedActivityEntry = { item: SubagentActivityItem; active: boolean };
type MutableToolProjection = {
  item: MutableToolActivity;
  entry: ProjectedActivityEntry;
};
type MutableToolQueue = {
  items: MutableToolProjection[];
  nextPending: number;
};

const toolResultStatus = (value: unknown): MutableToolActivity['status'] => {
  if (value === 'error' || value === 'failed') return 'failed';
  if (value === 'cancelled') return 'cancelled';
  return 'completed';
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);

const truncateUtf8 = (input: string, byteLimit: number) => {
  if (Buffer.byteLength(input, 'utf8') <= byteLimit) {
    return { value: input, truncated: false };
  }
  let low = 0;
  let high = input.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(input.slice(0, middle), 'utf8') <= byteLimit) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/.test(input[end - 1])) end -= 1;
  return { value: input.slice(0, end), truncated: true };
};

const safeJson = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
};

const serializedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

const shrinkStringField = <T extends SubagentActivityItem>(
  item: T,
  field: keyof T,
  truncatedField?: keyof T,
): T => {
  const current = item[field];
  if (typeof current !== 'string') return item;
  const base = {
    ...item,
    [field]: '',
    ...(truncatedField == null ? {} : { [truncatedField]: true }),
  } as T;
  if (serializedBytes([base]) > MAX_ACTIVITY_BYTES) return base;
  let low = 0;
  let high = current.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { ...base, [field]: current.slice(0, middle) } as T;
    if (serializedBytes([candidate]) <= MAX_ACTIVITY_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { ...base, [field]: current.slice(0, low) } as T;
};

const fitNewestItemToSerializedBudget = (item: SubagentActivityItem): SubagentActivityItem => {
  if (serializedBytes([item]) <= MAX_ACTIVITY_BYTES) return item;
  if (item.type === 'writing' || item.type === 'reasoning') {
    return shrinkStringField(item, 'text', 'textTruncated');
  }
  if (item.type === 'activity_label') {
    const withoutAssociations = { ...item, toolCallIds: undefined, agentIds: undefined };
    return shrinkStringField(withoutAssociations, 'label', 'labelTruncated');
  }

  // Preserve the terminal output as long as possible: discard oversized input
  // first, then trim output and finally public identity fields if a provider
  // supplied escape-heavy strings.
  let tool = shrinkStringField(item, 'input', 'inputTruncated');
  if (serializedBytes([tool]) <= MAX_ACTIVITY_BYTES) return tool;
  tool = shrinkStringField(tool, 'output', 'outputTruncated');
  if (serializedBytes([tool]) <= MAX_ACTIVITY_BYTES) return tool;
  tool = shrinkStringField(tool, 'name');
  if (serializedBytes([tool]) <= MAX_ACTIVITY_BYTES) return tool;
  return shrinkStringField(tool, 'toolCallId');
};

const boundActivity = (items: SubagentActivityItem[], sourceTruncated: boolean): Projection => {
  let activity = items;
  let truncated = sourceTruncated;
  if (activity.length > MAX_ACTIVITY_ITEMS) {
    activity = activity.slice(-MAX_ACTIVITY_ITEMS);
    truncated = true;
  }
  while (activity.length > 1 && serializedBytes(activity) > MAX_ACTIVITY_BYTES) {
    activity.shift();
    truncated = true;
  }
  if (activity.length === 1 && serializedBytes(activity) > MAX_ACTIVITY_BYTES) {
    activity[0] = fitNewestItemToSerializedBudget(activity[0]);
    truncated = true;
  }
  return { activity, truncated };
};

const visibleStatus = (value: unknown): 'running' | 'completed' | 'failed' | 'cancelled' => {
  if (value === 'completed' || value === 'failed' || value === 'cancelled') return value;
  return 'running';
};

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const nonNegativeTiming = (value: unknown): number | undefined => {
  const parsed = finiteNumber(value);
  return parsed != null && parsed >= 0 ? parsed : undefined;
};

const stringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((candidate): candidate is string => typeof candidate === 'string');
  return result.length === 0 ? undefined : result;
};

/**
 * Validates the storage-bounded ordinary message-content projection. This is
 * the durable fallback for runs that persisted normal LibreChat content but
 * did not write a separate private subagent transcript.
 */
export function projectPersistedMessageActivity(
  value: unknown,
  sourceTruncated = false,
): Projection {
  if (!Array.isArray(value)) return { activity: [], truncated: sourceTruncated };
  let truncated = sourceTruncated;
  const activity = value.flatMap((candidate): SubagentActivityItem[] => {
    if (!isRecord(candidate) || typeof candidate.type !== 'string') {
      truncated = true;
      return [];
    }
    if (candidate.type === 'writing') {
      if (typeof candidate.text !== 'string') {
        truncated = true;
        return [];
      }
      return [
        {
          type: 'writing',
          text: candidate.text,
          ...(candidate.textTruncated === true ? { textTruncated: true } : {}),
        },
      ];
    }
    if (candidate.type === 'reasoning') {
      return [
        {
          type: 'reasoning',
          ...(typeof candidate.text === 'string' && candidate.text !== ''
            ? { text: candidate.text }
            : {}),
          ...(candidate.textTruncated === true ? { textTruncated: true } : {}),
        },
      ];
    }
    if (candidate.type === 'activity_label') {
      if (typeof candidate.label !== 'string') {
        truncated = true;
        return [];
      }
      const toolCallIds = stringArray(candidate.toolCallIds);
      const agentIds = stringArray(candidate.agentIds);
      const activityStartIndex = finiteNumber(candidate.activityStartIndex);
      const activityEndIndex = finiteNumber(candidate.activityEndIndex);
      const activityCount = finiteNumber(candidate.activityCount);
      return [
        {
          type: 'activity_label',
          label: candidate.label,
          ...(candidate.labelType === 'phase' ? { labelType: 'phase' as const } : {}),
          ...(toolCallIds == null ? {} : { toolCallIds }),
          ...(activityStartIndex == null ? {} : { activityStartIndex }),
          ...(activityEndIndex == null ? {} : { activityEndIndex }),
          ...(activityCount == null ? {} : { activityCount }),
          ...(agentIds == null ? {} : { agentIds }),
          ...(candidate.status === 'ok' ||
          candidate.status === 'partial' ||
          candidate.status === 'failed'
            ? { status: candidate.status }
            : {}),
          ...(typeof candidate.pending === 'boolean' ? { pending: candidate.pending } : {}),
          ...(candidate.labelTruncated === true ? { labelTruncated: true } : {}),
        },
      ];
    }
    if (candidate.type !== 'tool') {
      truncated = true;
      return [];
    }
    if (typeof candidate.toolCallId !== 'string' || typeof candidate.name !== 'string') {
      truncated = true;
      return [];
    }
    const completed =
      finiteNumber(candidate.progress) != null && finiteNumber(candidate.progress)! >= 1;
    const output = typeof candidate.output === 'string' ? candidate.output : undefined;
    const runStepStatus = visibleStatus(candidate.runStepStatus);
    const toolPreparationStartedAt = nonNegativeTiming(candidate.toolPreparationStartedAt);
    const toolDispatchedAt = nonNegativeTiming(candidate.toolDispatchedAt);
    const toolPreparationDurationMs = nonNegativeTiming(candidate.toolPreparationDurationMs);
    const toolExecutionDurationMs = nonNegativeTiming(candidate.toolExecutionDurationMs);
    let status: MutableToolActivity['status'] = runStepStatus;
    if (candidate.runStepStatus == null) {
      status = completed || output != null ? 'completed' : 'running';
    }
    return [
      {
        type: 'tool',
        toolCallId: candidate.toolCallId,
        name: candidate.name,
        ...(typeof candidate.input === 'string' && candidate.input !== ''
          ? { input: candidate.input }
          : {}),
        ...(output == null || output === '' ? {} : { output }),
        status,
        ...(toolPreparationStartedAt == null ? {} : { toolPreparationStartedAt }),
        ...(toolDispatchedAt == null ? {} : { toolDispatchedAt }),
        ...(toolPreparationDurationMs == null ? {} : { toolPreparationDurationMs }),
        ...(toolExecutionDurationMs == null ? {} : { toolExecutionDurationMs }),
        ...(candidate.inputValidationError === true ? { inputValidationError: true } : {}),
        ...(candidate.inputTruncated === true ? { inputTruncated: true } : {}),
        ...(candidate.outputTruncated === true ? { outputTruncated: true } : {}),
      },
    ];
  });
  return boundActivity(activity, truncated);
}

/** Validates a storage-bounded, settlement-time public activity projection. */
export function projectPersistedMessageActivityJson(
  activityJson: string,
  sourceTruncated = false,
): Projection {
  try {
    return projectPersistedMessageActivity(JSON.parse(activityJson) as unknown, sourceTruncated);
  } catch {
    return { activity: [], truncated: true };
  }
}

const reasoningBlockText = (block: Record<string, unknown>): string => {
  if (typeof block.reasoning === 'string') return block.reasoning;
  if (typeof block.thinking === 'string') return block.thinking;
  if (typeof block.text === 'string') return block.text;
  return '';
};

const visibleContent = (
  value: unknown,
): { text: string; hasReasoning: boolean; reasoning: string } => {
  if (typeof value === 'string') return { text: value, hasReasoning: false, reasoning: '' };
  if (!Array.isArray(value)) return { text: '', hasReasoning: false, reasoning: '' };
  const text: string[] = [];
  const reasoning: string[] = [];
  let hasReasoning = false;
  for (const block of value) {
    if (!isRecord(block) || typeof block.type !== 'string') continue;
    if ((block.type === 'text' || block.type === 'text-plain') && typeof block.text === 'string') {
      text.push(block.text);
    } else if (block.type === 'reasoning' || block.type === 'thinking') {
      /** The same user reads this exact reasoning in the main chat view, so the
       *  bounded projection keeps its text rather than only a lifecycle marker. */
      hasReasoning = true;
      const blockText = reasoningBlockText(block);
      if (blockText !== '') reasoning.push(blockText);
    }
  }
  return { text: text.join(''), hasReasoning, reasoning: reasoning.join('\n\n') };
};

const readToolCalls = (data: Record<string, unknown>): unknown[] => {
  if (Array.isArray(data.tool_calls)) return data.tool_calls;
  const additional = isRecord(data.additional_kwargs) ? data.additional_kwargs : undefined;
  return Array.isArray(additional?.tool_calls) ? additional.tool_calls : [];
};

const normalizeToolCall = (
  value: unknown,
  index: number,
): { rawId: string; item: MutableToolActivity } | undefined => {
  if (!isRecord(value)) return undefined;
  const fn = isRecord(value.function) ? value.function : undefined;
  const rawName = typeof value.name === 'string' ? value.name : fn?.name;
  if (typeof rawName !== 'string' || rawName.trim() === '') return undefined;
  const rawId = typeof value.id === 'string' && value.id !== '' ? value.id : `tool-${index}`;
  const rawInput = value.args ?? fn?.arguments;
  const input = truncateUtf8(safeJson(rawInput), MAX_TOOL_INPUT_BYTES);
  return {
    rawId,
    item: {
      type: 'tool',
      toolCallId: truncateUtf8(rawId, MAX_TOOL_CALL_ID_BYTES).value,
      name: truncateUtf8(rawName, MAX_TOOL_NAME_BYTES).value,
      ...(input.value === '' ? {} : { input: input.value }),
      ...(input.truncated ? { inputTruncated: true } : {}),
      status: 'running',
    },
  };
};

const uniqueToolActivityId = (
  rawId: string,
  used: Set<string>,
  nextGeneratedOccurrence: { value: number },
): string => {
  const base = truncateUtf8(rawId, MAX_TOOL_CALL_ID_BYTES).value || 'tool';
  let candidate = base;
  while (used.has(candidate)) {
    const suffix = `#${nextGeneratedOccurrence.value}`;
    nextGeneratedOccurrence.value += 1;
    const prefix = truncateUtf8(base, MAX_TOOL_CALL_ID_BYTES - Buffer.byteLength(suffix)).value;
    candidate = `${prefix}${suffix}`;
  }
  used.add(candidate);
  return candidate;
};

/**
 * Converts one server-private LangChain transcript into a bounded public
 * activity projection. Visible text, bounded reasoning text, and declared
 * tool calls/results are retained; response metadata, artifacts, and runtime
 * fields are intentionally ignored.
 */
export function projectSubagentActivity(
  messagesJson: string | undefined,
  mode: 'append' | 'replace' = 'append',
  expectedTaskInput?: string,
): Projection {
  if (messagesJson == null) return { activity: [], truncated: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(messagesJson) as unknown;
  } catch {
    return { activity: [], truncated: true };
  }
  if (!Array.isArray(parsed)) return { activity: [], truncated: true };
  let relevantMessages = parsed;
  if (mode === 'replace') {
    if (expectedTaskInput == null) return { activity: [], truncated: true };
    let latestInputIndex = -1;
    for (let index = parsed.length - 1; index >= 0; index -= 1) {
      const stored = parsed[index];
      if (isRecord(stored) && (stored.type === 'human' || stored.type === 'user')) {
        latestInputIndex = index;
        break;
      }
    }
    // A replacement transcript can contain the complete child history. If
    // its current input boundary is missing, fail closed instead of exposing
    // activity from earlier invocations on the selected parent card.
    if (
      latestInputIndex < 0 ||
      !isRecord(parsed[latestInputIndex]) ||
      !isRecord(parsed[latestInputIndex].data) ||
      visibleContent(parsed[latestInputIndex].data.content).text !== expectedTaskInput
    ) {
      return { activity: [], truncated: true };
    }
    relevantMessages = parsed.slice(latestInputIndex + 1);
  }

  const activity: ProjectedActivityEntry[] = [];
  const toolsByRawId = new Map<string, MutableToolQueue>();
  const usedToolActivityIds = new Set<string>();
  // A global cursor makes collision probing amortized linear even when many
  // maximum-length provider IDs collapse to the same suffixed prefix.
  const nextGeneratedToolOccurrence = { value: 2 };
  let truncated = false;
  const append = (item: SubagentActivityItem) => {
    const entry = { item, active: true };
    activity.push(entry);
    return entry;
  };

  for (const stored of relevantMessages) {
    if (!isRecord(stored) || !isRecord(stored.data) || typeof stored.type !== 'string') {
      truncated = true;
      continue;
    }
    const { data } = stored;
    if (stored.type === 'ai' || stored.type === 'assistant') {
      const content = visibleContent(data.content);
      if (content.hasReasoning) {
        const reasoning = truncateUtf8(content.reasoning, MAX_ACTIVITY_TEXT_BYTES);
        append({
          type: 'reasoning',
          ...(reasoning.value === '' ? {} : { text: reasoning.value }),
          ...(reasoning.truncated ? { textTruncated: true } : {}),
        });
      }
      if (content.text !== '') {
        const text = truncateUtf8(content.text, MAX_ACTIVITY_TEXT_BYTES);
        append({
          type: 'writing',
          text: text.value,
          ...(text.truncated ? { textTruncated: true } : {}),
        });
      }
      readToolCalls(data).forEach((call, index) => {
        const normalized = normalizeToolCall(call, index);
        if (normalized == null) return;
        normalized.item.toolCallId = uniqueToolActivityId(
          normalized.item.toolCallId,
          usedToolActivityIds,
          nextGeneratedToolOccurrence,
        );
        const entry = append(normalized.item);
        const queue = toolsByRawId.get(normalized.rawId) ?? { items: [], nextPending: 0 };
        queue.items.push({ item: normalized.item, entry });
        toolsByRawId.set(normalized.rawId, queue);
      });
      continue;
    }
    if (stored.type !== 'tool') continue;
    const toolCallId = typeof data.tool_call_id === 'string' ? data.tool_call_id : '';
    const output = truncateUtf8(visibleContent(data.content).text, MAX_TOOL_OUTPUT_BYTES);
    const queue = toolsByRawId.get(toolCallId);
    const existing = queue?.items[queue.nextPending];
    if (queue != null && existing != null) {
      queue.nextPending += 1;
      existing.item.status = toolResultStatus(data.status);
      if (output.value !== '') existing.item.output = output.value;
      if (output.truncated) existing.item.outputTruncated = true;
      existing.entry.active = false;
      existing.entry = append(existing.item);
      continue;
    }
    const name = typeof data.name === 'string' && data.name !== '' ? data.name : 'tool';
    const projectedToolCallId = uniqueToolActivityId(
      toolCallId || `tool-result-${activity.length}`,
      usedToolActivityIds,
      nextGeneratedToolOccurrence,
    );
    const orphan: MutableToolActivity = {
      type: 'tool',
      toolCallId: projectedToolCallId,
      name: truncateUtf8(name, MAX_TOOL_NAME_BYTES).value,
      ...(output.value === '' ? {} : { output: output.value }),
      ...(output.truncated ? { outputTruncated: true } : {}),
      status: toolResultStatus(data.status),
    };
    append(orphan);
  }

  const boundedActivity = activity.filter((entry) => entry.active).map((entry) => entry.item);
  return boundActivity(boundedActivity, truncated);
}

export const SUBAGENT_ACTIVITY_LIMITS = {
  items: MAX_ACTIVITY_ITEMS,
  bytes: MAX_ACTIVITY_BYTES,
  textBytes: MAX_ACTIVITY_TEXT_BYTES,
  toolInputBytes: MAX_TOOL_INPUT_BYTES,
  toolOutputBytes: MAX_TOOL_OUTPUT_BYTES,
} as const;
