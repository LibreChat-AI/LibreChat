import { Tools, Constants, ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import type {
  Agents,
  TAttachment,
  PartMetadata,
  FunctionToolCall,
  TMessageContentParts,
} from 'librechat-data-provider';
import { backgroundTaskOutcome, parseBackgroundTaskOutput } from './Parts/background';
import { parseBackgroundHandle, splitBackgroundAttachments } from './Parts/handle';
import { resolveToolCallPhase } from '~/utils/toolCallPhase';
import { isMemoryFailureOutput } from './Parts/MemoryCall';
import { filterAttachmentsForPart } from '~/utils/map';
import { isBashProgrammaticToolCall } from './routing';
import { parseCommandOutput } from './Parts/command';
import { isError } from './ToolOutput';

/**
 * The one place a tool call's outcome is decided for anything that SUMMARIZES
 * calls — a group header, a live fold's line. Each signal below was added
 * because a summary disagreed with the card it stood for: the run step's
 * terminal verdict, memory tools' prose failures, a backgrounded task's status
 * attachment and its cancelled flag. A summary that derives its own verdict
 * re-learns those one review at a time, so it reads this instead.
 */
export interface ToolMeta {
  name: string;
  iconName: string;
  hasOutput: boolean;
  failed: boolean;
  cancelled: boolean;
  /** Set for a detached task: its dispatch step is long closed, so whether the
   *  WORK is still going is a separate fact — the cards say "Running in
   *  background" until a status marker or harvested files arrive. */
  background?: 'running' | 'finished';
}

function hasFailedOutput(output: unknown): boolean {
  return typeof output === 'string' && isError(output);
}

/** A create_file overwrite displays the edit glyph in its own row. Headers use
 *  the same identity, without changing the tool name used for labels/counts. */
export function getToolIconName(
  name: string,
  args?: string | Record<string, unknown>,
  output?: string | null,
): string {
  if (name === 'create_file' && output?.startsWith('Updated ')) {
    return 'edit_file';
  }
  return isBashProgrammaticToolCall(name, args) ? Tools.bash_tool : name;
}

/**
 * Group metadata must agree with the individual card, which resolves its
 * outcome from the run step's terminal verdict through `resolveToolCallPhase`.
 * Reading output alone leaves a step the run closed as `failed` with empty or
 * benign output counted as neither failed nor finished, so the group sits on
 * "Running" until the response ends and then reports that it ran successfully
 * with no failures while the card beside it shows the failure. A closed step
 * is never running. Parts carrying no terminal status keep the legacy
 * output/progress signal, which is all the older endpoints emit.
 */
function resolveOutcome(
  runStepStatus: PartMetadata['runStepStatus'],
  completed: boolean,
  hasError: boolean,
): Pick<ToolMeta, 'hasOutput' | 'failed' | 'cancelled'> {
  if (runStepStatus == null) {
    return { hasOutput: completed, failed: hasError, cancelled: false };
  }
  const phase = resolveToolCallPhase({
    runStepStatus,
    displayProgress: 1,
    reportedProgress: 1,
    isSubmitting: false,
    hasError,
  });
  return {
    hasOutput: phase !== 'running',
    failed: phase === 'failed',
    /** Tracked separately from `failed`: a stopped step is settled and not an
     *  error, but the group still must not auto-collapse under a
     *  success-sounding header with the only cancellation notice hidden in the
     *  panel. */
    cancelled: phase === 'cancelled',
  };
}

export function getToolMeta(
  part: TMessageContentParts,
  attachmentsByToolCallId?: Record<string, TAttachment[] | undefined>,
  /** Step ids other parts with this provider id already own. A call that has
   *  no step yet must not inherit what an earlier occurrence produced. */
  siblingStepIds?: ReadonlySet<string>,
): ToolMeta | null {
  if (part.type !== ContentTypes.TOOL_CALL) {
    return null;
  }
  const toolCall = part[ContentTypes.TOOL_CALL];
  if (!toolCall) {
    return null;
  }
  /** Terminal verdict lives on the outer `tool_call` object (`PartMetadata`),
   *  not on the per-variant payload, so it is read before any narrowing cast. */
  const runStepStatus = toolCall.runStepStatus;

  const isStandard =
    'args' in toolCall && (!toolCall.type || toolCall.type === ToolCallTypes.TOOL_CALL);
  if (isStandard) {
    /** `agentId` disambiguates attachments when a handoff response repeats a
     *  provider tool-call id across agents; `filterAttachmentsForPart` reads it
     *  the same way. */
    const tc = toolCall as Agents.ToolCall & { progress?: number; agentId?: string };
    /** Subagents can finish with `progress === 1` and no final output
     *  text (the parent saw "" / undefined back). Fall back to progress
     *  so the group header flips from "Running N agents" to "Ran N
     *  agents" on completion even when the child returned no text. */
    const completed = !!tc.output || tc.progress === 1;
    const name = tc.name ?? '';
    const iconName = getToolIconName(name, tc.args, tc.output);
    /** Memory tools report failure in prose ("Invalid key ...") that generic
     *  `isError` parsing does not recognize, so `MemoryCall` classifies it with
     *  its own predicate. Reuse that here or a persisted call with no terminal
     *  status shows a failed card inside a group claiming success. */
    const ownAttachments = filterAttachmentsForPart(
      attachmentsByToolCallId?.[tc.id ?? ''],
      tc.agentId,
      toolCall.stepId,
      toolCall.stepId == null ? siblingStepIds : undefined,
    );
    /** `MemoryCall` also fails on a memory-error ARTIFACT, which arrives as an
     *  attachment beside output that can read as a success. */
    const failedOutput =
      name === 'set_memory' || name === 'delete_memory'
        ? isMemoryFailureOutput(name, tc.output ?? '') ||
          (ownAttachments ?? []).some((attachment) => attachment[Tools.memory]?.type === 'error')
        : hasFailedOutput(tc.output) ||
          /** `BashCall` fails an attached-workspace command that reports a
           *  non-zero exit; only the server marker says the trailer is real. */
          (name === Tools.bash_tool &&
            toolCall.executor === 'attached_workspace' &&
            parseCommandOutput(tc.output ?? '')?.failed === true);
    /** A backgrounded bash/code task reports its verdict through a
     *  `background_task_status` attachment, not its output: the dispatch step
     *  keeps a benign handle and usually closes as `completed`. The child card
     *  folds that marker in as `extraError`, so without it here the group
     *  reported no failed action beside a card showing failure. Correlated the
     *  same way the child is, since provider tool-call ids repeat across agents
     *  and execution steps in handoff responses. */
    const backgroundHandle = parseBackgroundHandle(tc.output);
    const { backgroundStatus, fileAttachments } = splitBackgroundAttachments(ownAttachments, tc.id);
    const backgroundSettled = backgroundStatus != null || (fileAttachments?.length ?? 0) > 0;
    const backgroundFailed = backgroundHandle != null && backgroundStatus === 'error';
    const polled =
      name === Constants.CHECK_BACKGROUND_TASK ? parseBackgroundTaskOutput(tc.output) : null;
    const polledOutcome = backgroundTaskOutcome(polled);
    const backgroundCancelled =
      tc.backgroundTask?.cancelled === true ||
      (backgroundHandle != null && backgroundStatus === 'cancelled') ||
      polledOutcome === 'cancelled';
    return {
      name,
      iconName,
      ...(backgroundHandle != null && {
        background: backgroundSettled ? ('finished' as const) : ('running' as const),
      }),
      ...resolveOutcome(
        backgroundCancelled ? 'cancelled' : runStepStatus,
        completed,
        failedOutput || backgroundFailed || polledOutcome === 'failed',
      ),
    };
  }

  if (toolCall.type === ToolCallTypes.CODE_INTERPRETER) {
    const ci = (toolCall as { code_interpreter?: { outputs?: unknown[] } }).code_interpreter;
    return {
      name: 'code_interpreter',
      iconName: 'code_interpreter',
      ...resolveOutcome(runStepStatus, (ci?.outputs?.length ?? 0) > 0, false),
    };
  }

  if (toolCall.type === ToolCallTypes.RETRIEVAL || toolCall.type === ToolCallTypes.FILE_SEARCH) {
    const output = (toolCall as { output?: string }).output;
    return {
      name: 'file_search',
      iconName: 'file_search',
      ...resolveOutcome(runStepStatus, !!output, hasFailedOutput(output)),
    };
  }

  if (toolCall.type === ToolCallTypes.FUNCTION && ToolCallTypes.FUNCTION in toolCall) {
    const fn = (toolCall as FunctionToolCall).function;
    return {
      name: fn.name,
      iconName: fn.name,
      ...resolveOutcome(runStepStatus, !!fn.output, hasFailedOutput(fn.output)),
    };
  }

  return null;
}

export type SpanOutcome = { failed: number; cancelled: number };

/** The most severe terminal outcome replaces identity glyphs on every summary. */
export function getOutcomeStatus({
  failed,
  cancelled,
}: SpanOutcome): 'failed' | 'cancelled' | undefined {
  if (failed > 0) {
    return 'failed';
  }
  if (cancelled > 0) {
    return 'cancelled';
  }
  return undefined;
}

export type SpanSummary = SpanOutcome & {
  /** Actual tool calls, excluding reasoning, labels and sparse slots. */
  total: number;
  /** Consecutive uses of the last tool, reset by another tool or an agent handoff.
   *  Reasoning and labels describe the work without breaking its sequence. */
  trailingToolCount: number;
  /** The verdict for one part of the span, scoped the way the count was. */
  metaOf: (part: TMessageContentParts) => ToolMeta | null;
};

type CachedMeta = {
  attachments: TAttachment[] | undefined;
  siblings: string;
  meta: ToolMeta | null;
};

/** Content parts are immutable and a streamed delta replaces only the part it
 *  touched, so a verdict is good for as long as the part object, its
 *  attachment list and its sibling steps are the same ones. */
const metaCache = new WeakMap<TMessageContentParts, CachedMeta>();

const toolCallIdentity = (part: TMessageContentParts): { id: string; stepId?: string } => {
  const toolCall = part[ContentTypes.TOOL_CALL] as { id?: string; stepId?: string } | undefined;
  return { id: toolCall?.id ?? '', stepId: toolCall?.stepId };
};

/**
 * Outcome of a span for a summary that shows only its newest line: how many
 * calls failed or were stopped — an earlier call can fail while a later one is
 * still running, and the line alone would never say so — plus the verdict for
 * any single part.
 *
 * Attachment ownership follows `ContentParts`: provider ids repeat across
 * steps, so a call with no step yet excludes what an earlier occurrence of its
 * id already owns. Runs per streamed delta; unchanged parts answer from the
 * cache.
 */
export function summarizeSpan(
  parts: ReadonlyArray<TMessageContentParts | undefined>,
  attachmentsByToolCallId?: Record<string, TAttachment[] | undefined>,
): SpanSummary {
  /** Step ownership only matters when there are attachments to route, which
   *  most runs never have — so the extra walk is paid on first need, once. */
  let stepsById: Map<string, Set<string>> | undefined;
  const ownedSteps = (id: string): Set<string> | undefined => {
    if (attachmentsByToolCallId?.[id] == null) {
      return undefined;
    }
    if (stepsById == null) {
      stepsById = new Map();
      for (const part of parts) {
        if (part?.type !== ContentTypes.TOOL_CALL) {
          continue;
        }
        const owner = toolCallIdentity(part);
        if (owner.id === '' || owner.stepId == null) {
          continue;
        }
        const steps = stepsById.get(owner.id) ?? new Set<string>();
        steps.add(owner.stepId);
        stepsById.set(owner.id, steps);
      }
    }
    return stepsById.get(id);
  };
  const metaOf = (part: TMessageContentParts): ToolMeta | null => {
    if (part.type !== ContentTypes.TOOL_CALL) {
      return null;
    }
    const { id } = toolCallIdentity(part);
    const attachments = attachmentsByToolCallId?.[id];
    const siblingSteps = ownedSteps(id);
    const siblings = siblingSteps == null ? '' : Array.from(siblingSteps).join('|');
    const cached = metaCache.get(part);
    if (cached != null && cached.attachments === attachments && cached.siblings === siblings) {
      return cached.meta;
    }
    const meta = getToolMeta(part, attachmentsByToolCallId, siblingSteps);
    metaCache.set(part, { attachments, siblings, meta });
    return meta;
  };
  let failed = 0;
  let cancelled = 0;
  let total = 0;
  let trailingToolCount = 0;
  let trailingTool: string | undefined;
  for (const part of parts) {
    if (part?.type === ContentTypes.AGENT_UPDATE) {
      trailingTool = undefined;
      trailingToolCount = 0;
    }
    const meta = part == null ? null : metaOf(part);
    if (meta != null) {
      total += 1;
      /** iconName retains full tool identity (including MCP names), with Bash
       *  wrappers already normalized by the cached metadata resolver. */
      trailingToolCount = meta.iconName === trailingTool ? trailingToolCount + 1 : 1;
      trailingTool = meta.iconName;
    }
    if (meta?.failed === true) {
      failed += 1;
    }
    if (meta?.cancelled === true) {
      cancelled += 1;
    }
  }
  return { failed, cancelled, total, trailingToolCount, metaOf };
}
