import { useMemo } from 'react';
import { unescapeJsonString } from './parseJsonField';

/**
 * Single-line clamp mirroring the SDK's outcome-label bound
 * (`MAX_OUTCOME_CHARS` in `@librechat/agents`): the label is one progress
 * line in UI chrome rendered with `whitespace-nowrap`, so a verbose or
 * malformed model response must not extend across adjacent controls.
 */
const MAX_INTENT_CHARS = 256;

/**
 * Head window scanned for the label. The gate + a full 256-char label (with
 * escapes) fit comfortably; bounding the scan keeps per-delta work constant
 * even when a tool streams megabytes of `code`/`content` after the intent.
 */
const INTENT_SCAN_CHARS = 2048;

/**
 * Anchored prefix extractor: the label contract puts `intent` FIRST
 * ("ALWAYS write this field FIRST" — that ordering is the entire streaming
 * mechanism), so a single anchored match both gates out a tool's own
 * business parameter that merely shares the name (e.g. a CRM's
 * `{"q":"acme","intent":"billing"}`, which serializes wherever the model
 * put it) and captures the string value, complete or still streaming
 * (tolerating a missing closing quote and a dangling escape). A non-string
 * first-key `intent` (`{"intent":{...}}`) never matches the opening quote,
 * so schema-invalid calls keep their generic label without any JSON.parse.
 */
const INTENT_PREFIX_REGEX = /^\s*\{\s*"intent"\s*:\s*"((?:[^"\\]|\\.)*)(")?/;

export function boundIntentLabel(label: string): string | undefined {
  const singleLine = label.replace(/\s+/g, ' ').trim();
  if (singleLine === '') {
    return undefined;
  }
  if (singleLine.length <= MAX_INTENT_CHARS) {
    return singleLine;
  }
  let head = singleLine.slice(0, MAX_INTENT_CHARS - 1);
  const lastCode = head.charCodeAt(head.length - 1);
  /** Never split a surrogate pair at the cut — a lone high surrogate
   *  renders as a replacement glyph before the ellipsis. */
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    head = head.slice(0, -1);
  }
  return `${head}…`;
}

/**
 * The model-authored `intent` label for a tool call: one sentence, injected
 * as the FIRST property of the tool's schema (SDK-native or host-injected),
 * so it is the first key providers stream in the args — which is what lets
 * a card show it as the call's live status label from the earliest delta,
 * before the rest of the args exist. Returns undefined until any non-empty
 * text has streamed, so callers can fall back to their generic label.
 *
 * Extraction never parses the args buffer: one anchored regex over a
 * bounded head window does the gating and the capture, so per-delta cost
 * stays constant while a large `code`/`content` argument streams behind
 * the label.
 *
 * The label persists unchanged when the call settles: completion is a UI
 * state (the shimmer stopping), not a tense change (see `applyOutcome` in
 * `@librechat/agents` for why there is deliberately no rewrite).
 */
export function getToolCallIntent(args?: string | Record<string, unknown>): string | undefined {
  if (args == null) {
    return undefined;
  }
  if (typeof args === 'object') {
    if (Object.keys(args)[0] !== 'intent') {
      return undefined;
    }
    const value = args.intent;
    return typeof value === 'string' ? boundIntentLabel(value) : undefined;
  }
  const match = INTENT_PREFIX_REGEX.exec(args.slice(0, INTENT_SCAN_CHARS));
  if (!match) {
    return undefined;
  }
  /** A captured closing quote means the value is settled: decode it
   *  without the stream-edge hold-backs, so a value genuinely ending in
   *  a lone high surrogate matches its JSON.parse rendering. */
  return boundIntentLabel(unescapeJsonString(match[1], match[2] !== '"'));
}

export function useToolCallIntent(args?: string | Record<string, unknown>): string | undefined {
  return useMemo(() => getToolCallIntent(args), [args]);
}
