/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import type { MarkdownExtensions, MessagePartsHost } from '../../../react/host';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { MessagePartsHostProvider } from '../../../react/host';
import Markdown from '../Markdown';

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

const draw = (
  content: string,
  overrides: Partial<MessagePartsHost> = {},
  isLatestMessage = false,
) =>
  render(
    <MessagePartsHostProvider host={createMessagePartsHost(overrides)}>
      <Markdown content={content} isLatestMessage={isLatestMessage} />
    </MessagePartsHostProvider>,
  );

type TextNode = { type: string; value?: string; children?: TextNode[]; data?: object };

/** A host's own syntax: `[[name]]` becomes a `mention` node its element draws. */
const mentions = () => (tree: TextNode) => {
  const visit = (node: TextNode) => {
    node.children = node.children?.flatMap((child) => {
      const match =
        child.type === 'text' ? /^(.*)\[\[(\w+)\]\](.*)$/.exec(child.value ?? '') : null;
      if (!match) {
        visit(child);
        return [child];
      }
      return [
        { type: 'text', value: match[1] },
        { type: 'mention', data: { hName: 'mention', hProperties: { name: match[2] } } },
        { type: 'text', value: match[3] },
      ];
    });
  };
  visit(tree);
};

const extensions: MarkdownExtensions = {
  remarkPlugins: [mentions],
  elements: {
    mention: ({ name }: { name?: string }) => <span data-testid="mention">{`@${name}`}</span>,
  },
};

describe('Markdown', () => {
  it('draws a reply with the package’s elements, and highlights its code once the plugin loads', async () => {
    const { container } = draw('# Title\n\nSome **bold** text.\n\n```python\nprint(1)\n```\n');
    expect(screen.getByRole('heading', { name: 'Title' })).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    const code = container.querySelector('code.hljs.language-python');
    expect(code).toHaveTextContent('print(1)');
    await waitFor(() => expect(code?.querySelector('[class^="hljs-"]')).not.toBeNull());
  });

  it('holds the thinking cursor for the latest message until it has text', () => {
    const { container } = draw('', {}, true);
    expect(container.querySelector('.result-thinking')).not.toBeNull();
  });

  it('shows no cursor for an empty message that is not the latest', () => {
    const { container } = draw('');
    expect(container.querySelector('.result-thinking')).toBeNull();
  });

  it('reads `$...$` as math only where the reader has LaTeX parsing on', async () => {
    const text = 'The mass is $E=mc^2$ exactly.';
    const { container: on } = draw(text, { useLaTeXParsing: () => true });
    /* Typeset once KaTeX has loaded; until then the formula shows as its source. */
    await waitFor(() => expect(on.querySelector('.katex')).not.toBeNull());
    expect(on).not.toHaveTextContent('$');

    const { container: off } = draw(text, { useLaTeXParsing: () => false });
    expect(off.querySelector('.katex')).toBeNull();
    expect(off).toHaveTextContent('The mass is $E=mc^2$ exactly.');
  });

  it('always reads the unambiguous math delimiters', async () => {
    const { container } = draw('Inline $$x^2$$ here.', { useLaTeXParsing: () => false });
    await waitFor(() => expect(container.querySelector('.katex')).not.toBeNull());
    expect(container).not.toHaveTextContent('$');
  });

  it('leaves prices alone with LaTeX parsing on', () => {
    const { container } = draw('From $2bn to at least $4bn.', { useLaTeXParsing: () => true });
    expect(container.querySelector('.katex')).toBeNull();
    expect(container).toHaveTextContent('From $2bn to at least $4bn.');
  });

  it('runs the host’s plugins after its own and draws their nodes with the host’s elements', () => {
    draw('Ask [[ada]] about **this**.', { markdownExtensions: () => extensions });
    expect(screen.getByTestId('mention')).toHaveTextContent('@ada');
    expect(screen.getByText('this').tagName).toBe('STRONG');
  });

  it('lets a host element replace one of the package’s', () => {
    draw('A [link](https://example.test).', {
      markdownExtensions: () => ({
        elements: { a: ({ href }: { href?: string }) => <span data-testid="own">{href}</span> },
      }),
    });
    expect(screen.getByTestId('own')).toHaveTextContent('https://example.test');
  });

  it('renders a host’s syntax as written when the host adds nothing', () => {
    const { container } = draw('Ask [[ada]] about it.');
    expect(container).toHaveTextContent('Ask [[ada]] about it.');
  });

  it('keeps every block of a message that streams', () => {
    const host = createMessagePartsHost({
      useMessage: () => ({ messageId: 'm', isSubmitting: true }),
    });
    const view = (content: string) => (
      <MessagePartsHostProvider host={host}>
        <Markdown content={content} isLatestMessage={true} />
      </MessagePartsHostProvider>
    );
    const text = 'First paragraph.\n\nSecond paragraph.\n\n- one\n- two';
    const { container, rerender } = render(view('First'));
    for (let end = 10; end < text.length; end += 7) {
      rerender(view(text.slice(0, end)));
    }
    rerender(view(text));
    expect(container.querySelectorAll('p')).toHaveLength(2);
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });
});
