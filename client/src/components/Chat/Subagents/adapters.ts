import { ContentTypes } from 'librechat-data-provider';
import type {
  Agents,
  PartMetadata,
  SubagentActivityItem,
  SubagentControlReceipt,
  SubagentThreadTurn,
  SubagentThreadStatus,
  SubagentThreadView,
  TMessageContentParts,
} from 'librechat-data-provider';
import type { SubagentProgress } from './state';
import { REDACTED_REASONING_MARKER } from './state';

export type ChildActivityItem =
  | {
      type: 'writing';
      text: string;
      phase?: 'commentary' | 'final_answer';
      textTruncated?: boolean;
    }
  | {
      type: 'reasoning';
      text?: string;
      label?: string;
      textTruncated?: boolean;
    }
  | {
      type: 'tool';
      toolCallId: string;
      name: string;
      input?: string | Record<string, unknown>;
      output?: string;
      status: 'running' | 'completed' | 'failed' | 'cancelled';
      inputValidationError?: true;
      approval?: Agents.ToolCall['approval'];
      inputTruncated?: boolean;
      outputTruncated?: boolean;
    }
  | {
      type: 'activity_label';
      label: string;
      labelType?: 'phase';
      toolCallIds?: string[];
      activityStartIndex?: number;
      activityEndIndex?: number;
      activityCount?: number;
      agentIds?: string[];
      status?: 'ok' | 'partial' | 'failed';
      pending?: boolean;
      labelTruncated?: boolean;
    };

export type ChildActivity = {
  title: string;
  prompt?: string;
  status: SubagentThreadStatus;
  items: ChildActivityItem[];
  controls?: Array<
    Omit<SubagentControlReceipt, 'status'> & {
      status: SubagentControlReceipt['status'] | 'submitted';
    }
  >;
  activityTruncated?: boolean;
  controlsTruncated?: boolean;
};

export type ChildConversationTurn = {
  taskId: string;
  trigger: SubagentThreadTurn['trigger'];
  activity: ChildActivity;
};

type ContentToolCall = {
  id?: string;
  args?: string | Record<string, unknown>;
  output?: string;
  name?: string;
  progress?: number;
  runStepStatus?: PartMetadata['runStepStatus'];
  inputValidationError?: true;
  approval?: Agents.ToolCall['approval'];
};

const contentPartsToActivity = (
  parts: TMessageContentParts[],
  approvalVisibility: 'visible' | 'hidden',
): ChildActivityItem[] =>
  parts.flatMap((part, index): ChildActivityItem[] => {
    if (part.type === ContentTypes.TEXT) {
      const textPart = part as {
        text: string;
        phase?: 'commentary' | 'final_answer';
      };
      return [
        {
          type: 'writing',
          text: textPart.text,
          ...(textPart.phase == null ? {} : { phase: textPart.phase }),
        },
      ];
    }
    if (part.type === ContentTypes.THINK) {
      const think = (part as { think?: string }).think ?? '';
      /** Streams from a pre-retention server substitute this marker for the
       *  withheld reasoning text; normalize it back to a textless item so the
       *  shared marker row renders instead of a disclosure containing "…". */
      const text = think === REDACTED_REASONING_MARKER ? '' : think;
      return [
        {
          type: 'reasoning',
          ...(text === '' ? {} : { text }),
          ...(typeof (part as { reasoning_label?: string }).reasoning_label === 'string'
            ? { label: (part as { reasoning_label: string }).reasoning_label }
            : {}),
        },
      ];
    }
    if (part.type === ContentTypes.ACTIVITY_LABEL) {
      const labelPart = part as Extract<
        TMessageContentParts,
        { type: ContentTypes.ACTIVITY_LABEL }
      >;
      const label = labelPart[ContentTypes.ACTIVITY_LABEL]?.trim() ?? '';
      return [
        {
          type: 'activity_label',
          label,
          ...(labelPart.activity_label_type == null
            ? {}
            : { labelType: labelPart.activity_label_type }),
          ...(labelPart.tool_call_ids == null ? {} : { toolCallIds: labelPart.tool_call_ids }),
          ...(labelPart.activity_start_index == null
            ? {}
            : { activityStartIndex: labelPart.activity_start_index }),
          ...(labelPart.activity_end_index == null
            ? {}
            : { activityEndIndex: labelPart.activity_end_index }),
          ...(labelPart.activity_count == null ? {} : { activityCount: labelPart.activity_count }),
          ...(labelPart.agent_ids == null ? {} : { agentIds: labelPart.agent_ids }),
          ...(labelPart.status == null ? {} : { status: labelPart.status }),
          ...(labelPart.pending == null ? {} : { pending: labelPart.pending }),
        },
      ];
    }
    if (part.type !== ContentTypes.TOOL_CALL) return [];
    const tool = (part as { [ContentTypes.TOOL_CALL]?: ContentToolCall })[ContentTypes.TOOL_CALL];
    if (tool == null) return [];
    const runStepStatus =
      (part as { runStepStatus?: PartMetadata['runStepStatus'] }).runStepStatus ??
      tool.runStepStatus;
    const waitingForApproval =
      tool.approval != null &&
      (tool.output?.length ?? 0) === 0 &&
      (tool.progress ?? 0) < 1 &&
      runStepStatus == null;
    const completed = !waitingForApproval && ((tool.progress ?? 0) >= 1 || tool.output != null);
    return [
      {
        type: 'tool',
        toolCallId: tool.id ?? `tool-${index}`,
        name: tool.name ?? '',
        ...(tool.args == null ? {} : { input: tool.args }),
        ...(tool.output == null ? {} : { output: tool.output }),
        status: runStepStatus ?? (completed ? 'completed' : 'running'),
        ...(tool.inputValidationError === true ? { inputValidationError: true } : {}),
        ...(tool.approval == null || approvalVisibility === 'hidden'
          ? {}
          : { approval: tool.approval }),
      },
    ];
  });

const publicActivityToChildActivity = (items: SubagentActivityItem[]): ChildActivityItem[] =>
  items.map((item) => {
    if (item.type !== 'tool') return item;
    return {
      ...item,
      ...(item.input == null ? {} : { input: item.input }),
      ...(item.inputValidationError === true ? { inputValidationError: true } : {}),
    };
  });

/** Merge activity whose transport explicitly declares it is a forward-only
 * suffix. Complete parent-stream projections bypass this function entirely. */
const mergePersistedAndLiveActivity = (
  persisted: ChildActivityItem[],
  live: ChildActivityItem[],
): ChildActivityItem[] => {
  if (persisted.length === 0) return live;
  if (live.length === 0) return persisted;

  const merged = [...persisted];
  for (const item of live) {
    if (item.type === 'tool') {
      const existingIndex = merged.findIndex(
        (candidate) => candidate.type === 'tool' && candidate.toolCallId === item.toolCallId,
      );
      if (existingIndex >= 0) {
        const existing = merged[existingIndex] as Extract<ChildActivityItem, { type: 'tool' }>;
        const next = { ...existing, ...item };
        if (item.name === '') next.name = existing.name;
        if (
          existing.input != null &&
          (item.input == null || item.input === '' || item.input === '{}')
        ) {
          next.input = existing.input;
        }
        merged[existingIndex] = next;
      } else {
        merged.push(item);
      }
      continue;
    }

    const previous = merged.at(-1);
    if (previous?.type !== item.type) {
      merged.push(item);
      continue;
    }
    if (item.type === 'activity_label') {
      merged.push(item);
      continue;
    }
    if (
      item.type === 'writing' &&
      previous.type === 'writing' &&
      previous.phase !== item.phase &&
      !(previous.phase != null && item.phase == null)
    ) {
      merged.push(item);
      continue;
    }
    if (
      item.type === 'reasoning' &&
      previous.type === 'reasoning' &&
      previous.label !== item.label &&
      !(previous.label != null && item.label == null)
    ) {
      merged.push(item);
      continue;
    }
    const previousText = 'text' in previous ? (previous.text ?? '') : '';
    const nextText = item.text ?? '';
    merged[merged.length - 1] = {
      ...previous,
      ...item,
      text: `${previousText}${nextText}`,
    };
  }
  return merged;
};

const liveStatus = ({
  progress,
  initialProgress,
  isSubmitting,
  runStepStatus,
}: {
  progress: SubagentProgress | null;
  initialProgress: number;
  isSubmitting: boolean;
  runStepStatus?: PartMetadata['runStepStatus'];
}): SubagentThreadStatus => {
  if (runStepStatus === 'cancelled') return 'cancelled';
  if (runStepStatus === 'failed' || progress?.status === 'error') return 'failed';
  if (runStepStatus != null || initialProgress >= 1 || progress?.status === 'stop') {
    return 'completed';
  }
  return isSubmitting ? 'running' : 'cancelled';
};

/** Adapts live SSE state, parent persistence, and legacy output at one seam. */
export function adaptLivePersistedActivity(input: {
  title: string;
  prompt?: string;
  progress: SubagentProgress | null;
  persistedContent?: TMessageContentParts[];
  legacyOutput?: string | null;
  initialProgress: number;
  isSubmitting: boolean;
  runStepStatus?: PartMetadata['runStepStatus'];
  isDetached?: boolean;
  approvalVisibility?: 'visible' | 'hidden';
}): ChildActivity {
  const persisted = input.persistedContent ?? [];
  const live = (input.progress?.contentParts ?? []) as TMessageContentParts[];
  const approvalVisibility = input.approvalVisibility ?? 'visible';
  const persistedItems = contentPartsToActivity(persisted, approvalVisibility);
  const liveItems = contentPartsToActivity(live, approvalVisibility);
  let items = persistedItems.length > 0 ? persistedItems : liveItems;
  if (input.isDetached === true && input.progress?.coverage === 'suffix') {
    items = mergePersistedAndLiveActivity(persistedItems, liveItems);
  } else if (input.isDetached === true && liveItems.length > 0) {
    items = liveItems;
  }
  if (items.length === 0 && input.legacyOutput != null && input.legacyOutput !== '') {
    items.push({ type: 'writing', text: input.legacyOutput });
  }
  return {
    title: input.title,
    ...(input.prompt == null ? {} : { prompt: input.prompt }),
    status: liveStatus(input),
    items,
    controls: [],
  };
}

/** Adapts the bounded parent-authorized child view without exposing its storage shape. */
export function adaptDurableThreadActivity(
  view: SubagentThreadView,
  taskId: string,
): ChildActivity {
  const prompt = view.messages.find((message) => message.messageId === `${taskId}:user`)?.text;
  const response = view.messages.find((message) => message.messageId === `${taskId}:assistant`);
  // Tolerate a briefly mixed-version deployment where an older API replica
  // returns the pre-projection view shape.
  const hasProjectedActivity = Array.isArray(view.activity);
  const items = publicActivityToChildActivity(view.activity ?? []);
  if (items.length === 0 && response?.text != null && response.text !== '') {
    items.push({
      type: 'writing',
      text: response.text,
      ...(response.textTruncated === true ? { textTruncated: true } : {}),
    });
  }
  let status = view.status;
  if (!hasProjectedActivity && response != null) {
    status = response.error === true ? 'failed' : 'completed';
  }
  return {
    title: view.title,
    ...(prompt == null ? {} : { prompt }),
    status,
    items,
    controls: view.controlReceipts ?? [],
    controlsTruncated: view.controlReceiptsTruncated === true,
    activityTruncated: view.activityTruncated,
  };
}

const adaptDurableTurn = (turn: SubagentThreadTurn, title: string): ChildConversationTurn => {
  const items = publicActivityToChildActivity(turn.activity ?? []);
  const response = turn.messages.find((message) => message.role === 'assistant');
  if (items.length === 0 && response?.text != null && response.text !== '') {
    items.push({
      type: 'writing',
      text: response.text,
      ...(response.textTruncated === true ? { textTruncated: true } : {}),
    });
  }
  return {
    taskId: turn.taskId,
    trigger: turn.trigger,
    activity: {
      title,
      status: turn.status,
      items,
      controls: turn.controlReceipts ?? [],
      controlsTruncated: turn.controlReceiptsTruncated === true,
      activityTruncated: turn.activityTruncated,
    },
  };
};

/** Adapts the branch-selected durable history into one chronological child conversation. */
export function adaptDurableThreadConversation(view: SubagentThreadView): ChildConversationTurn[] {
  return (view.turns ?? []).map((turn) => adaptDurableTurn(turn, view.title));
}

const triggerDetailScore = (turn: ChildConversationTurn): number =>
  (turn.trigger.summary.trim().length > 0 ? 1 : 0) +
  (turn.trigger.createdAt == null ? 0 : 1) +
  (turn.trigger.externalEvent == null ? 0 : 2);

const mergeTurnControls = (
  older: ChildActivity['controls'],
  newer: ChildActivity['controls'],
): ChildActivity['controls'] => {
  if (older == null) return newer;
  if (newer == null) return older;
  const receipts = new Map(older.map((receipt) => [receipt.invocationId, receipt]));
  for (const receipt of newer) receipts.set(receipt.invocationId, receipt);
  return [...receipts.values()];
};

/** Merge chronological page projections whose bounded Mongo windows can split
 * one task between its user trigger and assistant activity records. */
export function mergeChildConversationTurns(
  ...pages: ChildConversationTurn[][]
): ChildConversationTurn[] {
  const merged: ChildConversationTurn[] = [];
  const indexByTaskId = new Map<string, number>();
  for (const turn of pages.flat()) {
    const existingIndex = indexByTaskId.get(turn.taskId);
    if (existingIndex == null) {
      indexByTaskId.set(turn.taskId, merged.length);
      merged.push(turn);
      continue;
    }
    const older = merged[existingIndex];
    const trigger =
      triggerDetailScore(turn) > triggerDetailScore(older) ? turn.trigger : older.trigger;
    const controls = mergeTurnControls(older.activity.controls, turn.activity.controls);
    merged[existingIndex] = {
      taskId: turn.taskId,
      trigger,
      activity: {
        ...older.activity,
        ...turn.activity,
        items: turn.activity.items.length > 0 ? turn.activity.items : older.activity.items,
        ...(controls == null ? {} : { controls }),
        activityTruncated:
          older.activity.activityTruncated === true || turn.activity.activityTruncated === true,
        controlsTruncated:
          older.activity.controlsTruncated === true || turn.activity.controlsTruncated === true,
      },
    };
  }
  return merged;
}

/** Polling may displace turns from the API's latest window. Retain only one
 * bounded bridge window; older pages remain an explicit user action. */
export const MAX_RETAINED_MOVING_WINDOW_TURNS = 50;

export function retainBoundedMovingWindowTurns(
  current: ChildConversationTurn[],
  displaced: ChildConversationTurn[],
): ChildConversationTurn[] {
  return mergeChildConversationTurns(current, displaced).slice(-MAX_RETAINED_MOVING_WINDOW_TURNS);
}
