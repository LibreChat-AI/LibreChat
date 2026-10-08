import { useTranslation } from 'react-i18next';
import { isReportableRunStepDuration } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import type { PtcTraceEntry } from '~/common';
import { useMessagePartsHost } from '~/Providers/MessagePartsHostContext';
import { cn, parseToolName, getRunStepDurationLabels } from '~/utils';
import { useMCPServerNames } from '~/hooks/MCP';
import useFollowScroll from './useFollowScroll';
import { useLocalize } from '~/hooks';

/** Terminal-style status column: one glyph wide for every state, so the
 *  tool names stay aligned as calls settle. */
const STATUS_GLYPH: Record<PtcTraceEntry['status'], string> = {
  running: '›',
  success: '✓',
  error: '✗',
  interrupted: '?',
};

/** Spoken equivalent of the glyph. The glyph itself is decorative, and a
 *  fast call renders no duration, so without this a completed row would
 *  announce no outcome at all. */
const STATUS_LABEL_KEYS: Record<PtcTraceEntry['status'], TranslationKeys> = {
  running: 'com_ui_ptc_trace_running',
  success: 'com_ui_ptc_trace_done',
  error: 'com_ui_ptc_trace_failed',
  interrupted: 'com_ui_ptc_trace_interrupted',
};

/**
 * One line of the trace. Reads as a shell transcript — status glyph, the tool
 * being called, its arguments, and how long it took — with the failure message
 * printed underneath the call that produced it, the way a CLI reports errors.
 */
function PtcTraceLine({ entry }: { entry: PtcTraceEntry }) {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const mcpServerNames = useMCPServerNames();
  const parsed = parseToolName(entry.name, mcpServerNames);
  const running = entry.status === 'running';
  const failed = entry.status === 'error';
  const duration = isReportableRunStepDuration(entry.durationMs)
    ? getRunStepDurationLabels(entry.durationMs as number, i18n.language)
    : undefined;

  return (
    <li className="leading-5">
      <div className="flex items-baseline gap-1.5 whitespace-nowrap">
        <span
          aria-hidden="true"
          className={cn(
            'w-2 shrink-0 text-center',
            failed ? 'text-status-error' : 'text-text-tertiary',
            running && 'animate-pulse',
          )}
        >
          {STATUS_GLYPH[entry.status]}
        </span>
        <span className="sr-only">{localize(STATUS_LABEL_KEYS[entry.status])}</span>
        <span className="text-text-primary shrink-0">
          {parsed.mcpServer && (
            <>
              <span className="text-text-secondary">{parsed.mcpServer}</span>
              <span className="text-text-tertiary">·</span>
            </>
          )}
          {parsed.friendlyKey ? localize(parsed.friendlyKey) : parsed.toolName}
        </span>
        <span className="text-text-tertiary min-w-0 flex-1 truncate">{entry.args ?? ''}</span>
        {duration ? (
          <>
            <span className="text-text-tertiary shrink-0 tabular-nums" aria-hidden="true">
              {localize(duration.key, duration.values)}
            </span>
            <span className="sr-only">
              {localize(duration.announcedKey, duration.announcedValues)}
            </span>
          </>
        ) : (
          /* The sr-only status above already speaks this cell's meaning. */
          <span className="text-text-tertiary shrink-0" aria-hidden="true">
            {running ? localize('com_ui_ptc_trace_running') : ''}
          </span>
        )}
      </div>
      {failed && (
        <div className="flex items-baseline gap-1.5">
          <span className="w-2 shrink-0" aria-hidden="true" />
          <span className="text-status-error min-w-0 flex-1 truncate">
            {entry.error ?? localize('com_ui_ptc_trace_failed')}
          </span>
        </div>
      )}
    </li>
  );
}

/**
 * Live trace of the tool calls a programmatic tool-calling program makes from
 * inside the sandbox, rendered under the code that is making them. Those inner
 * calls open no run step and get no card of their own, so without this the
 * card shows one running spinner for the whole program.
 *
 * Renders nothing when the tool call made no inner calls, which is every
 * non-PTC code execution — callers don't need to know which kind they hold.
 */
export default function PtcToolTrace({
  toolCallId,
  expanded = false,
  className,
}: {
  toolCallId?: string;
  /** The host card's disclosure state — a collapsed pane must not be scrolled
   *  invisibly, or it opens at the tail instead of the first call. */
  expanded?: boolean;
  className?: string;
}) {
  const localize = useLocalize();
  /** Scope to this card's own message: providers reuse `tool_call_id` across
   *  turns, so the raw id alone would show a later program's calls here. */
  const { useMessage, usePtcTrace } = useMessagePartsHost();
  const { messageId } = useMessage();
  const trace = usePtcTrace(messageId, toolCallId ?? '');

  /** One character per row, so the pin re-fires both when a call is appended
   *  and when one settles — a settle can add an error line and change height. */
  const followKey = `${trace.dropped}:${trace.entries.map((entry) => entry.status[0]).join('')}`;
  const running = trace.entries.some((entry) => entry.status === 'running');
  const { ref: listRef, onScroll } = useFollowScroll<HTMLOListElement>(
    followKey,
    running,
    expanded,
  );

  if (trace.entries.length === 0) {
    return null;
  }

  /** No background of its own: the pane inherits the card's surface in both
   *  themes, which is what the sibling output pane resolves to anyway. A
   *  `dark:` override here would step outside the semantic roles and lose the
   *  intended separation under a custom theme. */
  return (
    <div className={cn('p-4 text-xs', className)}>
      <div className="text-text-secondary mb-1.5 text-[10px] font-medium tracking-wide uppercase">
        {localize('com_ui_ptc_trace_title')}
      </div>
      <ol
        ref={listRef}
        onScroll={onScroll}
        className="max-h-[200px] overflow-auto font-mono"
        aria-live="polite"
      >
        {/* The retained tail is a window, not the whole program — say so
            rather than let the reader assume these are all the calls. */}
        {trace.dropped > 0 && (
          <li className="text-text-tertiary leading-5">
            {localize('com_ui_ptc_trace_earlier', { count: trace.dropped })}
          </li>
        )}
        {trace.entries.map((entry) => (
          <PtcTraceLine key={entry.callId} entry={entry} />
        ))}
      </ol>
    </div>
  );
}
