import type { Node } from 'unist';
import { normalizeApproxTildes, remarkApproxTilde } from './tilde';

const T = '∼'; // U+223C TILDE OPERATOR

describe('normalizeApproxTildes', () => {
  test('returns the same string when no tilde is present', () => {
    const content = 'a plain string without any tilde';
    expect(normalizeApproxTildes(content)).toBe(content);
  });

  test('neutralizes a paired approximation that would become subscript', () => {
    expect(normalizeApproxTildes('down. ~50% of IPOs ... to ~10%).')).toBe(
      `down. ${T}50% of IPOs ... to ${T}10%).`,
    );
  });

  test('neutralizes a single approximation tilde', () => {
    expect(normalizeApproxTildes('about ~50 people')).toBe(`about ${T}50 people`);
  });

  test('neutralizes approximation before currency and after an open bracket', () => {
    expect(normalizeApproxTildes('range (~$5 to ~10%)')).toBe(`range (${T}$5 to ${T}10%)`);
  });

  test('neutralizes a spaced negative approximation', () => {
    expect(normalizeApproxTildes('is ~ -3% from')).toBe(`is ${T} -3% from`);
  });

  test('neutralizes quoted approximations', () => {
    expect(normalizeApproxTildes('about "~50%" and "~10%"')).toBe(`about "${T}50%" and "${T}10%"`);
  });

  test('preserves word-attached subscripts', () => {
    expect(normalizeApproxTildes('H~2~O and x~1~')).toBe('H~2~O and x~1~');
  });

  test('preserves a space-delimited closed-number subscript', () => {
    expect(normalizeApproxTildes('the term a ~2~ here')).toBe('the term a ~2~ here');
  });

  test('does not match a tilde attached to a preceding number', () => {
    expect(normalizeApproxTildes('range 5~10 items')).toBe('range 5~10 items');
  });
});

interface TextNode extends Node {
  type: 'text';
  value: string;
}
interface CodeNode extends Node {
  type: 'inlineCode' | 'code';
  value: string;
}
interface MathNode extends Node {
  type: 'inlineMath' | 'math';
  value: string;
}
interface LinkNode extends Node {
  type: 'link';
  url: string;
  children: Node[];
}

describe('remarkApproxTilde', () => {
  /**
   * supersub only splits `text` nodes, so the plugin's contract is to rewrite
   * approximation tildes in text nodes while leaving every other node type — code,
   * math, and link destinations — byte-for-byte untouched. A hand-built tree proves
   * that contract without depending on the parser.
   */
  test('rewrites text nodes but leaves code, math, and link URLs untouched', () => {
    const text: TextNode = { type: 'text', value: 'about ~50% and ~10% here' };
    const inlineCode: CodeNode = { type: 'inlineCode', value: '~50%' };
    const fenced: CodeNode = { type: 'code', value: '~50% in code\n~/path' };
    const inlineMath: MathNode = { type: 'inlineMath', value: 'x ~ 10' };
    const displayMath: MathNode = { type: 'math', value: '~10' };
    const linkText: TextNode = { type: 'text', value: '~50% off' };
    const link: LinkNode = {
      type: 'link',
      url: 'https://example.com/~50/file',
      children: [linkText],
    };
    const tree: Node = {
      type: 'root',
      children: [text, inlineCode, fenced, inlineMath, displayMath, link],
    } as Node;

    remarkApproxTilde()(tree);

    expect(text.value).toBe(`about ${T}50% and ${T}10% here`);
    expect(inlineCode.value).toBe('~50%');
    expect(fenced.value).toBe('~50% in code\n~/path');
    expect(inlineMath.value).toBe('x ~ 10');
    expect(displayMath.value).toBe('~10');
    expect(link.url).toBe('https://example.com/~50/file');
    expect(linkText.value).toBe(`${T}50% off`);
  });

  test('preserves an autolink label that displays the URL', () => {
    const label: TextNode = { type: 'text', value: 'https://example.com/~50/file' };
    const link: LinkNode = {
      type: 'link',
      url: 'https://example.com/~50/file',
      children: [label],
    };
    remarkApproxTilde()({ type: 'root', children: [link] } as Node);
    expect(label.value).toBe('https://example.com/~50/file');
  });

  test('preserves a www autolink label whose href has an implied scheme', () => {
    const label: TextNode = { type: 'text', value: 'www.example.com/~50/x' };
    const link: LinkNode = {
      type: 'link',
      url: 'http://www.example.com/~50/x',
      children: [label],
    };
    remarkApproxTilde()({ type: 'root', children: [link] } as Node);
    expect(label.value).toBe('www.example.com/~50/x');
  });

  test('still converts a regular link label that is prose', () => {
    const label: TextNode = { type: 'text', value: '~50% to ~10% off' };
    const link: LinkNode = { type: 'link', url: 'https://example.com', children: [label] };
    remarkApproxTilde()({ type: 'root', children: [link] } as Node);
    expect(label.value).toBe(`${T}50% to ${T}10% off`);
  });

  test('removes both tildes of an approximation pair so no `~` remains to subscript', () => {
    const node: TextNode = { type: 'text', value: 'first ~50% then ~10% drop' };
    const tree: Node = { type: 'root', children: [node] } as Node;
    remarkApproxTilde()(tree);
    expect(node.value).not.toContain('~');
    expect(node.value).toBe(`first ${T}50% then ${T}10% drop`);
  });

  test('leaves a genuine subscript text node intact for supersub to handle', () => {
    const node: TextNode = { type: 'text', value: 'water H~2~O molecule' };
    const tree: Node = { type: 'root', children: [node] } as Node;
    remarkApproxTilde()(tree);
    expect(node.value).toBe('water H~2~O molecule');
  });
});
