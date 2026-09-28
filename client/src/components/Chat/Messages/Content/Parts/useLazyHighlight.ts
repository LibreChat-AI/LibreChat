import React, { useState, useEffect, useRef } from 'react';

/** Minimum gap between highlights while the input keeps changing (streaming). */
export const HIGHLIGHT_THROTTLE_MS = 300;
export const CodeHighlightThrottleContext = React.createContext(HIGHLIGHT_THROTTLE_MS);

export function normalizeCodeHighlightThrottleMs(value: unknown): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 60000
    ? value
    : HIGHLIGHT_THROTTLE_MS;
}

interface HastText {
  type: 'text';
  value: string;
}

interface HastElement {
  type: 'element';
  tagName: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}

type HastNode = HastText | HastElement;

function hastToReact(nodes: HastNode[]): React.ReactNode[] {
  return nodes.map((node, i) => {
    if (node.type === 'text') {
      return node.value;
    }
    return React.createElement(
      node.tagName,
      { key: i, className: node.properties?.className?.join(' ') },
      node.children ? hastToReact(node.children) : undefined,
    );
  });
}

type LowlightModule = typeof import('lowlight');

let lowlightPromise: Promise<LowlightModule> | null = null;
let lowlightModule: LowlightModule | null = null;

function loadLowlight(): Promise<LowlightModule> {
  if (lowlightModule) {
    return Promise.resolve(lowlightModule);
  }
  if (!lowlightPromise) {
    lowlightPromise = import('lowlight').then((mod) => {
      lowlightModule = mod;
      return mod;
    });
  }
  return lowlightPromise;
}

function highlightCode(mod: LowlightModule, code: string, lang: string): React.ReactNode[] {
  if (lang === 'plaintext') {
    return [code];
  }
  try {
    const tree = mod.lowlight.registered(lang)
      ? mod.lowlight.highlight(lang, code)
      : mod.lowlight.highlightAuto(code);
    return hastToReact(tree.children as HastNode[]);
  } catch {
    return [code];
  }
}

/** The tokens held, with the input they were produced from. Nothing to show is the empty key,
 *  so a hook mounted without code still recognizes the first code it receives as new. */
type HighlightState = { key: string; nodes: React.ReactNode[] | null };

const highlightKey = (code: string | undefined, lang: string): string =>
  code ? `${lang}\0${code}` : '';

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now());

/**
 * Tokens for a block of code, once the grammars have loaded.
 *
 * Highlighting runs when the input changes, and once per input: the key the tokens were produced
 * from is tracked, so a mount that could highlight immediately is not repeated by the effect that
 * follows it. While the input keeps changing, as it does for a streaming tool call, highlights are
 * throttled to one per `CodeHighlightThrottleContext` interval and the caller is handed its raw
 * text in between, so a long code block stays readable without tokenizing every delta. Grammars
 * load on first use, so a caller renders its own raw text until this returns; passing `undefined`
 * while a pane is closed keeps a collapsed card from tokenizing output nobody is reading.
 */
export default function useLazyHighlight(
  code: string | undefined,
  lang: string,
): React.ReactNode[] | null {
  const throttleMs = React.useContext(CodeHighlightThrottleContext);
  const currentKey = highlightKey(code, lang);
  const hasInitialHighlight = Boolean(code && lowlightModule);
  const [highlighted, setHighlighted] = useState<HighlightState | null>(() =>
    hasInitialHighlight
      ? { key: currentKey, nodes: highlightCode(lowlightModule!, code!, lang) }
      : null,
  );
  /** The input the tokens held were produced from, or that a pending run will produce. */
  const scheduledKey = useRef(hasInitialHighlight ? currentKey : '');
  const prevThrottleMs = useRef<number | null>(hasInitialHighlight ? throttleMs : null);
  const lastRunAt = useRef<number | null>(hasInitialHighlight ? now() : null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const key = highlightKey(code, lang);
    const keyChanged = key !== scheduledKey.current;
    const throttleChanged = throttleMs !== prevThrottleMs.current;
    if (!keyChanged && !throttleChanged) {
      return;
    }
    scheduledKey.current = key;
    prevThrottleMs.current = throttleMs;
    /** A new cadence only reschedules a waiting timer. Work already started
     *  for this same input may finish, and completed tokens need no new pass. */
    if (!keyChanged && timer.current === null) {
      return;
    }
    generation.current += 1;
    if (keyChanged) {
      setHighlighted(null);
    }

    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }

    if (!code) {
      lastRunAt.current = null;
      return;
    }

    if (lang === 'plaintext') {
      setHighlighted({ key, nodes: [code] });
      return;
    }

    const run = () => {
      timer.current = null;
      lastRunAt.current = now();
      const gen = ++generation.current;

      if (lowlightModule) {
        setHighlighted({ key, nodes: highlightCode(lowlightModule, code, lang) });
        return;
      }

      loadLowlight()
        .then((mod) => {
          if (gen === generation.current) {
            setHighlighted({ key, nodes: highlightCode(mod, code, lang) });
          }
        })
        .catch(() => {
          if (gen === generation.current) {
            setHighlighted({ key, nodes: [code] });
          }
        });
    };

    /** A clock that jumped backwards would otherwise hold the next highlight for a full window. */
    const elapsed = lastRunAt.current === null ? throttleMs : now() - lastRunAt.current;
    const wait = throttleMs - elapsed;
    if (wait <= 0) {
      run();
    } else {
      timer.current = setTimeout(run, wait);
    }
  }, [code, lang, throttleMs]);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
      scheduledKey.current = '';
      prevThrottleMs.current = null;
      generation.current += 1;
    },
    [],
  );

  if (highlighted && highlighted.key === currentKey) {
    return highlighted.nodes;
  }
  return code ? [code] : null;
}
