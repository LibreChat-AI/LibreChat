import { memo, useRef, Fragment, useLayoutEffect } from 'react';
import type { Root, Element, ElementContent } from 'hast';
import type { CSSProperties } from 'react';
import type { Plugin } from 'unified';

/** Must match the animation duration on `[data-lc-fade]` in style.css */
export const FADE_DURATION_MS = 250;
export const FADE_STAGGER_MS = 25;
export const FADE_STAGGER_MAX_MS = 250;
/**
 * Text already longer than this when animation starts is hydrated/resumed
 * content (reconnected stream, conversation switch, follow-up turn), not a
 * fresh delta — that content becomes the baseline instead of re-fading. The
 * markdown path evaluates this against the whole message when its `animate`
 * gate flips on; `AnimatedText` evaluates it against its own first text.
 */
export const FADE_HYDRATION_THRESHOLD = 120;

type FadeEntry = { at: number; delay: number };

type PendingRun = {
  prevCount: number;
  additions: Map<number, FadeEntry>;
  now: number;
};

export type FadeState = {
  /** Total characters classified during the last committed run; parts below this offset are not new */
  prevCount: number;
  /** Parts still mid-animation, keyed by start offset, so re-renders replay identical props */
  active: Map<number, FadeEntry>;
  /** True until the first run commits; used for the hydration baseline decision */
  firstRun: boolean;
  /** Staged result of the latest render, published to the fields above on commit */
  pending: PendingRun | null;
};

type FadeRun = {
  state: FadeState;
  now: number;
  count: number;
  newIndex: number;
  /** Baseline mode: classify everything as already seen (hydrated first run) */
  suppress: boolean;
  additions: Map<number, FadeEntry>;
};

export type FadeSegment = {
  start: number;
  value: string;
  animated: boolean;
  delay: number;
};

const WORD_REGEX = /\S+\s*/g;
const NON_WHITESPACE_REGEX = /\S/;
/**
 * Scripts written without word-delimiting spaces: Thai, Lao, Myanmar, Khmer,
 * Tibetan, CJK ideographs/kana, Hangul, and CJK compatibility ideographs.
 * Whitespace splitting yields one ever-growing part for these, which would
 * stop fading once its window expires, so they go through Intl.Segmenter.
 */
const SPACELESS_REGEX =
  /[\u0E00-\u0EFF\u0F00-\u0FFF\u1000-\u109F\u1780-\u17FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;

let wordSegmenter: Intl.Segmenter | null | undefined;
let graphemeSegmenter: Intl.Segmenter | null | undefined;

function createSegmenter(granularity: 'word' | 'grapheme'): Intl.Segmenter | null {
  return typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity })
    : null;
}

function getWordSegmenter(): Intl.Segmenter | null {
  if (wordSegmenter === undefined) {
    wordSegmenter = createSegmenter('word');
  }
  return wordSegmenter;
}

function getGraphemeSegmenter(): Intl.Segmenter | null {
  if (graphemeSegmenter === undefined) {
    graphemeSegmenter = createSegmenter('grapheme');
  }
  return graphemeSegmenter;
}

function pushSegmentedParts(parts: string[], token: string): void {
  const segmenter = getWordSegmenter();
  if (segmenter == null) {
    parts.push(token);
    return;
  }
  const trailing = /\s+$/.exec(token);
  const word = trailing == null ? token : token.slice(0, trailing.index);
  for (const segment of segmenter.segment(word)) {
    parts.push(segment.segment);
  }
  if (trailing != null) {
    parts.push(trailing[0]);
  }
}

/**
 * Splits text into word parts, each a non-whitespace run plus its trailing
 * whitespace, with whitespace-only runs kept as separate parts. Scripts
 * without word-delimiting spaces (CJK) are further split via Intl.Segmenter.
 * Concatenating the result always reproduces the input exactly.
 */
export function splitWords(value: string): string[] {
  const parts: string[] = [];
  WORD_REGEX.lastIndex = 0;
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_REGEX.exec(value)) !== null) {
    if (match.index > index) {
      parts.push(value.slice(index, match.index));
    }
    const token = match[0];
    if (SPACELESS_REGEX.test(token)) {
      pushSegmentedParts(parts, token);
    } else {
      parts.push(token);
    }
    index = match.index + token.length;
  }
  if (index < value.length) {
    parts.push(value.slice(index));
  }
  return parts;
}

export function createFadeState(): FadeState {
  return { prevCount: 0, active: new Map(), firstRun: true, pending: null };
}

export function beginRun(state: FadeState, suppress = false): FadeRun {
  return {
    state,
    now: performance.now(),
    count: 0,
    newIndex: 0,
    suppress,
    additions: new Map(),
  };
}

/**
 * Stages the run's result on the state without publishing it. Classification
 * never mutates committed state during render, so a render that React
 * abandons (concurrent interruption, StrictMode double-render) leaves no
 * trace; only {@link commitRun} — called after the render commits — publishes.
 */
export function stageRun(run: FadeRun): void {
  run.state.pending = { prevCount: run.count, additions: run.additions, now: run.now };
}

/** Publishes the staged run: baseline offset, new animations, pruned entries. */
export function commitRun(state: FadeState): void {
  const pending = state.pending;
  if (pending == null) {
    return;
  }
  state.pending = null;
  state.firstRun = false;
  state.prevCount = pending.prevCount;
  for (const [start, entry] of pending.additions) {
    state.active.set(start, entry);
  }
  for (const [start, entry] of state.active) {
    if (pending.now - entry.at >= entry.delay + FADE_DURATION_MS) {
      state.active.delete(start);
    }
  }
}

/** Stages and immediately commits — for callers without a commit phase. */
export function endRun(run: FadeRun): void {
  stageRun(run);
  commitRun(run.state);
}

/**
 * Classifies one text value into fade segments, advancing the run's
 * document-order character offset. A part is animated when it starts past the
 * last committed run's total offset (newly streamed) or when it is still
 * within its animation window from an earlier run — in which case it replays
 * identical animation props so React leaves the in-flight CSS animation
 * untouched. Committed state is only read here; new animations are recorded
 * on the run and published by {@link commitRun}.
 */
export function classifyValue(run: FadeRun, value: string): FadeSegment[] {
  const { state, now } = run;
  const segments: FadeSegment[] = [];
  for (const part of splitWords(value)) {
    const start = run.count;
    run.count += part.length;
    if (run.suppress || !NON_WHITESPACE_REGEX.test(part)) {
      segments.push({ start, value: part, animated: false, delay: 0 });
      continue;
    }
    if (start >= state.prevCount) {
      const staged = run.additions.get(start);
      const delay = staged?.delay ?? Math.min(run.newIndex * FADE_STAGGER_MS, FADE_STAGGER_MAX_MS);
      run.newIndex += 1;
      run.additions.set(start, staged ?? { at: now, delay });
      segments.push({ start, value: part, animated: true, delay });
      continue;
    }
    const entry = state.active.get(start);
    if (entry != null && now - entry.at < entry.delay + FADE_DURATION_MS) {
      segments.push({ start, value: part, animated: true, delay: entry.delay });
      continue;
    }
    segments.push({ start, value: part, animated: false, delay: 0 });
  }
  return segments;
}

const SKIP_TAGS = new Set([
  'code',
  'pre',
  'svg',
  'math',
  'annotation',
  'script',
  'style',
  'artifact',
  'citation',
  'composite-citation',
  'highlighted-text',
  'mcp-ui-resource',
  'mcp-ui-carousel',
]);

function isSkippedElement(node: Element): boolean {
  if (SKIP_TAGS.has(node.tagName)) {
    return true;
  }
  const className = node.properties?.className;
  if (Array.isArray(className)) {
    return className.some((name) => typeof name === 'string' && name.startsWith('katex'));
  }
  return typeof className === 'string' && className.startsWith('katex');
}

function toContent(segment: FadeSegment): ElementContent {
  if (!NON_WHITESPACE_REGEX.test(segment.value)) {
    return { type: 'text', value: segment.value };
  }
  const properties: Element['properties'] = {};
  if (segment.animated) {
    properties.dataLcFade = '';
    if (segment.delay > 0) {
      properties.style = `--lc-delay:${segment.delay}ms`;
    }
  }
  return {
    type: 'element',
    tagName: 'span',
    properties,
    children: [{ type: 'text', value: segment.value }],
  };
}

function transformElement(run: FadeRun, element: Element): void {
  const next: ElementContent[] = [];
  for (const child of element.children) {
    if (child.type === 'text') {
      for (const segment of classifyValue(run, child.value)) {
        next.push(toContent(segment));
      }
      continue;
    }
    if (child.type === 'element' && !isSkippedElement(child)) {
      transformElement(run, child);
    }
    next.push(child);
  }
  element.children = next;
}

export type FadePlugin = {
  plugin: Plugin<[], Root>;
  /** Publish the latest render's staged classification; call after React commits. */
  commit: () => void;
};

/**
 * Creates a per-renderer rehype plugin that wraps newly streamed words in
 * one-shot CSS fade spans (`[data-lc-fade]`). New-text detection uses
 * document-order character offsets held in the factory closure, so text that
 * was already visible in a previous render mounts as a bare span and never
 * re-animates, even when markdown re-parsing restructures the tree. Pass
 * `hydrated: true` for renderers created while previously accumulated content
 * is already showing (resumed stream, conversation switch, follow-up turn):
 * their first run becomes the baseline without animating. Classification is
 * staged during render and must be published via `commit()` after React
 * commits (a layout effect), so abandoned renders leave no trace. Create one
 * instance per streaming renderer and drop it (plain plugin array) once the
 * stream ends so the settled message renders without wrapper spans.
 */
export function createFadePlugin(hydrated = false): FadePlugin {
  const state = createFadeState();
  const plugin: Plugin<[], Root> = function rehypeFade() {
    return (tree: Root) => {
      const run = beginRun(state, hydrated && state.firstRun);
      for (const child of tree.children) {
        if (child.type === 'element' && !isSkippedElement(child)) {
          transformElement(run, child);
        }
      }
      stageRun(run);
    };
  };
  return { plugin, commit: () => commitRun(state) };
}

const DELAY_VAR = '--lc-delay';
const WHITESPACE_REGEX = /\s/;
const PREFIX_PROBE_LENGTH = 32;
/**
 * Longest trailing run kept unsettled. Bounds per-token work when the last
 * word never reaches whitespace (CJK, Thai, unspaced Hangul, URLs). Only
 * settled, non-animated text is cut, and it renders as plain text on both
 * sides of the cut, so a cut inside a part is invisible.
 */
const MAX_UNSETTLED_LENGTH = 64;
/**
 * Moves a cut offset in `tail` back to a grapheme-cluster boundary, so emoji
 * modifier, flag, ZWJ and combining sequences stay whole. `tail` starts at the
 * committed settled boundary, which is itself a cluster boundary, and is
 * bounded by the cap, so segmenting it stays proportional to the unsettled text.
 * Without a grapheme segmenter there is no safe cut, so the cap is not applied.
 */
function glyphBoundary(tail: string, index: number): number {
  const segmenter = getGraphemeSegmenter();
  if (index <= 0 || segmenter == null) {
    return 0;
  }
  let boundary = 0;
  for (const segment of segmenter.segment(tail)) {
    if (segment.index > index) {
      break;
    }
    boundary = segment.index;
  }
  return boundary;
}

/** Offset of the last whitespace-delimited word, which appended text can still extend. */
function lastWordStart(value: string): number {
  let index = value.length;
  while (index > 0 && WHITESPACE_REGEX.test(value[index - 1])) {
    index -= 1;
  }
  while (index > 0 && !WHITESPACE_REGEX.test(value[index - 1])) {
    index -= 1;
  }
  return index;
}

/**
 * Whether `text` still extends the settled `prefix`. Probes only the prefix's
 * head and the region at its boundary so the per-token check stays constant
 * rather than rescanning the whole accumulated prefix; an append-only stream
 * always passes, and a rewrite that shifts or replaces text fails a probe. The
 * settled region is always rendered from the current text, so a rewrite that
 * slips past the probes can only affect fade timing, never the characters shown.
 */
function extendsPrefix(text: string, prefix: string): boolean {
  if (text.length < prefix.length) {
    return false;
  }
  const probe = Math.min(PREFIX_PROBE_LENGTH, prefix.length);
  const boundary = prefix.length - probe;
  return (
    text.startsWith(prefix.slice(0, probe)) && text.startsWith(prefix.slice(boundary), boundary)
  );
}

/**
 * Plain-text counterpart of the rehype plugin for non-markdown streamed text
 * (reasoning). Renders words in fade spans keyed by character offset; only
 * render this while the text is actively streaming and render the raw string
 * once settled. Classification is append-only: the leading run of parts that
 * finished fading collapses into a single committed text node and is never
 * re-split, so each streamed token costs work proportional to the unsettled
 * tail rather than the accumulated text. The settled boundary never passes a
 * word that is still fading, and stops before the last word (which appended
 * text can still extend) unless that word outgrows MAX_UNSETTLED_LENGTH.
 */
export const AnimatedText = memo(function AnimatedText({ text }: { text: string }) {
  const stateRef = useRef<FadeState | null>(null);
  const settledRef = useRef('');
  if (stateRef.current == null) {
    stateRef.current = createFadeState();
  }
  const state = stateRef.current;
  const settledLength = extendsPrefix(text, settledRef.current) ? settledRef.current.length : 0;
  const settled = text.slice(0, settledLength);
  const tail = text.slice(settledLength);
  const suppress = state.firstRun && text.length > FADE_HYDRATION_THRESHOLD;
  const run = beginRun(state, suppress);
  run.count = settledLength;
  const segments = classifyValue(run, tail);
  stageRun(run);

  const limit = Math.max(
    settledLength + lastWordStart(tail),
    settledLength + glyphBoundary(tail, tail.length - MAX_UNSETTLED_LENGTH),
  );
  const firstAnimated = segments.find((segment) => segment.animated);
  const nextSettledLength = Math.min(limit, firstAnimated?.start ?? limit);

  useLayoutEffect(() => {
    commitRun(state);
    settledRef.current = text.slice(0, nextSettledLength);
  });

  return (
    <>
      {settled}
      {segments.map((segment) => {
        if (!segment.animated) {
          return <Fragment key={segment.start}>{segment.value}</Fragment>;
        }
        const style =
          segment.delay > 0 ? ({ [DELAY_VAR]: `${segment.delay}ms` } as CSSProperties) : undefined;
        return (
          <span key={segment.start} data-lc-fade="" style={style}>
            {segment.value}
          </span>
        );
      })}
    </>
  );
});
AnimatedText.displayName = 'AnimatedText';
