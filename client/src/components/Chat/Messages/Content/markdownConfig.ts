import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkDirective from 'remark-directive';
import { rehypeList, remarkSupersub } from '@librechat/chat/components';
import type { MarkdownBlocksProps } from '@librechat/chat/components';
import type { ElementType } from 'react';
import type { RehypeModules } from './rehype';
import {
  code,
  a,
  p,
  img,
  table,
  ul,
  ol,
  h1,
  h2,
  h3,
  h4,
  h5,
  h6,
  blockquote,
} from './MarkdownComponents';
import {
  mcpUIResourcePlugin,
  MCPUIResource,
  MCPUIResourceCarousel,
} from '~/components/MCPUIResource';
import { Citation, CompositeCitation, HighlightedText } from '~/components/Web/Citation';
import { Artifact, artifactPlugin } from '~/components/Artifacts/Artifact';
import { remarkApproxTilde, remarkSingleDollarMath } from '~/utils';
import { unicodeCitation } from '~/components/Web';

/**
 * Single source of truth for the markdown rendering pipeline, shared by the
 * whole-message renderer and the per-block memoized renderer so both produce
 * identical output.
 *
 * These are exposed as lazily-initialized getters rather than top-level
 * consts on purpose: MarkdownComponents participates in a circular import
 * (MarkdownComponents -> CodeBlock -> Parts -> Markdown -> here ->
 * MarkdownComponents). Reading code/a/... at module-evaluation time throws
 * Cannot access 'code' before initialization under native ESM. Deferring the
 * read to call time (when components render or memoize) sidesteps the
 * temporal dead zone.
 */
/**
 * `latexParsing` (the user setting) gates only the ambiguous single-dollar syntax; the
 * unambiguous `$$`, `\(...\)`, and `\[...\]` delimiters always parse via `remark-math`
 * (aliased to `micromark-extension-llm-math` in vite and jest config).
 */
type Plugins = MarkdownBlocksProps['remarkPlugins'];

/** The artifact plugin is typed against the `unified` this app resolves, which is older than the
 *  one `react-markdown` runs it on, so the cast is on its type alone. */
const artifacts = artifactPlugin as unknown as Plugins[number];

export const getRemarkPlugins = (latexParsing = true): Plugins => [
  remarkApproxTilde,
  remarkSupersub,
  remarkGfm,
  remarkDirective,
  artifacts,
  [remarkMath, { singleDollarTextMath: false }],
  ...(latexParsing ? [remarkSingleDollarMath] : []),
  unicodeCitation,
  mcpUIResourcePlugin,
];

/** Empty until `useRehypeModules` has loaded KaTeX and highlight.js; see `./rehype`. */
export const getRehypePlugins = (modules: RehypeModules | null): Plugins => rehypeList(modules);

export const getMarkdownComponents = (): { [nodeType: string]: ElementType } => ({
  code,
  a,
  p,
  img,
  table,
  ul,
  ol,
  h1,
  h2,
  h3,
  h4,
  h5,
  h6,
  blockquote,
  artifact: Artifact,
  citation: Citation,
  'highlighted-text': HighlightedText,
  'composite-citation': CompositeCitation,
  'mcp-ui-resource': MCPUIResource,
  'mcp-ui-carousel': MCPUIResourceCarousel,
});
