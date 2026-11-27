import { useEffect, useState } from 'react';
import type { Plugin, PluggableList } from 'unified';
import { importWithRecovery } from '~/lib/assets/lazy';
import { langSubset } from '~/utils/languages';

export type RehypeModules = {
  rehypeKatex: Plugin;
  rehypeHighlight: Plugin;
};

/**
 * KaTeX and highlight.js are a large share of the markdown pipeline, and they act only on math
 * and fenced code. Loading them on first need keeps them out of the boot bundle, so the welcome
 * screen and plain-text conversations never download them.
 */
let loaded: RehypeModules | null = null;
let pending: Promise<RehypeModules> | null = null;

export function loadRehypeModules(): Promise<RehypeModules> {
  pending ??= importWithRecovery(() =>
    Promise.all([
      import('rehype-katex'),
      import('rehype-highlight'),
      import('katex/contrib/mhchem'),
      import('katex/dist/katex.min.css'),
      import('katex/dist/contrib/copy-tex.js'),
    ]),
  )
    .then(([katex, highlight]) => {
      loaded = {
        rehypeKatex: katex.default as Plugin,
        rehypeHighlight: highlight.default as Plugin,
      };
      return loaded;
    })
    .catch((error: unknown) => {
      /* `useRehypeModules` retries; until then the text renders without math or highlighting. */
      pending = null;
      throw error;
    });
  return pending;
}

/** Already loaded, for render paths that cannot wait (the error boundary's fallback). */
export const getLoadedRehypeModules = (): RehypeModules | null => loaded;

/**
 * Math needs a remark-math delimiter, and a message highlights only a fence that names its
 * language. Anything else passes through both plugins untouched. Indented and unlabeled code is
 * not detected here: the renderers that guess its language load the plugins regardless.
 */
const NEEDS_REHYPE = /\$|\\\(|\\\[|```|~~~/;

export const needsRehype = (text: string): boolean => NEEDS_REHYPE.test(text);

/** Attempts after a failed load, spaced 1s, 2s, 4s apart, before waiting for a remount. */
const MAX_LOAD_RETRIES = 3;

/**
 * The math and highlighting plugins, or null until they have loaded. `text` decides whether this
 * render starts the load: text with nothing for them to transform never does. Renderers that
 * guess the language (`DETECT_HIGHLIGHT`) highlight any code block, including indented ones
 * nested in lists or quotes that no cheap check finds reliably, so they pass `detectsLanguage`
 * and always load. Without the plugins the output is identical except that math and code are
 * unformatted, so callers render immediately and upgrade when this resolves.
 */
export function useRehypeModules(text: string, detectsLanguage = false): RehypeModules | null {
  const needed = detectsLanguage || needsRehype(text);
  const [modules, setModules] = useState<RehypeModules | null>(loaded);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!needed || modules != null || attempt > MAX_LOAD_RETRIES) {
      return;
    }
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    loadRehypeModules().then(
      (result) => active && setModules(result),
      () => {
        if (active) {
          retry = setTimeout(() => setAttempt((count) => count + 1), 1000 * 2 ** attempt);
        }
      },
    );
    return () => {
      active = false;
      clearTimeout(retry);
    };
  }, [needed, modules, attempt]);

  /* Detection only decides whether to fetch: once loaded, every renderer gets the plugins, so a
     pattern the check misses can never strip formatting the text would otherwise get. */
  return modules ?? loaded;
}

/** Chat messages: a language is highlighted only when the fence names it. */
export const MESSAGE_HIGHLIGHT = { detect: false, ignoreMissing: true, subset: langSubset };
/** Prompt cards highlight with highlight.js defaults. */
export const PROMPT_HIGHLIGHT = { ignoreMissing: true };
/** Prompt and skill previews guess the language of unlabeled blocks. */
export const DETECT_HIGHLIGHT = { detect: true, ignoreMissing: true, subset: langSubset };

export function toRehypePlugins(
  modules: RehypeModules | null,
  highlight: Record<string, unknown> = MESSAGE_HIGHLIGHT,
): PluggableList {
  if (modules == null) {
    return [];
  }
  return [[modules.rehypeKatex], [modules.rehypeHighlight, highlight]];
}
