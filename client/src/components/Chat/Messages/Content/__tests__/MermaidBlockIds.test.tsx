import React from 'react';
import { render, screen } from '@testing-library/react';
import { getRemarkPlugins, getRehypePlugins, getMarkdownComponents } from '../markdownConfig';
import MarkdownBlocks from '../MarkdownBlocks';

/**
 * Mermaid fences do not consume a code-block index, so before they carried
 * their own sequence every diagram in a message received the same `mermaid-N`
 * id and therefore the same Recoil artifact key.
 */
jest.mock('~/components/Messages/Content/Mermaid', () => ({
  __esModule: true,
  default: ({ id, children }: { id?: string; children: string }) => (
    <div data-testid="mermaid" data-mermaid-id={String(id)}>
      {children}
    </div>
  ),
  MermaidErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('~/components/Messages/Content/CodeBlock', () => ({
  __esModule: true,
  default: ({ blockIndex }: { blockIndex?: number }) => (
    <div data-testid="code-block" data-block-index={String(blockIndex)} />
  ),
}));

const view = (content: string, streaming: boolean) => (
  <MarkdownBlocks
    content={content}
    streaming={streaming}
    remarkPlugins={getRemarkPlugins()}
    rehypePlugins={getRehypePlugins()}
    components={getMarkdownComponents()}
  />
);

const renderMarkdown = (content: string, streaming: boolean) => render(view(content, streaming));

const mermaidIds = () =>
  screen.getAllByTestId('mermaid').map((element) => element.getAttribute('data-mermaid-id'));

describe('Mermaid block ids', () => {
  /** A finished message renders as one pipeline and a streaming one per block; both number alike. */
  describe.each([
    ['a finished', false],
    ['a streaming', true],
  ])('in %s message', (_label, streaming) => {
    it('gives each Mermaid fence in a message a distinct id', () => {
      renderMarkdown(
        [
          '```mermaid',
          'graph TD',
          'A-->B',
          '```',
          '',
          '```mermaid',
          'graph TD',
          'C-->D',
          '```',
        ].join('\n'),
        streaming,
      );

      const ids = mermaidIds();
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
    });

    it('keeps Mermaid ids distinct across intervening executable code blocks', () => {
      renderMarkdown(
        [
          '```mermaid',
          'graph TD',
          'A-->B',
          '```',
          '',
          '```python',
          'print("hi")',
          '```',
          '',
          '```mermaid',
          'graph TD',
          'C-->D',
          '```',
          '',
          '```mermaid',
          'graph TD',
          'E-->F',
          '```',
        ].join('\n'),
        streaming,
      );

      const ids = mermaidIds();
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
    });

    it('does not let a Mermaid fence disturb executable code block indices', () => {
      renderMarkdown(
        [
          '```python',
          'print("first")',
          '```',
          '',
          '```mermaid',
          'graph TD',
          'A-->B',
          '```',
          '',
          '```python',
          'print("second")',
          '```',
        ].join('\n'),
        streaming,
      );

      const indices = screen
        .getAllByTestId('code-block')
        .map((element) => element.getAttribute('data-block-index'));
      expect(indices).toEqual(['0', '1']);
    });
  });

  /**
   * Fences nested in one top-level block share a provider and re-run their
   * index on every streamed token, so the counter has to restart per render.
   * Without that restart the indices climb as the message grows and a diagram
   * already open in the panel loses the artifact id it was registered under.
   */
  it('holds Mermaid ids steady as a nested block keeps streaming', () => {
    const listWithOne = ['- step one', '', '  ```mermaid', '  graph TD', '  A-->B', '  ```'].join(
      '\n',
    );
    const listWithTwo = [
      listWithOne,
      '',
      '- step two',
      '',
      '  ```mermaid',
      '  graph TD',
      '  C-->D',
      '  ```',
    ].join('\n');
    const listStillGrowing = [listWithTwo, '', '- step three'].join('\n');

    const { rerender } = renderMarkdown(listWithOne, true);
    expect(mermaidIds()).toEqual(['mermaid-0']);

    rerender(view(listWithTwo, true));
    expect(mermaidIds()).toEqual(['mermaid-0', 'mermaid-1']);

    rerender(view(listStillGrowing, true));
    expect(mermaidIds()).toEqual(['mermaid-0', 'mermaid-1']);
  });
});
