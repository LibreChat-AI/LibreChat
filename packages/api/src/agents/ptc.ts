import type { StructuredToolInterface } from '@librechat/agents/langchain/tools';
import type { PtcToolCallEvent } from 'librechat-data-provider';

/** Whole-preview budget for one inner call's arguments. */
const ARGS_PREVIEW_MAX_CHARS = 96;
/** Per-value budget, so one long string can't crowd out the other keys. */
const ARGS_VALUE_MAX_CHARS = 40;
const ERROR_PREVIEW_MAX_CHARS = 160;
/**
 * Collapsing whitespace can only shorten a string, so a window this many times
 * the visible budget is always long enough to fill it. Slicing to the window
 * before rewriting matters: this runs synchronously ahead of every inner
 * `invoke`, and without it a multi-megabyte argument would be collapsed in
 * full to produce a forty-character preview.
 */
const CLIP_OVERSCAN = 4;

/** Bounded collapse-and-clip: never rewrites more of `input` than the budget
 *  can possibly need, and marks any truncation it performed. */
const clip = (input: string, max: number): string => {
  const window = input.length > max * CLIP_OVERSCAN ? input.slice(0, max * CLIP_OVERSCAN) : input;
  const collapsed = window.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max && window.length === input.length) {
    return collapsed;
  }
  return `${collapsed.slice(0, max)}…`;
};

/**
 * Collapses an inner call's input into a single `key=value, key=value` line
 * for the CLI-style trace. Values are clipped individually and iteration stops
 * as soon as the joined preview can no longer grow, so a call with a large
 * body or many keys costs the same as a small one.
 */
export function summarizePtcArgs(input: unknown): string {
  if (input == null) {
    return '';
  }
  if (typeof input === 'string') {
    return clip(input, ARGS_PREVIEW_MAX_CHARS);
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return clip(String(input), ARGS_PREVIEW_MAX_CHARS);
  }

  const record = input as Record<string, unknown>;
  const entries: string[] = [];
  let budget = ARGS_PREVIEW_MAX_CHARS;
  /* Keys, not entries: `Object.entries` would materialize every value before
   * the loop starts, so the budget check below could never skip the work it
   * exists to skip. */
  for (const key of Object.keys(record)) {
    if (budget <= 0) {
      break;
    }
    const value = record[key];
    if (value == null || value === '') {
      continue;
    }
    /* Strings are the values that get large (file bodies, request payloads),
     * and `clip` bounds them without touching the tail. Everything else is
     * small enough that serializing it first is cheaper than inspecting it. */
    const rendered = typeof value === 'string' ? value : safeStringify(value);
    if (rendered === '') {
      continue;
    }
    const entry = `${key}=${clip(rendered, ARGS_VALUE_MAX_CHARS)}`;
    entries.push(entry);
    budget -= entry.length + 2;
  }

  return clip(entries.join(', '), ARGS_PREVIEW_MAX_CHARS);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

export interface InstrumentPtcToolMapParams {
  /** The tool map the PTC runner resolves inner calls against. */
  toolMap: Map<string, StructuredToolInterface>;
  /** The PTC run step's tool call id — the card the trace renders under. */
  toolCallId: string;
  runId?: string;
  /**
   * Whether argument and failure previews may ride the stream. False when the
   * deployment filters tool arguments for PII: inner calls never pass through
   * `filteredToolArgumentsResult` (the sandbox bridge invokes them directly),
   * so a preview would put values on the wire that the configured policy
   * exists to keep off it — and a failure message routinely quotes the very
   * argument that caused it. The trace still reports name, status and duration.
   */
  includePreviews?: boolean;
  /**
   * Inner tools whose *name* trips the deployment's PII policy. The event
   * carries the tool name unconditionally, so a name the `name` filter would
   * have blocked on a direct call cannot be allowed to ride the trace instead.
   * These tools still execute — they are simply left unwrapped, so no event
   * about them is ever emitted.
   */
  traceExclusions?: ReadonlySet<string>;
  emit: (event: PtcToolCallEvent) => void;
}

/**
 * Wraps every tool the PTC sandbox can reach so each inner invocation reports
 * its lifecycle on the live stream. The runner (`executeTools` in
 * `@librechat/agents`) resolves a tool by name and calls `invoke` on it, so a
 * `Proxy` intercepting only `invoke` is enough — `name`, `schema`, `mcp` and
 * every other property the runner reads pass straight through to the real
 * tool, and nothing about execution changes.
 */
export function instrumentPtcToolMap({
  toolMap,
  toolCallId,
  runId,
  includePreviews = true,
  traceExclusions,
  emit,
}: InstrumentPtcToolMapParams): Map<string, StructuredToolInterface> {
  let sequence = 0;
  /** Emission is telemetry: a dead stream must never fail the program. */
  const safeEmit = (event: PtcToolCallEvent): void => {
    try {
      emit(event);
    } catch {
      /* stream closed or transport rejected — the run continues */
    }
  };

  const instrumented = new Map<string, StructuredToolInterface>();
  for (const [name, tool] of toolMap) {
    if (traceExclusions?.has(name)) {
      instrumented.set(name, tool);
      continue;
    }
    instrumented.set(
      name,
      new Proxy(tool, {
        get(target, property) {
          if (property !== 'invoke') {
            /** `target` as the receiver, not the proxy: LangChain tools read
             *  private class state through their own getters. */
            return Reflect.get(target, property, target);
          }
          return async (input: unknown, config?: unknown): Promise<unknown> => {
            const callId = `${toolCallId}:${sequence++}`;
            const startedAt = Date.now();
            safeEmit({
              tool_call_id: toolCallId,
              call_id: callId,
              name,
              status: 'running',
              ...(includePreviews ? { args: summarizePtcArgs(input) } : {}),
              ...(runId != null ? { runId } : {}),
            });
            try {
              const result = await (
                target.invoke as (input: unknown, config?: unknown) => Promise<unknown>
              ).call(target, input, config);
              safeEmit({
                tool_call_id: toolCallId,
                call_id: callId,
                name,
                status: 'success',
                durationMs: Date.now() - startedAt,
                ...(runId != null ? { runId } : {}),
              });
              return result;
            } catch (error) {
              safeEmit({
                tool_call_id: toolCallId,
                call_id: callId,
                name,
                status: 'error',
                ...(includePreviews
                  ? {
                      error: clip(
                        error instanceof Error ? error.message : String(error),
                        ERROR_PREVIEW_MAX_CHARS,
                      ),
                    }
                  : {}),
                durationMs: Date.now() - startedAt,
                ...(runId != null ? { runId } : {}),
              });
              throw error;
            }
          };
        },
      }) as StructuredToolInterface,
    );
  }

  return instrumented;
}
