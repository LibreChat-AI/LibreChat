import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import supersub from 'remark-supersub';
import type { Pluggable, PluggableList } from 'unified';
import type { HighlightOptions, RehypeModules } from '../../react/parts/rehype';
import { remarkSingleDollarMath } from '../../core/markdown/latex';
import { remarkApproxTilde } from '../../core/markdown/tilde';
import { toRehypePlugins } from '../../react/parts/rehype';

/** `remark-supersub` is typed against the `unified` it was published with and runs unchanged on
 *  this one, so the cast is on its type alone. */
export const remarkSupersub: Pluggable = supersub as unknown as Pluggable;

/** What every surface parses with: approximate tildes kept out of subscripts, sub and
 *  superscript, and GitHub's tables, strikethrough, task lists and autolinks. */
export const BASE_REMARK: PluggableList = [remarkApproxTilde, remarkSupersub, remarkGfm];

/** The base plugins with math in its unambiguous delimiters: `$$`, `\(...\)` and `\[...\]`. */
export const MATH_REMARK: PluggableList = [
  ...BASE_REMARK,
  [remarkMath, { singleDollarTextMath: false }],
];

/**
 * The math and highlighting plugins as `react-markdown` takes them, or none until they have
 * loaded. Both are typed against the `unified` they were published with; this is the one place
 * their list meets the processor that runs them.
 */
export function rehypeList(
  modules: RehypeModules | null,
  highlight?: HighlightOptions,
): PluggableList {
  return toRehypePlugins(modules, highlight) as unknown as PluggableList;
}

/**
 * What a reply parses with: the math list, single-dollar math where the reader has LaTeX parsing
 * on, then the host's own plugins in the order it gives them. `latexParsing` gates only the
 * ambiguous `$...$`; the other delimiters always parse.
 */
export function replyRemark(latexParsing = true, extra: PluggableList = []): PluggableList {
  return [...MATH_REMARK, ...(latexParsing ? [remarkSingleDollarMath] : []), ...extra];
}
