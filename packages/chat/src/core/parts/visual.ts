/**
 * A `:::visual` container's ```html fence and the children around it: prose written inside the
 * container, or the rest of a reply whose container never closed. The renderer, the block splitter
 * and rich-text copy all treat those children as ordinary reply content around the visual. A
 * container without a fence is not a visual, so this returns null and it renders as written.
 */
export function visualParts<C extends { type: string; lang?: string | null }>(node: {
  children?: C[];
}): { fence: C; before: C[]; after: C[] } | null {
  const children = node.children ?? [];
  const index = children.findIndex(
    (child) => child.type === 'code' && child.lang?.toLowerCase() === 'html',
  );
  if (index === -1) {
    return null;
  }
  return {
    fence: children[index],
    before: children.slice(0, index),
    after: children.slice(index + 1),
  };
}
