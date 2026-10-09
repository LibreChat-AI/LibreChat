import { visit, SKIP } from 'unist-util-visit';
import { VISUAL_DIRECTIVE } from 'librechat-data-provider';
import type { Pluggable } from 'unified';
import { visualParts } from '~/utils/visual';

type VisualNode = {
  type: string;
  name?: string;
  value?: string;
  attributes?: Record<string, string | null | undefined> | null;
  children?: VisualNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  data?: Record<string, unknown>;
};

/** A line holding only the colons that close a container directive. */
const CLOSING_FENCE = /^[ \t]*:{3,}[ \t]*$/;

/**
 * Whether the container has closed. An unclosed container runs to the end of the source while it
 * streams, so the closing fence is what says the page is whole; only the last line is read, since
 * this runs on every streamed update.
 */
export function isVisualClosed(node: VisualNode, source: string): boolean {
  const start = node.position?.start?.offset ?? 0;
  let end = node.position?.end?.offset ?? start;
  while (end > start && /\s/.test(source[end - 1])) {
    end--;
  }
  const lastLine = source.lastIndexOf('\n', end - 1);
  return lastLine > start && CLOSING_FENCE.test(source.slice(lastLine + 1, end));
}

/**
 * Renders a `:::visual{title="…"}` container around an html fence as a `visual` element carrying
 * the page as a property. The fence is never highlighted or rendered as a code block, and anything
 * around it moves out to sit around the visual; `splitMarkdown` counts the container the same way.
 */
export const visualPlugin: Pluggable = () => {
  return (tree, file) => {
    const source = String(file.value ?? '');
    visit(tree, 'containerDirective', (node: VisualNode, index, parent: VisualNode | undefined) => {
      const parts = node.name === VISUAL_DIRECTIVE ? visualParts(node) : null;
      if (parts == null || parent?.children == null || index == null) {
        return;
      }
      const complete = isVisualClosed(node, source);
      node.children = [];
      node.data = {
        ...node.data,
        hName: VISUAL_DIRECTIVE,
        hProperties: {
          title: node.attributes?.title ?? undefined,
          html: parts.fence.value ?? '',
          complete: complete ? 'true' : undefined,
        },
      };
      parent.children.splice(index, 1, ...parts.before, node, ...parts.after);
      return [SKIP, index + parts.before.length + 1];
    });
  };
};
