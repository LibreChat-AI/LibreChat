import React from 'react';
import { RecoilRoot } from 'recoil';
import ReactMarkdown from 'react-markdown';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Node } from 'unist';
import {
  getMarkdownComponents,
  getRehypePlugins,
  getRemarkPlugins,
} from '~/components/Chat/Messages/Content/markdownConfig';
import {
  getLoadedRehypeModules,
  loadRehypeModules,
} from '~/components/Chat/Messages/Content/rehype';
import MarkdownErrorBoundary from '~/components/Chat/Messages/Content/MarkdownErrorBoundary';
import MarkdownLite from '~/components/Chat/Messages/Content/MarkdownLite';
import { ArtifactProvider, CodeBlockProvider } from '~/Providers';
import { rehypeSafeBreaks } from './breaks';

const mockCreateElement = React.createElement;

jest.mock('~/components/Messages/Content/CodeBlock', () => ({
  __esModule: true,
  default: ({ codeChildren }: { codeChildren?: React.ReactNode }) =>
    mockCreateElement(
      'pre',
      { 'data-testid': 'cb' },
      mockCreateElement('code', null, codeChildren),
    ),
}));

beforeAll(() => loadRehypeModules());

interface RawNode extends Node {
  type: 'raw';
  value: string;
}

interface TextNode extends Node {
  type: 'text';
  value: string;
}

interface ElementNode extends Node {
  type: 'element';
  tagName: string;
  properties: Record<string, unknown>;
  children: Node[];
}

interface RootNode extends Node {
  type: 'root';
  children: Node[];
}

const queryClient = new QueryClient();

const renderWithProviders = (node: React.ReactNode) =>
  render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(MemoryRouter, null, React.createElement(RecoilRoot, null, node)),
    ),
  );

const renderMarkdown = (content: string) =>
  renderWithProviders(
    React.createElement(
      ArtifactProvider,
      null,
      React.createElement(
        CodeBlockProvider,
        null,
        React.createElement(
          ReactMarkdown,
          {
            /** @ts-ignore */
            remarkPlugins: getRemarkPlugins(),
            /** @ts-ignore */
            rehypePlugins: getRehypePlugins(getLoadedRehypeModules()),
            components: getMarkdownComponents(),
          },
          content,
        ),
      ),
    ),
  );

describe('rehypeSafeBreaks (HAST tree transform)', () => {
  test.each(['<br>', '<br/>', '<br />', '<BR>', '  <br />  '])(
    'replaces bare %s raw node with a br element',
    (rawValue) => {
      const tree: RootNode = {
        type: 'root',
        children: [
          {
            type: 'element',
            tagName: 'p',
            properties: {},
            children: [
              { type: 'text', value: 'line1' } as TextNode,
              { type: 'raw', value: rawValue } as RawNode,
              { type: 'text', value: 'line2' } as TextNode,
            ],
          } as ElementNode,
        ],
      };

      rehypeSafeBreaks()(tree);

      const paragraph = tree.children[0] as ElementNode;
      expect(paragraph.children).toEqual([
        { type: 'text', value: 'line1' },
        { type: 'element', tagName: 'br', properties: {}, children: [] },
        { type: 'text', value: 'line2' },
      ]);
    },
  );

  test('strips only one leading newline from the immediately following text node', () => {
    const tree: RootNode = {
      type: 'root',
      children: [
        { type: 'text', value: 'a' } as TextNode,
        { type: 'raw', value: '<br>' } as RawNode,
        { type: 'text', value: '\n' } as TextNode,
        { type: 'raw', value: '<br />' } as RawNode,
        { type: 'text', value: '\r\n\nb' } as TextNode,
      ],
    };

    rehypeSafeBreaks()(tree);

    expect(tree.children).toEqual([
      { type: 'text', value: 'a' },
      { type: 'element', tagName: 'br', properties: {}, children: [] },
      { type: 'element', tagName: 'br', properties: {}, children: [] },
      { type: 'text', value: '\nb' },
    ]);
  });

  test('leaves raw HTML with attributes or other tags untouched', () => {
    const rawNodes: RawNode[] = [
      { type: 'raw', value: '<br onclick="alert(1)">' },
      { type: 'raw', value: '<br class="x">' },
      { type: 'raw', value: '<script>alert(1)</script>' },
      { type: 'raw', value: '<img src=x onerror=alert(1)>' },
      { type: 'raw', value: '<div>hello</div>' },
    ];
    const tree: RootNode = {
      type: 'root',
      children: rawNodes.map((n) => ({ ...n })),
    };

    rehypeSafeBreaks()(tree);

    expect(tree.children).toEqual(rawNodes);
  });

  test('leaves <br> text inside pre and code elements untouched', () => {
    const tree: RootNode = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'code',
          properties: {},
          children: [{ type: 'text', value: '<br>' } as TextNode],
        } as ElementNode,
        {
          type: 'element',
          tagName: 'pre',
          properties: {},
          children: [
            {
              type: 'element',
              tagName: 'code',
              properties: {},
              children: [{ type: 'text', value: 'line1<br>\nline2' } as TextNode],
            } as ElementNode,
          ],
        } as ElementNode,
      ],
    };

    rehypeSafeBreaks()(tree);

    const inlineCode = tree.children[0] as ElementNode;
    const fencedPre = tree.children[1] as ElementNode;
    const fencedCode = fencedPre.children[0] as ElementNode;
    expect(inlineCode.children).toEqual([{ type: 'text', value: '<br>' }]);
    expect(fencedCode.children).toEqual([{ type: 'text', value: 'line1<br>\nline2' }]);
  });
});

describe('rehypeSafeBreaks (ReactMarkdown integration)', () => {
  test.each(['<br>', '<br/>', '<br />', '<BR>'])(
    'renders %s inside a paragraph as an HTML <br> element',
    (tag) => {
      const { container } = renderMarkdown(`line1${tag}line2`);
      const p = container.querySelector('p');
      expect(p).not.toBeNull();
      expect(p?.querySelectorAll('br')).toHaveLength(1);
      expect(p?.textContent).toBe('line1line2');
    },
  );

  test.each(['<br>', '<br/>', '<br />', '<BR>'])(
    'renders %s inside a GFM table cell as an HTML <br> element',
    (tag) => {
      const md = ['| Col 1 | Col 2 |', '| --- | --- |', `| a${tag}b | c |`].join('\n');
      const { container } = renderMarkdown(md);
      const cell = container.querySelector('tbody td');
      expect(cell).not.toBeNull();
      expect(cell?.querySelectorAll('br')).toHaveLength(1);
      expect(cell?.textContent).toBe('ab');
    },
  );

  test('avoids double line break for line1<br>line2 and line1<br>\\nline2 in whitespace-pre-wrap paragraphs', () => {
    const { container: inlineContainer } = renderMarkdown('line1<br>line2');
    const inlineP = inlineContainer.querySelector('p');
    expect(inlineP).toHaveClass('whitespace-pre-wrap');
    expect(inlineP?.innerHTML).toBe('line1<br>line2');

    const { container: newlineContainer } = renderMarkdown('line1<br>\nline2');
    const newlineP = newlineContainer.querySelector('p');
    expect(newlineP).toHaveClass('whitespace-pre-wrap');
    expect(newlineP?.innerHTML).toBe('line1<br>line2');
  });

  test('renders standalone <br> between paragraphs safely without error', () => {
    const { container } = renderMarkdown('First paragraph.\n\n<br>\n\nSecond paragraph.');
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].textContent).toBe('First paragraph.');
    expect(paragraphs[1].textContent).toBe('Second paragraph.');
    expect(container.querySelectorAll('br')).toHaveLength(1);
  });

  test.each([
    '<br onclick="alert(1)">',
    '<br class="x">',
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<div>hello</div>',
  ])('keeps unsafe or non-br HTML %s as literal escaped text', (snippet) => {
    const { container } = renderMarkdown(`before ${snippet} after`);
    expect(container.querySelector('br')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('div')).toBeNull();
    expect(container.textContent).toContain(snippet);
  });

  test('keeps <br> as literal text inside inline code', () => {
    const { container } = renderMarkdown('Use `<br>` for a break.');
    expect(container.querySelector('br')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('<br>');
  });

  test('keeps <br> as literal text inside fenced code blocks', () => {
    const { container } = renderMarkdown('```html\n<div><br></div>\nline1<br>\nline2\n```');
    expect(container.querySelector('br')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe(
      '<div><br></div>\nline1<br>\nline2\n',
    );
  });

  test('keeps <br> as literal text inside math expressions', () => {
    const { container: inlineMath } = renderMarkdown('$<br>$');
    expect(inlineMath.querySelector('br')).toBeNull();
    expect(inlineMath.querySelector('.katex')).not.toBeNull();

    const { container: blockMath } = renderMarkdown('$$\n<br>\n$$');
    expect(blockMath.querySelector('br')).toBeNull();
    expect(blockMath.querySelector('.katex')).not.toBeNull();
  });

  test('renders <br> tags in MarkdownLite and MarkdownErrorBoundary fallback', () => {
    const { container: liteContainer } = renderWithProviders(
      React.createElement(MarkdownLite, { content: 'line1<br />\nline2' }),
    );
    const liteP = liteContainer.querySelector('p');
    expect(liteP?.innerHTML).toBe('line1<br>line2');

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const Thrower = () => {
      throw new Error('boom');
    };
    const { container: boundaryContainer } = renderWithProviders(
      React.createElement(
        MarkdownErrorBoundary as React.ComponentType<React.PropsWithChildren<{ content: string }>>,
        { content: 'fallback1<br>\nfallback2' },
        React.createElement(Thrower),
      ),
    );
    const boundaryP = boundaryContainer.querySelector('p');
    expect(boundaryP?.innerHTML).toBe('fallback1<br>fallback2');
    consoleSpy.mockRestore();
  });
});
