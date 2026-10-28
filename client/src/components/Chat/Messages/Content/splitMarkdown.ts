import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { directive } from 'micromark-extension-directive';
import { directiveFromMarkdown } from 'mdast-util-directive';

export type MarkdownBlock = {
  /** Exact source slice for this top-level block. */
  raw: string;
  /** Executable code blocks within this block (those that render a runnable CodeBlock). */
  codeBlockCount: number;
  /** Artifact containers within this block. */
  artifactCount: number;
  /** Mermaid fences within this block, which carry their own index sequence. */
  mermaidCount: number;
};

type MdastNode = {
  type: string;
  name?: string;
  lang?: string | null;
  value?: string;
  children?: MdastNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};

/**
 * Mirror the `code` component's decision for whether a fenced block renders as a
 * runnable CodeBlock (and therefore consumes a block index). Every fenced code
 * block does, except `math` and `mermaid` fences, which have dedicated
 * renderers. mdast strips a fenced block's trailing newline, but
 * react-markdown/remark-rehype re-add it, so the `code` component never treats a
 * fenced block as single-line inline code regardless of its language — only true
 * inline code (an `inlineCode` node, not counted here) is.
 */
const renderedCodeLang = (lang: string): string =>
  /language-(\w+)/.exec(`language-${lang}`)?.[1] ?? '';

/**
 * Normalize the fence info string the same way the `code` component does — it
 * reads the language from `className` via `/language-(\w+)/`, so only the leading
 * word characters survive (`mermaid-js` → `mermaid`, `math-tex` → `math`). A
 * fence is executable (consumes a CodeBlock index) unless it normalizes to
 * `math` or `mermaid`, which have dedicated renderers.
 */
const isExecutableCode = (lang: string): boolean => {
  const normalized = renderedCodeLang(lang);
  return normalized !== 'math' && normalized !== 'mermaid';
};

const containsDefinition = (node: MdastNode): boolean => {
  if (node.type === 'definition' || node.type === 'footnoteDefinition') {
    return true;
  }
  return (node.children ?? []).some(containsDefinition);
};

const ARTIFACT_DIRECTIVE_TYPES = new Set(['containerDirective', 'leafDirective']);

const countWithin = (
  node: MdastNode,
  counts: { code: number; artifact: number; mermaid: number },
): void => {
  if (ARTIFACT_DIRECTIVE_TYPES.has(node.type) && node.name === 'artifact') {
    // artifactPlugin renders container (`:::artifact:::`) and leaf
    // (`::artifact{}`) artifact directives as an Artifact, each consuming one
    // index; their children never render as executable code blocks, so stop
    // descending. Inline text directives (`:artifact{}`) are intentionally
    // excluded — the plugin rewrites every textDirective to literal text, so no
    // Artifact renders and no index is consumed.
    counts.artifact += 1;
    return;
  }
  if (node.type === 'code') {
    if (isExecutableCode(node.lang ?? '')) {
      counts.code += 1;
    } else if (renderedCodeLang(node.lang ?? '') === 'mermaid') {
      counts.mermaid += 1;
    }
  }
  if (node.children) {
    for (const child of node.children) {
      countWithin(child, counts);
    }
  }
};

/**
 * Parse markdown into an mdast tree using the same structural constructs the
 * render pipeline relies on (GFM tables, container directives like
 * `:::artifact:::`, and `$$` math), so top-level block boundaries match what
 * react-markdown produces. Inline-only transforms (citations, MCP-UI markers,
 * supersub, single-dollar math) never cross a top-level block, so they are
 * intentionally omitted.
 */
const parseToMdast = (content: string): MdastNode =>
  fromMarkdown(content, {
    extensions: [gfm(), directive(), math({ singleDollarTextMath: false })],
    mdastExtensions: [gfmFromMarkdown(), directiveFromMarkdown(), mathFromMarkdown()],
  }) as MdastNode;

type SplitResult = {
  blocks: MarkdownBlock[];
  /** Offset where the final two blocks start; the last boundary may still disappear. */
  reparseStart: number;
  /** Number of blocks before reparseStart, even after the tail merges into one block. */
  stableBlockCount: number;
};

/** The parsed top-level nodes, returned when the text cannot be split. */
type WholeMessage = { children: MdastNode[] };

const isSplit = (result: SplitResult | WholeMessage): result is SplitResult => 'blocks' in result;

/**
 * Where the line holding a top-level block begins, when only indentation precedes
 * the block on it. mdast starts a node after its indentation, but that indentation
 * carries meaning: it is stripped from an indented fence's code lines, and it
 * decides which list item a later indented line belongs to. A block parsed on its
 * own has to keep it to parse the way it does inside the whole message.
 */
const lineStartOf = (content: string, offset: number): number => {
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*$/.test(content.slice(lineStart, offset)) ? lineStart : offset;
};

/**
 * Parse `text` and split it into per-node blocks. Returns the parsed nodes
 * instead when the text cannot be rendered block-by-block and must instead
 * render as one whole:
 *  - reference/footnote definitions are document-scoped (and may be nested in
 *    a blockquote or list item), so a reference would otherwise render as
 *    literal text once severed from its definition;
 *  - top-level raw HTML blocks are escaped to text (rehypeRaw is not enabled),
 *    so the separator between adjacent HTML blocks would otherwise be dropped.
 */
const splitBlocks = (text: string): SplitResult | WholeMessage => {
  const children = parseToMdast(text).children ?? [];
  if (children.length === 0) {
    return { children };
  }

  const blocks: MarkdownBlock[] = [];
  const stableBlockCount = Math.max(0, children.length - 2);
  let reparseStart = 0;

  for (const node of children) {
    if (node.type === 'html' || containsDefinition(node)) {
      return { children };
    }
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (start == null || end == null) {
      return { children };
    }
    const counts = { code: 0, artifact: 0, mermaid: 0 };
    countWithin(node, counts);
    const rawStart = lineStartOf(text, start);
    if (blocks.length === stableBlockCount) {
      reparseStart = rawStart;
    }
    blocks.push({
      raw: text.slice(rawStart, end),
      codeBlockCount: counts.code,
      artifactCount: counts.artifact,
      mermaidCount: counts.mermaid,
    });
  }

  return { blocks, reparseStart, stableBlockCount };
};

/**
 * Split a markdown string into its top-level blocks by parsing it in full,
 * returning the exact source slice for each block plus the index counts it
 * consumes. Prefer `splitMarkdownIntoBlocks`, which reuses the previous split
 * when the content only grew.
 *
 * Inter-block whitespace (blank lines) is not part of any node's span and is
 * dropped; block-level elements carry their own margins, so rendering each
 * slice independently is visually equivalent to rendering the whole string.
 */
export function splitMarkdownIntoBlocksUncached(content: string): MarkdownBlock[] {
  if (!content) {
    return [];
  }
  const split = splitBlocks(content);
  return isSplit(split) ? split.blocks : [{ raw: content, ...blockCounts(split.children) }];
}

type SplitCache = SplitResult & { content: string };

export type MarkdownSplitter = (content: string) => MarkdownBlock[];

/**
 * Create an isolated splitter cache for one markdown surface. MarkdownBlocks
 * keeps one instance per mounted message so concurrent streams cannot evict
 * one another's active tail. The tail includes the preceding block because an
 * unfinished marker (such as `***` or `#`) can stop interrupting it when more
 * text arrives. Reusing that block before the boundary settles loses paragraph
 * and lazy list/blockquote continuations.
 */
export function createMarkdownSplitter(): MarkdownSplitter {
  let lastSplit: SplitCache | null = null;

  return (content: string): MarkdownBlock[] => {
    if (!content) {
      lastSplit = null;
      return [];
    }

    const prev = lastSplit;
    if (prev != null && content.length > prev.content.length && content.startsWith(prev.content)) {
      const tail = splitBlocks(content.slice(prev.reparseStart));
      if (isSplit(tail)) {
        lastSplit = {
          content,
          blocks: [...prev.blocks.slice(0, prev.stableBlockCount), ...tail.blocks],
          reparseStart: prev.reparseStart + tail.reparseStart,
          stableBlockCount: prev.stableBlockCount + tail.stableBlockCount,
        };
        return lastSplit.blocks;
      }
    }

    const split = splitBlocks(content);
    if (!isSplit(split)) {
      lastSplit = null;
      return [{ raw: content, ...blockCounts(split.children) }];
    }
    lastSplit = { content, ...split };
    return split.blocks;
  };
}

export const splitMarkdownIntoBlocks = createMarkdownSplitter();

const blockCounts = (
  children: MdastNode[],
): { codeBlockCount: number; artifactCount: number; mermaidCount: number } => {
  const counts = { code: 0, artifact: 0, mermaid: 0 };
  for (const node of children) {
    countWithin(node, counts);
  }
  return {
    codeBlockCount: counts.code,
    artifactCount: counts.artifact,
    mermaidCount: counts.mermaid,
  };
};
