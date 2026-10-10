import type { Node } from 'unist';
import { unicodeCitation } from '../plugin';

type TestNode = { type: string; value?: string; children?: TestNode[] };

const run = (value: string): TestNode[] => {
  const tree: TestNode = {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
  };
  unicodeCitation()(tree as unknown as Node);
  return tree.children![0].children!;
};

describe('unicodeCitation plugin', () => {
  it('parses repeated composites with a reused ref regex', () => {
    const text =
      '\\ue200\\ue202turn0search0\\ue202turn0search1\\ue201 and \\ue200\\ue202turn1news2\\ue201';
    const first = run(text).filter((n) => n.type === 'composite-citation');
    const second = run(text).filter((n) => n.type === 'composite-citation');
    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
  });

  it('treats a marker after a closed composite as standalone', () => {
    const nodes = run('\\ue200\\ue202turn0search0\\ue201 x \\ue202turn0search1');
    expect(nodes.map((n) => n.type)).toEqual(['composite-citation', 'text', 'citation']);
  });

  it('does not treat a marker inside a composite as standalone, using the unicode char form', () => {
    const nodes = run('turn0search0turn0ref1');
    expect(nodes.map((n) => n.type)).toEqual(['composite-citation', 'citation']);
  });

  it('handles a standalone marker at the start of the text', () => {
    expect(run('\\ue202turn0search0').map((n) => n.type)).toEqual(['citation']);
  });
});
