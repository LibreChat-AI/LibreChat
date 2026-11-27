import type { Node } from 'unist';

interface TextNode extends Node {
  type: 'text';
  value: string;
}
interface LinkNode extends Node {
  type: 'link';
  url: string;
}
interface ParentNode extends Node {
  children?: Node[];
}

/**
 * A GFM autolink renders the URL itself as its label, so the label text node equals the
 * destination (with an implied scheme for `www.`/email links). Rewriting it would change the
 * URL the user sees while leaving the href intact, so these are left untouched.
 */
function isAutolinkLabel(value: string, parent?: Node): boolean {
  if (!parent || parent.type !== 'link') {
    return false;
  }
  const url = (parent as LinkNode).url;
  return (
    url === value ||
    url === `http://${value}` ||
    url === `https://${value}` ||
    url === `mailto:${value}`
  );
}

// "Approximately" tilde: a `~` prefixing a number that is not attached to a preceding word —
// e.g. `~50%`, `~ -3%`, `~$5`, `"~50%"`, `(~10%)`. Running on parsed text nodes (never code,
// links, math, or URL destinations) means only real prose is touched, so the boundary can be
// permissive: anything except a word character or another tilde. Word-attached and
// closed-number subscripts (`H~2~O`, `a ~2~ b`) are excluded so genuine subscripts survive.
// Markdown decodes `\~` to `~` before this runs, so escaped tildes are covered too.
const APPROX_TILDE_REGEX = /(?<![\w~])~(?=[ \t]?[-−+]?\$?\d)(?![ \t]?[-−+]?\$?[\d.,]*~)/g;
// U+223C TILDE OPERATOR — renders as a tilde but is not split by remark-supersub.
const TILDE_OPERATOR = '∼';

/**
 * Replaces "approximately" tildes (e.g. `~50%`) in a single text value with the Unicode
 * tilde operator so `remark-supersub` does not pair them into spurious `<sub>` ranges.
 * A backslash escape cannot help — markdown decodes `\~` back to `~` before supersub runs —
 * so the glyph itself must change.
 */
export function normalizeApproxTildes(value: string): string {
  if (value.indexOf('~') === -1) return value;
  return value.replace(APPROX_TILDE_REGEX, TILDE_OPERATOR);
}

function normalizeTextNodes(node: Node, parent?: Node): void {
  if (node.type === 'text') {
    const textNode = node as TextNode;
    if (typeof textNode.value === 'string' && !isAutolinkLabel(textNode.value, parent)) {
      textNode.value = normalizeApproxTildes(textNode.value);
    }
    return;
  }
  const children = (node as ParentNode).children;
  if (!children) return;
  for (const child of children) {
    normalizeTextNodes(child, node);
  }
}

/**
 * remark plugin that neutralizes "approximately" tildes in text nodes before
 * `remark-supersub` runs. Walking the parsed tree means code, links, math, and URL
 * destinations are structurally excluded — none of them are `text` nodes. Autolink labels
 * (which display the URL itself) are skipped so the visible URL is preserved verbatim.
 */
export function remarkApproxTilde() {
  return (tree: Node) => normalizeTextNodes(tree);
}
