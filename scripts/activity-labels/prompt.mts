/**
 * Faithful port of the SDK's `buildActivityLabelPrompt`
 * (agentus src/prompts/activityLabel.ts) — the PREFERRED path that serves
 * every production label. The older live-check script mirrors a simplified
 * e2e capture; this port keeps section order (Intent → Reasoning excerpts →
 * Tool calls → Label:), the 12-entry cap with the "…and N more" suffix, and
 * the exact truncation semantics, so synthetic corpus cases render the same
 * bytes production would send. Redaction is intentionally not ported — the
 * corpus models unredacted single-agent runs.
 *
 * One addition beyond the SDK: an optional "Previous headers" section, OFF
 * unless a variant opts in. This is the P1 continuity hypothesis — it lets
 * the harness measure the fix before any SDK field exists.
 */
import type { EvalStep, SerializableValue, ToolEntry } from './types.mts';

const INPUT_CONTEXT_LIMIT = 200;
const MAX_THINKING_EXCERPTS = 4;
const MAX_PROMPT_ENTRIES = 12;
const MAX_PREVIOUS_LABELS = 3;

export function truncateForLabel(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, Math.max(0, maxLength - 1)) + '…';
}

const ABORT_SERIALIZATION = Symbol('abort-label-serialization');

export function serializeForLabel(value: SerializableValue | undefined, limit: number): string {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value.length > limit ? value.slice(0, limit + 1) : value;
  }
  let budget = limit * 4;
  try {
    return (
      JSON.stringify(value, (_key: string, nested: SerializableValue) => {
        if (budget <= 0) {
          throw ABORT_SERIALIZATION;
        }
        if (typeof nested === 'string') {
          const clipped = nested.length > limit ? nested.slice(0, limit) : nested;
          budget -= clipped.length;
          return clipped;
        }
        budget -= 8;
        return nested;
      }) ?? ''
    );
  } catch (error) {
    if (error === ABORT_SERIALIZATION) {
      return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]';
    }
    return String(value);
  }
}

/** `cap` of Infinity models the unbounded-history alternative — testing
 *  whether the whole run's story beats a recency window. */
function previousHeadersSection(
  previousLabels: readonly string[],
  cap = MAX_PREVIOUS_LABELS,
): string | null {
  const kept = previousLabels.filter(Boolean);
  const recent = Number.isFinite(cap) ? kept.slice(-cap) : kept;
  if (recent.length === 0) {
    return null;
  }
  return (
    'Previous headers in this run (most recent last):\n' +
    recent.map((label) => `- ${label}`).join('\n')
  );
}

interface BuildPromptOptions {
  entries: readonly ToolEntry[];
  charLimit: number;
  thinkingExcerpts?: readonly string[];
  lastAssistantText?: string;
  previousLabels?: readonly string[] | null;
  previousLabelCap?: number;
}

export function buildActivityLabelPrompt({
  entries,
  charLimit,
  thinkingExcerpts,
  lastAssistantText,
  previousLabels,
  previousLabelCap,
}: BuildPromptOptions): string {
  const clip = truncateForLabel;
  const sections = [];
  if (previousLabels != null) {
    const section = previousHeadersSection(previousLabels, previousLabelCap);
    if (section != null) {
      sections.push(section);
    }
  }
  if (lastAssistantText != null && lastAssistantText.length > 0) {
    sections.push(
      `Intent (assistant's last message): ${clip(lastAssistantText, INPUT_CONTEXT_LIMIT)}`,
    );
  }
  if (thinkingExcerpts != null && thinkingExcerpts.length > 0) {
    sections.push(
      'Reasoning excerpts:\n' +
        thinkingExcerpts
          .slice(0, MAX_THINKING_EXCERPTS)
          .map((excerpt) => `- ${clip(excerpt, charLimit)}`)
          .join('\n'),
    );
  }
  if (entries.length > 0) {
    const shown = entries.slice(0, MAX_PROMPT_ENTRIES);
    const omitted = entries.length - shown.length;
    sections.push(
      'Tool calls:\n' +
        shown
          .map((entry) => {
            const input = clip(serializeForLabel(entry.toolInput, charLimit), charLimit);
            const outcome =
              entry.status === 'error'
                ? `ERROR: ${clip(entry.error ?? 'unknown error', charLimit)}`
                : clip(serializeForLabel(entry.toolOutput, charLimit), charLimit);
            return `- ${entry.toolName}(${input}) → ${outcome}`;
          })
          .join('\n') +
        (omitted > 0 ? `\n- …and ${omitted} more tool ${omitted === 1 ? 'call' : 'calls'}` : ''),
    );
  }
  sections.push('Label:');
  return sections.join('\n\n');
}

/**
 * Renders a corpus step. Captured steps carry the verbatim production
 * prompt (byte-exact from Langfuse); the continuity section, when a variant
 * opts in, is prepended — the same position the built path gives it.
 */
interface RenderPromptOptions {
  charLimit: number;
  previousLabels: readonly string[] | null;
  previousLabelCap?: number;
}

export function renderStepPrompt(
  step: EvalStep,
  { charLimit, previousLabels, previousLabelCap }: RenderPromptOptions,
): string {
  if (step.verbatim != null) {
    const section =
      previousLabels != null ? previousHeadersSection(previousLabels, previousLabelCap) : null;
    return section != null ? `${section}\n\n${step.verbatim}` : step.verbatim;
  }
  if (step.payload == null) {
    throw new Error('corpus step must define either verbatim or payload');
  }
  return buildActivityLabelPrompt({
    ...step.payload,
    charLimit,
    previousLabels,
    previousLabelCap,
  });
}

export { MAX_PREVIOUS_LABELS };
