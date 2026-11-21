import type { Node } from 'unist';

interface RawNode extends Node {
  type: 'raw';
  value?: string;
}

interface TextNode extends Node {
  type: 'text';
  value: string;
}

interface BrElementNode extends Node {
  type: 'element';
  tagName: 'br';
  properties: Record<string, never>;
  children: Node[];
}

interface ParentNode extends Node {
  children?: Node[];
}

const BR_TAG_REGEX = /^<br\s*\/?>$/i;
const LEADING_NEWLINE_REGEX = /^\r?\n/;

function createBrElement(): BrElementNode {
  return {
    type: 'element',
    tagName: 'br',
    properties: {},
    children: [],
  };
}

function isBrRawNode(node: Node): boolean {
  if (node.type !== 'raw') {
    return false;
  }
  const value = (node as RawNode).value;
  return typeof value === 'string' && BR_TAG_REGEX.test(value.trim());
}

/**
 * Strips a single leading newline from an immediately following `text` sibling so
 * `line1<br>\nline2` inside a `whitespace-pre-wrap` paragraph does not render both a
 * `<br>` and a preserved `\n` (a double line break).
 */
function trimFollowingNewline(children: Node[], brIndex: number): void {
  const next = children[brIndex + 1];
  if (!next || next.type !== 'text') {
    return;
  }
  const nextText = next as TextNode;
  if (typeof nextText.value !== 'string' || !LEADING_NEWLINE_REGEX.test(nextText.value)) {
    return;
  }
  const stripped = nextText.value.replace(LEADING_NEWLINE_REGEX, '');
  if (stripped === '') {
    children.splice(brIndex + 1, 1);
  } else {
    nextText.value = stripped;
  }
}

function convertBrNodes(node: Node): void {
  const children = (node as ParentNode).children;
  if (!children) {
    return;
  }

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (isBrRawNode(child)) {
      children[i] = createBrElement();
      trimFollowingNewline(children, i);
      continue;
    }
    convertBrNodes(child);
  }
}

/**
 * rehype plugin that converts bare `<br>`, `<br/>`, and `<br />` raw HAST nodes into
 * `<br>` elements without enabling `rehype-raw`. Any other raw HTML (including `<br>`
 * with attributes, `<script>`, `<img>`, `<div>`, etc.) is left as a `raw` node so
 * `react-markdown` continues rendering it as literal escaped text.
 */
export function rehypeSafeBreaks() {
  return (tree: Node) => convertBrNodes(tree);
}
