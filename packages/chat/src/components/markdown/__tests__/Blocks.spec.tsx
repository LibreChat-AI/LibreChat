/**
 * @jest-environment jsdom
 */
import React, { useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { render } from '@testing-library/react';
import type { MarkdownCodeBlockProps } from '../../../react/host';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { ArtifactProvider } from '../../../react/parts/artifactIndex';
import { CodeBlockProvider } from '../../../react/parts/codeIndex';
import { MessagePartsHostProvider } from '../../../react/host';
import { markdownElements } from '../elements';
import { MATH_REMARK } from '../plugins';
import MarkdownBlocks from '../Blocks';

/** The real splitter, observed: whether a render paid for the block-boundary parse. */
const mockSplit = jest.fn();
jest.mock('../../../core/parts/splitMarkdown', () => {
  const actual = jest.requireActual<typeof import('../../../core/parts/splitMarkdown')>(
    '../../../core/parts/splitMarkdown',
  );
  return {
    ...actual,
    createMarkdownSplitter: () => {
      const split = actual.createMarkdownSplitter();
      return (content: string) => {
        mockSplit(content);
        return split(content);
      };
    },
  };
});

const mounts = { count: 0 };

/** A host's code block, counting mounts: a block that remounts loses what it holds. */
function Block({ lang, blockIndex }: MarkdownCodeBlockProps) {
  useEffect(() => {
    mounts.count += 1;
  }, []);
  return <div data-testid="cb" data-block-index={String(blockIndex)} data-lang={lang} />;
}

const host = createMessagePartsHost({
  renderCodeBlock: (props) => <Block {...props} />,
  renderMermaid: () => <div data-testid="diagram" />,
});

const view = (content: string, streaming: boolean) => (
  <MessagePartsHostProvider host={host}>
    <MarkdownBlocks
      content={content}
      streaming={streaming}
      rehypePlugins={[]}
      remarkPlugins={MATH_REMARK}
      components={markdownElements}
    />
  </MessagePartsHostProvider>
);

/** The whole message through one pipeline, as a renderer with no block memoization draws it. */
const whole = (content: string) => (
  <MessagePartsHostProvider host={host}>
    <ArtifactProvider>
      <CodeBlockProvider>
        <ReactMarkdown remarkPlugins={MATH_REMARK} components={markdownElements}>
          {content}
        </ReactMarkdown>
      </CodeBlockProvider>
    </ArtifactProvider>
  </MessagePartsHostProvider>
);

const indicesIn = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-testid="cb"]')).map((el) => ({
    idx: el.getAttribute('data-block-index'),
    lang: el.getAttribute('data-lang'),
  }));

const PROSE = '# H\n\nPara with `code`.\n\n| x | y |\n| - | - |\n| 1 | 2 |\n\n- a\n- b';

const MIXED = [
  'Intro paragraph.',
  '',
  '```python',
  'print("one")',
  'x = 1',
  '```',
  '',
  'Some `inline` code here.',
  '',
  '```js',
  'console.log("two");',
  'const y = 2;',
  '```',
  '',
  '```math',
  'E = mc^2',
  '```',
  '',
  '```bash',
  'echo single',
  '```',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
  '```ts',
  'const z: number = 3;',
  'export {};',
  '```',
].join('\n');

const EXPECTED = [
  { idx: '0', lang: 'python' },
  { idx: '1', lang: 'js' },
  { idx: '2', lang: 'bash' },
  { idx: '3', lang: 'ts' },
];

beforeEach(() => {
  mockSplit.mockClear();
  mounts.count = 0;
});

describe('MarkdownBlocks', () => {
  it('renders a finished message through one pipeline, without the block-boundary parse', () => {
    const { container: one } = render(whole(PROSE));
    const { container: settled } = render(view(PROSE, false));

    expect(mockSplit).not.toHaveBeenCalled();
    /* One pipeline reproduces the whole-message renderer exactly, down to the whitespace between
       blocks that separately parsed blocks cannot carry. */
    expect(settled.innerHTML).toBe(one.innerHTML);
  });

  it('splits the message that is generating, so only its last block re-parses', () => {
    render(view(PROSE, true));
    expect(mockSplit).toHaveBeenCalledWith(PROSE);
  });

  it('numbers a streamed message’s code blocks in document order, diagrams aside', () => {
    const lines = MIXED.split('\n');
    const { container, rerender } = render(view(lines[0], true));
    for (let i = 2; i <= lines.length; i += 1) {
      rerender(view(lines.slice(0, i).join('\n'), true));
    }
    expect(indicesIn(container)).toEqual(EXPECTED);
    expect(container.querySelectorAll('[data-testid="diagram"]')).toHaveLength(1);
  });

  it('keeps a streamed message split once it finishes, so no block remounts', () => {
    const lines = MIXED.split('\n');
    const { container, rerender } = render(view(lines[0], true));
    for (let i = 2; i <= lines.length; i += 1) {
      rerender(view(lines.slice(0, i).join('\n'), true));
    }
    const mountsWhileStreaming = mounts.count;
    mockSplit.mockClear();

    rerender(view(MIXED, false));

    expect(mounts.count).toBe(mountsWhileStreaming);
    expect(mockSplit).not.toHaveBeenCalled();
    expect(indicesIn(container)).toEqual(EXPECTED);
  });

  /**
   * Moving to per-block rendering remounts the message once, since the two paths build different
   * trees; it happens as generation starts, so the fade baseline is set on the blocks it mounts.
   * After that the message never remounts again.
   */
  it('moves a finished message to per-block rendering once when it starts generating again', () => {
    const opening = MIXED.split('\n').slice(0, 12).join('\n');
    const { container, rerender } = render(view(opening, false));
    expect(mockSplit).not.toHaveBeenCalled();
    const mountsAtOpen = mounts.count;

    rerender(view(opening, true));
    expect(mockSplit).toHaveBeenCalledWith(opening);
    expect(mounts.count).toBe(mountsAtOpen * 2);

    /* A generation that stops before producing anything must not move it back. */
    rerender(view(opening, false));
    expect(mounts.count).toBe(mountsAtOpen * 2);

    const mountsOnceSplit = mounts.count;
    rerender(view(MIXED, true));
    rerender(view(MIXED, false));
    expect(indicesIn(container)).toEqual(EXPECTED);
    expect(mounts.count - mountsOnceSplit).toBe(EXPECTED.length - mountsAtOpen);
  });

  /**
   * An editor that saves the message it lives in does so every few hundred milliseconds. Only
   * the first save may remount the message; after it, a save re-renders just the block it touched.
   */
  it('moves a finished message to per-block rendering on its first edit, and edits in place after it', () => {
    const { container, rerender } = render(view(MIXED, false));
    expect(mockSplit).not.toHaveBeenCalled();
    const mountsAtOpen = mounts.count;

    rerender(view(MIXED.replace('Intro paragraph.', 'Intro paragraph, edited.'), false));
    expect(mounts.count).toBe(mountsAtOpen * 2);

    rerender(view(MIXED.replace('Intro paragraph.', 'Intro paragraph, edited twice.'), false));
    rerender(view(MIXED.replace('Some `inline` code here.', 'Some edited `inline` code.'), false));
    expect(mounts.count).toBe(mountsAtOpen * 2);
    expect(indicesIn(container)).toEqual(EXPECTED);
  });

  it('draws nothing for an empty message', () => {
    const { container } = render(view('', true));
    expect(container).toBeEmptyDOMElement();
  });
});
