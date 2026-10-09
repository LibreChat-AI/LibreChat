import { fromMarkdown } from 'mdast-util-from-markdown';
import { directive } from 'micromark-extension-directive';
import { directiveFromMarkdown } from 'mdast-util-directive';
import { splitMarkdownIntoBlocks } from '~/components/Chat/Messages/Content/splitMarkdown';
import { visualParts } from '~/utils/visual';
import { isVisualClosed } from '../plugin';

type Node = {
  type: string;
  name?: string;
  lang?: string | null;
  value?: string;
  children?: Node[];
};

const containers = (source: string) => {
  const tree = fromMarkdown(source, {
    extensions: [directive()],
    mdastExtensions: [directiveFromMarkdown()],
  }) as unknown as Node;
  const found: Node[] = [];
  const walk = (node: Node) => {
    if (node.type === 'containerDirective') {
      found.push(node);
    }
    node.children?.forEach(walk);
  };
  walk(tree);
  return found;
};

const closed = (source: string) =>
  isVisualClosed(containers(source)[0] as Parameters<typeof isVisualClosed>[0], source);

describe('isVisualClosed', () => {
  it('sees the closing fence of a finished container', () => {
    expect(closed(':::visual{title="Chart"}\n```html\n<p>hi</p>\n```\n:::')).toBe(true);
    expect(closed('- item\n\n  :::visual\n  ```html\n  <p>x</p>\n  ```\n  :::')).toBe(true);
  });

  it('reports a container that is still streaming as open', () => {
    expect(closed(':::visual{title="Chart"}\n```html\n<p>h')).toBe(false);
    expect(closed(':::visual{title="Chart"}\n```html\n<p>hi</p>\n```\n')).toBe(false);
  });
});

describe('visualParts', () => {
  it('splits the html fence from the content around it', () => {
    const [node] = containers(
      ':::visual{title="t"}\nBefore.\n\n```html\n<p>x</p>\n```\n\nAfter.\n:::',
    );
    const parts = visualParts(node);
    expect(parts?.fence.value).toBe('<p>x</p>');
    expect(parts?.before.map((child) => child.type)).toEqual(['paragraph']);
    expect(parts?.after.map((child) => child.type)).toEqual(['paragraph']);
  });

  it('treats a container without an html fence as not a visual', () => {
    expect(visualParts(containers(':::visual{title="t"}\n<div>x</div>\n:::')[0])).toBeNull();
    expect(visualParts(containers(':::visual{title="t"}\n```js\nx\n```\n:::')[0])).toBeNull();
  });
});

describe('splitMarkdownIntoBlocks with visuals', () => {
  it('counts no code block or artifact for a visual container', () => {
    const [block] = splitMarkdownIntoBlocks(':::visual{title="t"}\n```html\n<p>x</p>\n```\n:::');
    expect(block.codeBlockCount).toBe(0);
    expect(block.artifactCount).toBe(0);
  });

  it('counts a code block left inside a container the model never closed', () => {
    const [block] = splitMarkdownIntoBlocks(
      ':::visual{title="t"}\n```html\n<p>x</p>\n```\n\n```js\nlet a = 1;\n```',
    );
    expect(block.codeBlockCount).toBe(1);
  });

  it('still counts a code block that follows a visual', () => {
    const blocks = splitMarkdownIntoBlocks(
      ':::visual{title="t"}\n```html\n<p>x</p>\n```\n:::\n\n```js\nlet a = 1;\n```',
    );
    expect(blocks.reduce((sum, block) => sum + block.codeBlockCount, 0)).toBe(1);
  });

  it('counts code inside a container without a fence, which renders as written', () => {
    const [block] = splitMarkdownIntoBlocks(
      ':::visual{title="t"}\nSee:\n\n```js\nlet a;\n```\n:::',
    );
    expect(block.codeBlockCount).toBe(1);
  });
});
