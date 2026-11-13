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
      /* A later render retries; until then the text renders without math or highlighting. */
      pending = null;
      throw error;
    });
  return pending;
}

/** Already loaded, for render paths that cannot wait (the error boundary's fallback). */
export const getLoadedRehypeModules = (): RehypeModules | null => loaded;

/**
 * Math needs a remark-math delimiter, and highlighting needs a code block: fenced, or indented
 * for the renderers that auto-detect the language. Anything else passes through both untouched.
 */
const NEEDS_REHYPE = /\$|\\\(|\\\[|```|~~~|^[ \t>]*?(?: {4}|\t)/m;

export const needsRehype = (text: string): boolean => NEEDS_REHYPE.test(text);

/**
 * The math and highlighting plugins, or null until they have loaded. `text` decides whether this
 * render starts the load: text with nothing for them to transform never does. Without them the output is identical except that math and
 * fenced code are unformatted, so callers render immediately and upgrade when this resolves.
 */
export function useRehypeModules(text: string): RehypeModules | null {
  const needed = needsRehype(text);
  const [modules, setModules] = useState<RehypeModules | null>(loaded);

  useEffect(() => {
    if (!needed || modules != null) {
      return;
    }
    let active = true;
    loadRehypeModules().then(
      (result) => active && setModules(result),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [needed, modules]);

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
