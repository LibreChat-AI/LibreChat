import { Tools, Constants, ContentTypes, stripToolCallErrorPrefix } from 'librechat-data-provider';
import type {
  Agents,
  TAttachment,
  PartMetadata,
  TMessageContentParts,
} from 'librechat-data-provider';
import type { TOptions } from 'i18next';
import type { SpanOutcome, SpanSummary } from './outcome';
import type { TranslationKeys } from '~/hooks';
import { getBatchActivityLabelPart, getActivityLabelText } from '~/utils/activityLabels';
import { hasPendingApprovalInPart, hasPendingAuthInPart } from '~/utils/groupToolCalls';
import { ASK_USER_QUESTION, getSubmittedAskAnswer } from '~/utils/approval';
import { getToolDisplayLabel, parseToolName } from '~/utils/toolLabels';
import { boundIntentLabel, getToolCallIntent } from './Parts/intent';
import { isBashProgrammaticToolCall } from './routing';
import { getToolMeta, summarizeSpan } from './outcome';
import { isError } from './ToolOutput';

/** How often a live fold's header may repaint. A streamed intent moves the
 *  newest line on nearly every delta; the header is a glanceable status, not a
 *  transcript, so it takes the latest value at most twice a second. */
export const LIVE_ACTIVITY_THROTTLE_MS = 500;

export type LiveActivity = {
  /** The newest line of the span, or empty before anything nameable exists. */
  text: string;
  /** Identity of whatever produced `text`. A sentence still streaming keeps
   *  its source, so the header can extend it in place and reserve the ticker
   *  transition for a genuinely different line. */
  source: string;
  iconNames: string[];
  /** Set while the newest line is a call still running with no intent of its
   *  own. Code cards name their startup from sandbox events that live outside
   *  the content array; the header reads the same signal for this call rather
   *  than unfolding the span to let the card say it. */
  pendingToolCallId?: string;
  /** Consecutive uses of the newest tool, including the current call. Above 1
   *  only while the line is the tool's own generic label, which is the only
   *  thing a count of that tool can modify. */
  comboCount: number;
  /** Failed and stopped calls anywhere in the span, not just the newest line. */
  outcome: SpanOutcome;
};

type Localize = (phraseKey: TranslationKeys, options?: TOptions) => string;

type LiveToolCall = Agents.ToolCall & { subagent_content?: TMessageContentParts[] } & Pick<
    PartMetadata,
    'runStepStatus'
  > & { progress?: number };

/**
 * The agents-shaped call — the only variant a live header can name. The
 * legacy Assistants variants (code interpreter, retrieval, function) carry no
 * top-level `args`; a span made only of those is left unfolded.
 */
export const getStandardToolCall = (part: TMessageContentParts): LiveToolCall | undefined => {
  if (part.type !== ContentTypes.TOOL_CALL) {
    return undefined;
  }
  const toolCall = part[ContentTypes.TOOL_CALL];
  return toolCall != null && 'args' in toolCall ? (toolCall as LiveToolCall) : undefined;
};

/**
 * True when the run is waiting on the reader: an unresolved approval, a
 * sign-in, or an open question. A live fold must never hold one of these — the
 * span renders unfolded until it clears.
 */
export function needsReader(part: TMessageContentParts | undefined): boolean {
  if (part == null) {
    return false;
  }
  if (hasPendingApprovalInPart(part) || hasPendingAuthInPart(part)) {
    return true;
  }
  const toolCall = getStandardToolCall(part);
  if (toolCall == null) {
    return false;
  }
  if (toolCall.name === ASK_USER_QUESTION) {
    return (toolCall.output?.length ?? 0) === 0 && getSubmittedAskAnswer(toolCall.id) === undefined;
  }
  /** A subagent's own calls can wait on the reader too, and the collapsed row
   *  unmounts the card that leads to them. */
  return Array.isArray(toolCall.subagent_content) && toolCall.subagent_content.some(needsReader);
}

/**
 * A tool's line, and whether it is the generic label rather than a line about
 * this one call. `generic` is what a repeat count may modify: `Running Code ×3`
 * counts runs of Code, while `Checking the PR head ×3` would claim that
 * sentence happened three times — a call that names its own work already says
 * which work it is doing, so the count only confuses it.
 */
type ToolLine = { text: string; generic: boolean };

function toolCallLine(
  part: TMessageContentParts,
  toolCall: LiveToolCall,
  localize: Localize,
  serverNames: readonly string[],
  span: SpanSummary,
): ToolLine {
  const intent = getToolCallIntent(toolCall.args);
  const label = getToolDisplayLabel(toolCall.name ?? '', localize, serverNames);
  /** The verdict comes from the resolver the group header uses, so a collapsed
   *  row can never read as a success while the card it hides shows a failure
   *  or a stop — whichever channel reported it. */
  const meta = span.metaOf(part);
  if (meta?.cancelled === true) {
    return { text: localize('com_ui_cancelled'), generic: false };
  }
  if (meta?.failed === true) {
    /** Reads as the hidden card does: `ToolCall` uses the same template. */
    const subject = intent ?? label;
    return {
      text: subject ? localize('com_ui_failed_subject', { 0: subject }) : localize('com_ui_failed'),
      generic: false,
    };
  }
  /** Ahead of the intent, as on `BashCall`/`ExecuteCode`: a returned handle
   *  is not a result, and "Ran …" would turn ongoing work into a success. */
  if (meta?.background != null) {
    return {
      text: localize(
        meta.background === 'running' ? 'com_ui_background_running' : 'com_ui_background_finished',
      ),
      generic: false,
    };
  }
  if (intent != null) {
    return { text: intent, generic: false };
  }
  if (!label) {
    return { text: localize('com_assistants_running_action'), generic: true };
  }
  return {
    text: localize(
      meta?.hasOutput === true ? 'com_assistants_completed_function' : 'com_assistants_running_var',
      { 0: label },
    ),
    generic: true,
  };
}

/** Bounds the sentence scan on long reasoning, like the streaming peek. */
const REASONING_TAIL_CHARS = 1200;

/** How long a completed reasoning sentence holds the line before the next
 *  one may replace it. Sentences can close a few hundred milliseconds apart;
 *  a line that swaps that often cannot be read, and the header is there to be
 *  read, not to keep pace with the stream. */
export const LIVE_REASONING_HOLD_MS = 1000;

/**
 * The last COMPLETE sentence of a thought: the one that ends at the newest
 * sentence mark, never the one still being written. A line that grew word by
 * word read as disjointed fragments ("This is a simple greeting, not") and
 * was gone before it made sense; a finished sentence says one thing and stays
 * until the next is finished. Undefined until the first mark lands, so the
 * header keeps its generic line rather than showing a fragment.
 *
 * Preview offsets are not activity identities: a sliding window, whitespace
 * or a resumed snapshot can move them without starting a new thought.
 */
function lastReasoningSentence(reasoning: string): string | undefined {
  const tail = reasoning
    .slice(-REASONING_TAIL_CHARS)
    .replace(/^\s*<think>\s*/, '')
    .replace(/\s*<\/think>\s*$/, '')
    .trimEnd();
  if (!tail) {
    return undefined;
  }
  /** A Latin mark closes a sentence only when followed by space or the end
   *  of the text, so "3.5" and "v2.1" stay whole; CJK marks need no space. */
  const boundary = /[.!?](?:\s+|$)|[。！？]\s*/g;
  let start = 0;
  let complete: string | undefined;
  for (let match = boundary.exec(tail); match != null; match = boundary.exec(tail)) {
    /** The mark itself is one code unit in both scripts. */
    complete = tail.slice(start, match.index + 1);
    start = match.index + match[0].length;
  }
  return complete == null ? undefined : boundIntentLabel(complete);
}

/**
 * A foreground subagent still running. Its card is a live surface of its own:
 * the ticker and the terminal error/stop state come from the subagent progress
 * atom, not from the outer tool-call part, so a folded header could not follow
 * it. The span stays unfolded until the subagent settles.
 */
function isLiveSubagent(part: TMessageContentParts): boolean {
  const toolCall = getStandardToolCall(part);
  return (
    toolCall?.name === Constants.SUBAGENT &&
    (toolCall.output?.length ?? 0) === 0 &&
    toolCall.progress !== 1 &&
    toolCall.runStepStatus == null
  );
}

/** True when a live fold cannot stand for this part right now. */
export function blocksLiveFold(part: TMessageContentParts | undefined): boolean {
  if (part == null) {
    return false;
  }
  return needsReader(part) || isLiveSubagent(part);
}

/** Icons the header stack can show. */
const MAX_LIVE_ICONS = 4;

/** How far back from the tail the icon scan looks. This runs on every streamed
 *  delta, so its cost must not grow with the run; the stack then shows the
 *  tools of the recent stretch, which is also what the line beside it names. */
const LIVE_ICON_WINDOW = 24;

/**
 * Tool names for a span's icon stack, oldest first, read from a fixed window
 * behind the tail so the cost does not grow with the run.
 */
export function getSpanIconNames(parts: ReadonlyArray<TMessageContentParts | undefined>): string[] {
  const icons = new Set<string>();
  const floor = Math.max(0, parts.length - LIVE_ICON_WINDOW);
  for (let position = parts.length - 1; position >= floor; position -= 1) {
    if (icons.size === MAX_LIVE_ICONS) {
      break;
    }
    const part = parts[position];
    const toolCall = part == null ? undefined : getStandardToolCall(part);
    if (toolCall != null) {
      const name = toolCall.name ?? '';
      icons.add(isBashProgrammaticToolCall(name, toolCall.args) ? Tools.bash_tool : name);
      continue;
    }
    const legacy = part == null ? null : getToolMeta(part);
    if (legacy != null) {
      icons.add(legacy.iconName);
    }
  }
  return Array.from(icons).reverse();
}

/** A call still running whose line is only the generic one: no intent, no
 *  verdict, no background state. */
function isAwaitingStartup(
  part: TMessageContentParts,
  toolCall: LiveToolCall,
  span: SpanSummary,
): boolean {
  const meta = span.metaOf(part);
  return (
    toolCall.id != null &&
    meta != null &&
    !meta.hasOutput &&
    !meta.failed &&
    !meta.cancelled &&
    meta.background == null &&
    getToolCallIntent(toolCall.args) == null
  );
}

function newestLine(
  parts: ReadonlyArray<TMessageContentParts | undefined>,
  localize: Localize,
  serverNames: readonly string[],
  span: SpanSummary,
  preferLabels: boolean,
): Pick<LiveActivity, 'text' | 'source' | 'pendingToolCallId' | 'comboCount'> {
  for (let position = parts.length - 1; position >= 0; position -= 1) {
    const part = parts[position];
    if (part == null) {
      continue;
    }
    if (part.type === ContentTypes.THINK) {
      /** Reached before any call or label, this thought IS the tail — the
       *  model is reasoning about its next step. Its multi-line peek stays
       *  inside the fold, so the header previews it one sentence at a time.
       *  Unless the fold is open: the text is on screen then, and a header
       *  repeating a line of it under the reader's eyes is noise, so the
       *  header keeps to the thought's label. */
      const reasoning = typeof part.think === 'string' ? part.think : (part.think?.value ?? '');
      const label = part.reasoning_label?.trim();
      if (preferLabels) {
        /** Only a generated label will do: the generic thinking line is what
         *  the grouped thought row itself says. */
        if (label) {
          return { text: label, source: `think:${position}`, comboCount: 1 };
        }
        continue;
      }
      const sentence = lastReasoningSentence(reasoning);
      if (sentence != null) {
        return { text: sentence, source: `think:${position}`, comboCount: 1 };
      }
      if (label || reasoning.trim()) {
        return {
          text: label || localize('com_ui_thinking'),
          source: `think:${position}`,
          comboCount: 1,
        };
      }
      continue;
    }
    if (part.type === ContentTypes.TEXT) {
      /** Only short commentary can sit inside a fold. It is the model talking
       *  about what it is doing, which is exactly what this line is for —
       *  leaving it unnamed would hold a stale call on screen while new prose
       *  piles up behind the disclosure. */
      const value = typeof part.text === 'string' ? part.text : (part.text?.value ?? '');
      const commentary = preferLabels ? undefined : boundIntentLabel(value);
      if (commentary != null) {
        return { text: commentary, source: `text:${position}`, comboCount: 1 };
      }
      continue;
    }
    const labelText = getActivityLabelText(getBatchActivityLabelPart(part));
    if (labelText) {
      return { text: labelText, source: `label:${position}`, comboCount: 1 };
    }
    const toolCall = getStandardToolCall(part);
    /** A call's line, intent or generic, is the text of its own row, so an
     *  open card walks past it to the newest label instead. */
    if (toolCall != null && preferLabels) {
      continue;
    }
    if (toolCall != null) {
      const line = toolCallLine(part, toolCall, localize, serverNames, span);
      return {
        text: line.text,
        /** Provider ids repeat across batches, so the position is part of the
         *  identity: a second call reusing an id is a new line, not the first
         *  one still growing. */
        source: `tool:${toolCall.id ?? ''}:${position}`,
        /** Counted for the generic label alone: as soon as the call names its
         *  own work, or reports how it ended, the count has nothing left to
         *  multiply and reads as a claim about that sentence. */
        comboCount: line.generic ? Math.max(1, span.trailingToolCount) : 1,
        ...(isAwaitingStartup(part, toolCall, span) && { pendingToolCallId: toolCall.id }),
      };
    }
  }
  /** An open card with no label yet is titled by a line no row uses. */
  if (preferLabels && parts.some((part) => part != null)) {
    return { text: localize('com_ui_running'), source: 'running', comboCount: 1 };
  }
  return { text: '', source: '', comboCount: 1 };
}

/**
 * The newest nameable activity in a span: the last tool call's own line (its
 * streamed intent, else the generic text its card would show), a filled batch
 * label once one lands after it, or the thought streaming after both. Later parts win, so the
 * header always reads as the bottom line of the list it stands for. A repeat
 * count rides the generic label only, never a line that names one call.
 *
 * Runs on every streamed delta. Outcomes and the tool combo share one full-span
 * pass so late failures cannot disappear; the line stops at the newest nameable
 * part and icons only inspect a fixed tail window.
 */
export function getLiveActivity(
  parts: ReadonlyArray<TMessageContentParts | undefined>,
  localize: Localize,
  serverNames: readonly string[],
  attachmentsById?: Record<string, TAttachment[] | undefined>,
  /** Name the span by its newest generated LABEL alone: a batch label or a
   *  thought's label, else a generic running line. Never a call's intent, a
   *  reasoning sentence, commentary or the generic thinking line, since each
   *  of those is the text of a row. For a header whose rows are on screen,
   *  where quoting any of them back is repetition. */
  preferLabels = false,
): LiveActivity {
  const span = summarizeSpan(parts, attachmentsById);
  return {
    ...newestLine(parts, localize, serverNames, span, preferLabels),
    outcome: { failed: span.failed, cancelled: span.cancelled },
    iconNames: getSpanIconNames(parts),
  };
}

export type FailedLine = {
  /** The row's own failed label: `Failed: <intent or tool>`. */
  text: string;
  /** The first line of what the tool returned, with the error prefix removed. */
  detail: string;
  iconName: string;
};

const PROCESSING_PREFIX = /^Error processing tool:?\s*/i;
/** Whatever prefix survives the two above, so a peek row does not spend its
 *  one line on the word the red glyph beside it already says. */
const GENERIC_ERROR_PREFIX = /^Error:\s*/i;

/** The opening line of an error, for a peek row that has one line to spend. */
export function firstErrorLine(output: string | null | undefined): string {
  /** Only output that IS an error. A step the run closed as failed, or a
   *  task failed by its status attachment, can carry ordinary output, and
   *  showing that in red as the reason would misreport the failure. */
  if (!output || !isError(output)) {
    return '';
  }
  const cleaned = stripToolCallErrorPrefix(output)
    .replace(PROCESSING_PREFIX, '')
    .replace(GENERIC_ERROR_PREFIX, '')
    .trim();
  const newline = cleaned.indexOf('\n');
  return newline === -1 ? cleaned : cleaned.slice(0, newline).trim();
}

/**
 * Every failed call in a span, in order, as the line its card shows plus the
 * first line of its error. A collapsed header peeks the first of these so the
 * failure is readable without unfolding; the count of the rest rides beside it.
 */
export function getFailedLines(
  parts: ReadonlyArray<TMessageContentParts | undefined>,
  localize: Localize,
  serverNames: readonly string[],
  attachmentsById?: Record<string, TAttachment[] | undefined>,
): FailedLine[] {
  const span = summarizeSpan(parts, attachmentsById);
  const lines: FailedLine[] = [];
  for (const part of parts) {
    if (part == null) {
      continue;
    }
    const meta = span.metaOf(part);
    const toolCall = getStandardToolCall(part);
    if (meta?.failed !== true || toolCall == null) {
      continue;
    }
    /** Named as the ROW names itself, since the peek stands in for the row:
     *  the model's intent, else the bare tool for an MCP call (`ToolCall`
     *  shows the server as a subtitle), else the tool's display label. The
     *  live ticker names the server instead, as its group header does. */
    const parsed = parseToolName(toolCall.name ?? '', serverNames);
    const subject =
      getToolCallIntent(toolCall.args) ??
      (parsed.mcpServer ? parsed.toolName : getToolDisplayLabel(parsed.raw, localize, serverNames));
    lines.push({
      text: subject ? localize('com_ui_failed_subject', { 0: subject }) : localize('com_ui_failed'),
      detail: firstErrorLine(toolCall.output),
      iconName: meta.iconName,
    });
  }
  return lines;
}
