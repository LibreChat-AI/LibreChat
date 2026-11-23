/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import type { MessagePartsHost } from '../../../react/host';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { MessagePartsHostProvider } from '../../../react/host';
import MarkdownErrorBoundary from '../Boundary';
import MarkdownLite from '../Lite';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

beforeAll(() => {
  window.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
});

const under = (overrides: Partial<MessagePartsHost>, children: React.ReactNode) => (
  <MessagePartsHostProvider host={createMessagePartsHost(overrides)}>
    {children}
  </MessagePartsHostProvider>
);

describe('MarkdownLite', () => {
  it('draws emphasis, superscript and a GitHub table', () => {
    const { container } = render(
      under({}, <MarkdownLite content={'**bold** x^2^\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'} />),
    );
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(container.querySelector('sup')).toHaveTextContent('2');
    expect(container.querySelector('.markdown-table-wrapper table')).not.toBeNull();
  });

  it('keeps a pair of approximate tildes from striking out the text between them', () => {
    const { container } = render(under({}, <MarkdownLite content="about ~50% of ~200 rows" />));
    expect(container.querySelector('sub, del')).toBeNull();
    expect(container).toHaveTextContent('about ∼50% of ∼200 rows');
  });

  it('hands its fences to the host as executable, unless the card turns execution off', () => {
    const renderCodeBlock = jest.fn(() => <div data-testid="block" />);
    const text = '```python\nprint(1)\n```\n';
    const { rerender } = render(under({ renderCodeBlock }, <MarkdownLite content={text} />));
    expect(renderCodeBlock).toHaveBeenLastCalledWith(expect.objectContaining({ executable: true }));

    rerender(under({ renderCodeBlock }, <MarkdownLite content={text} codeExecution={false} />));
    expect(renderCodeBlock).toHaveBeenLastCalledWith(
      expect.objectContaining({ executable: false }),
    );
  });

  it('draws nothing for empty content', () => {
    const { container } = render(under({}, <MarkdownLite />));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('MarkdownErrorBoundary', () => {
  const Throws = ({ fail }: { fail: boolean }) => {
    if (fail) {
      throw new Error('a plugin threw');
    }
    return <span data-testid="rich">rich</span>;
  };

  let quiet: jest.SpyInstance;
  beforeEach(() => {
    quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => quiet.mockRestore());

  it('draws the same text with the base plugins when its tree throws, and tells the host', () => {
    const onBoundaryError = jest.fn();
    render(
      under(
        { onBoundaryError },
        <MarkdownErrorBoundary content="**still** readable">
          <Throws fail={true} />
        </MarkdownErrorBoundary>,
      ),
    );
    expect(screen.queryByTestId('rich')).not.toBeInTheDocument();
    expect(screen.getByText('still').tagName).toBe('STRONG');
    expect(onBoundaryError).toHaveBeenCalledWith(
      'markdown',
      expect.objectContaining({ message: 'a plugin threw' }),
    );
  });

  it('needs no host callback to recover', () => {
    render(
      under(
        {},
        <MarkdownErrorBoundary content="plain fallback">
          <Throws fail={true} />
        </MarkdownErrorBoundary>,
      ),
    );
    expect(screen.getByText('plain fallback')).toBeInTheDocument();
  });

  it('tries the full tree again once the content changes', () => {
    const tree = (content: string, fail: boolean) =>
      under(
        {},
        <MarkdownErrorBoundary content={content}>
          <Throws fail={fail} />
        </MarkdownErrorBoundary>,
      );
    const { rerender } = render(tree('first', true));
    expect(screen.getByText('first')).toBeInTheDocument();

    rerender(tree('second', false));
    expect(screen.getByTestId('rich')).toBeInTheDocument();
  });

  it('keeps a fallback’s code blocks from running where execution is off', () => {
    const renderCodeBlock = jest.fn(() => <div data-testid="block" />);
    render(
      under(
        { renderCodeBlock },
        <MarkdownErrorBoundary content={'```python\nprint(1)\n```\n'} codeExecution={false}>
          <Throws fail={true} />
        </MarkdownErrorBoundary>,
      ),
    );
    expect(renderCodeBlock).toHaveBeenCalledWith(expect.objectContaining({ executable: false }));
  });
});
