import React from 'react';
import { RecoilRoot } from 'recoil';
import ReactMarkdown from 'react-markdown';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getRemarkPlugins, getRehypePlugins, getMarkdownComponents } from '../markdownConfig';
import { MessageContext, ArtifactProvider, CodeBlockProvider } from '~/Providers';
import { splitMarkdownIntoBlocks } from '../splitMarkdown';
import Markdown from '../Markdown';

/**
 * Mermaid blocks in the fixtures reach `useLocation`, so the markdown tree needs a
 * router the same way it has one in the app — without it the diagram throws into its
 * error boundary and the assertions compare two fallbacks instead of two renderers.
 */
const queryClient = new QueryClient();

const TestProviders = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <MemoryRouter>
      <RecoilRoot>{children}</RecoilRoot>
    </MemoryRouter>
  </QueryClientProvider>
);

/**
 * `mermaid` ships ESM that this suite's transform does not cover, so the real
 * component only ever reaches its error boundary here. Stub it — these cases
 * assert code-block indices, and a fallback on both sides of the comparison
 * would hide a genuine divergence between the two renderers.
 */
jest.mock('~/components/Messages/Content/Mermaid', () => ({
  __esModule: true,
  default: ({ id }: { id?: string }) => <div data-testid="mermaid" data-id={String(id)} />,
  MermaidErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockCodeBlockMounts = { count: 0 };

/**
 * Stub CodeBlock so we can read the blockIndex each executable code block
 * receives, while still exercising the real `code` override's skip/single-line
 * decision (which decides whether a CodeBlock renders at all). It also counts
 * mounts, which is how a remount of an already-rendered block shows up.
 */
jest.mock('~/components/Messages/Content/CodeBlock', () => ({
  __esModule: true,
  default: function MockCodeBlock({
    lang,
    blockIndex,
    codeChildren,
  }: {
    lang?: string;
    blockIndex?: number;
    codeChildren?: React.ReactNode;
  }) {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    useEffect(() => {
      mockCodeBlockMounts.count += 1;
    }, []);
    return (
      <div
        data-testid="cb"
        data-block-index={String(blockIndex)}
        data-lang={String(lang)}
        data-code={String(codeChildren)}
      />
    );
  },
}));

/** The real splitter, observed: whether a render paid for the block-boundary parse. */
jest.mock('../splitMarkdown', () => {
  const actual = jest.requireActual<typeof import('../splitMarkdown')>('../splitMarkdown');
  const splitSpy = jest.fn(actual.splitMarkdownIntoBlocks);
  return {
    ...actual,
    splitMarkdownIntoBlocks: splitSpy,
    createMarkdownSplitter: jest.fn(() => jest.fn((content: string) => splitSpy(content))),
  };
});

const splitSpy = jest.mocked(splitMarkdownIntoBlocks);

/** The previous whole-message renderer: a single ReactMarkdown under one set of providers. */
const OldMarkdown = ({ content }: { content: string }) => (
  <ArtifactProvider>
    <CodeBlockProvider>
      <ReactMarkdown
        /** @ts-ignore */
        remarkPlugins={getRemarkPlugins()}
        /** @ts-ignore */
        rehypePlugins={getRehypePlugins()}
        components={getMarkdownComponents()}
      >
        {content}
      </ReactMarkdown>
    </CodeBlockProvider>
  </ArtifactProvider>
);

/** The latest message of a conversation, generating while `submitting` holds. */
const LiveMarkdown = ({ content, submitting }: { content: string; submitting: boolean }) => (
  <MessageContext.Provider
    value={{
      messageId: 'live',
      isExpanded: false,
      isSubmitting: submitting,
      isLatestMessage: true,
    }}
  >
    <Markdown content={content} isLatestMessage={true} />
  </MessageContext.Provider>
);

const StreamingMarkdown = ({ content }: { content: string }) => (
  <LiveMarkdown content={content} submitting={true} />
);

/** A message the conversation opened with, already finished. */
const SettledMarkdown = ({ content }: { content: string }) => (
  <Markdown content={content} isLatestMessage={false} />
);

/**
 * The whole-message renderer emits whitespace-only text nodes ("\n") between
 * top-level block elements; the per-block renderer parses each block in
 * isolation and omits them. That whitespace is collapsed between block-level
 * elements, so it is visually and functionally irrelevant — normalize it away
 * before comparing structure.
 */
const normalizeHtml = (html: string) => html.replace(/>\s+</g, '><').trim();

const indicesIn = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-testid="cb"]')).map((el) => ({
    idx: el.getAttribute('data-block-index'),
    lang: el.getAttribute('data-lang'),
  }));

const streamThrough = (
  Component: React.ComponentType<{ content: string }>,
  content: string,
): HTMLElement => {
  const lines = content.split('\n');
  const { container, rerender } = render(
    <TestProviders>
      <Component content={lines[0]} />
    </TestProviders>,
  );
  for (let i = 2; i <= lines.length; i += 1) {
    rerender(
      <TestProviders>
        <Component content={lines.slice(0, i).join('\n')} />
      </TestProviders>,
    );
  }
  return container;
};

/** Streams a message line by line as the latest one, then finishes it. */
const streamAndFinish = (content: string) => {
  const view = (value: string, submitting: boolean) => (
    <TestProviders>
      <LiveMarkdown content={value} submitting={submitting} />
    </TestProviders>
  );
  const lines = content.split('\n');
  const rendered = render(view(lines[0], true));
  for (let i = 2; i <= lines.length; i += 1) {
    rendered.rerender(view(lines.slice(0, i).join('\n'), true));
  }
  rendered.rerender(view(content, false));
  return rendered;
};

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
  splitSpy.mockClear();
  mockCodeBlockMounts.count = 0;
});

describe('MarkdownBlocks code-block index parity', () => {
  it('assigns document-order indices on a direct render (matches whole-message renderer)', () => {
    const { container: oldC } = render(
      <TestProviders>
        <OldMarkdown content={MIXED} />
      </TestProviders>,
    );
    const { container: newC } = render(
      <TestProviders>
        <SettledMarkdown content={MIXED} />
      </TestProviders>,
    );

    expect(indicesIn(oldC)).toEqual(EXPECTED);
    expect(indicesIn(newC)).toEqual(EXPECTED);
  });

  it('keeps indices correct across a simulated stream (no drift under memoization)', () => {
    const oldC = streamThrough(OldMarkdown, MIXED);
    const newC = streamThrough(StreamingMarkdown, MIXED);

    expect(indicesIn(oldC)).toEqual(EXPECTED);
    expect(indicesIn(newC)).toEqual(EXPECTED);
  });

  it('streamed indices match a fresh direct render (stable for stored execution results)', () => {
    const streamed = streamThrough(StreamingMarkdown, MIXED);
    const { container: fresh } = render(
      <TestProviders>
        <SettledMarkdown content={MIXED} />
      </TestProviders>,
    );
    expect(indicesIn(streamed)).toEqual(indicesIn(fresh));
  });

  /**
   * Code blocks capture their index when they mount. A finished message moves to
   * per-block rendering on its first edit, and per block the base-aware keys
   * remount the blocks an edit shifted. The fixture turns a Mermaid fence, which
   * takes no code index, into an executable one, so the js block keeps a stale
   * index unless it really remounts.
   */
  it.each([
    ['a finished', false],
    ['a streamed', true],
  ])(
    'refreshes indices when an in-place edit to %s message inserts a code block before existing ones',
    (_label, streamedFirst) => {
      const before = '```mermaid\ngraph TD\n```\n\n```js\na\n```';
      const after = '```py\nx\n```\n\n```js\na\n```';
      const view = (content: string, submitting: boolean) => (
        <TestProviders>
          <LiveMarkdown content={content} submitting={submitting} />
        </TestProviders>
      );
      const { container, rerender } = render(view(before, streamedFirst));
      rerender(view(before, false));
      expect(indicesIn(container)).toEqual([{ idx: '0', lang: 'js' }]);

      rerender(view(after, false));
      // The js block's index shifted 0 -> 1; without forcing a remount its ref-cached
      // index would stay 0 (duplicating py). It must become 1.
      expect(indicesIn(container)).toEqual([
        { idx: '0', lang: 'py' },
        { idx: '1', lang: 'js' },
      ]);
    },
  );
});

describe('MarkdownBlocks provisional boundaries', () => {
  it.each([
    ['Intro\n***', 'Intro\n***important***.'],
    ['Intro\n#', 'Intro\n#hashtag'],
    ['Intro\n```', 'Intro\n```inline```'],
    ['- item\n***', '- item\n***important***.'],
    ['> quote\n***', '> quote\n***important***.'],
  ])('matches a fresh render after streaming past %j', (prefix, content) => {
    const view = (text: string, submitting: boolean) => (
      <TestProviders>
        <LiveMarkdown content={text} submitting={submitting} />
      </TestProviders>
    );
    const { container, rerender } = render(view(prefix, true));
    rerender(view(content, true));
    rerender(view(content, false));

    const { container: fresh } = render(
      <TestProviders>
        <OldMarkdown content={content} />
      </TestProviders>,
    );
    expect(normalizeHtml(container.innerHTML)).toBe(normalizeHtml(fresh.innerHTML));
  });
});

describe('MarkdownBlocks finished and streamed messages', () => {
  const PROSE = '# H\n\nPara with `code`.\n\n| x | y |\n| - | - |\n| 1 | 2 |\n\n- a\n- b';

  it('renders a finished message through one pipeline, without the block-boundary parse', () => {
    const { container: oldC } = render(
      <TestProviders>
        <OldMarkdown content={PROSE} />
      </TestProviders>,
    );
    const { container: settledC } = render(
      <TestProviders>
        <SettledMarkdown content={PROSE} />
      </TestProviders>,
    );

    expect(splitSpy).not.toHaveBeenCalled();
    // One pipeline reproduces the whole-message renderer exactly, down to the
    // whitespace between blocks that separately parsed blocks cannot carry.
    expect(settledC.innerHTML).toBe(oldC.innerHTML);
  });

  it('splits the message that is generating, so only its last block re-parses', () => {
    render(
      <TestProviders>
        <StreamingMarkdown content={PROSE} />
      </TestProviders>,
    );

    expect(splitSpy).toHaveBeenCalledWith(PROSE);
  });

  it('keeps a streamed message split once it finishes, so no block remounts', () => {
    const view = (content: string, submitting: boolean) => (
      <TestProviders>
        <LiveMarkdown content={content} submitting={submitting} />
      </TestProviders>
    );
    const lines = MIXED.split('\n');
    const { container, rerender } = render(view(lines[0], true));
    for (let i = 2; i <= lines.length; i += 1) {
      rerender(view(lines.slice(0, i).join('\n'), true));
    }
    const mountsWhileStreaming = mockCodeBlockMounts.count;
    splitSpy.mockClear();

    rerender(view(MIXED, false));

    expect(mockCodeBlockMounts.count).toBe(mountsWhileStreaming);
    expect(splitSpy).not.toHaveBeenCalled();
    expect(indicesIn(container)).toEqual(EXPECTED);
  });

  /**
   * Moving to per-block rendering remounts the message once, since the two paths
   * build different trees; it happens as generation starts, so the fade baseline
   * is set on the blocks it mounts. After that the message never remounts again.
   */
  it('moves a finished message to per-block rendering once when it starts generating again', () => {
    const view = (content: string, submitting: boolean) => (
      <TestProviders>
        <LiveMarkdown content={content} submitting={submitting} />
      </TestProviders>
    );
    const opening = MIXED.split('\n').slice(0, 12).join('\n');
    const { container, rerender } = render(view(opening, false));
    expect(splitSpy).not.toHaveBeenCalled();
    const mountsAtOpen = mockCodeBlockMounts.count;

    rerender(view(opening, true));
    expect(splitSpy).toHaveBeenCalledWith(opening);
    expect(mockCodeBlockMounts.count).toBe(mountsAtOpen * 2);

    // A generation that stops before producing anything must not move it back.
    rerender(view(opening, false));
    expect(mockCodeBlockMounts.count).toBe(mountsAtOpen * 2);

    const mountsOnceSplit = mockCodeBlockMounts.count;
    rerender(view(MIXED, true));
    rerender(view(MIXED, false));
    expect(indicesIn(container)).toEqual(EXPECTED);
    expect(mockCodeBlockMounts.count - mountsOnceSplit).toBe(EXPECTED.length - mountsAtOpen);
  });

  /**
   * An artifact editor saves the message it lives in every few hundred
   * milliseconds while the user types. Only the first save may remount the
   * message; after it, a save re-renders just the block it touched.
   */
  it('moves a finished message to per-block rendering on its first edit, and edits in place after it', () => {
    const view = (content: string) => (
      <TestProviders>
        <SettledMarkdown content={content} />
      </TestProviders>
    );
    const { container, rerender } = render(view(MIXED));
    expect(splitSpy).not.toHaveBeenCalled();
    const mountsAtOpen = mockCodeBlockMounts.count;

    rerender(view(MIXED.replace('Intro paragraph.', 'Intro paragraph, edited.')));
    expect(mockCodeBlockMounts.count).toBe(mountsAtOpen * 2);

    rerender(view(MIXED.replace('Intro paragraph.', 'Intro paragraph, edited twice.')));
    rerender(view(MIXED.replace('Some `inline` code here.', 'Some edited `inline` code.')));
    expect(mockCodeBlockMounts.count).toBe(mountsAtOpen * 2);
    expect(indicesIn(container)).toEqual(EXPECTED);
  });
});

describe('MarkdownBlocks DOM equivalence', () => {
  const cases: Array<[string, string]> = [
    ['paragraphs', 'First paragraph.\n\nSecond paragraph.'],
    ['gfm table', ['| a | b |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |'].join('\n')],
    ['unordered list', '- one\n- two\n- three'],
    ['ordered list', '1. one\n2. two'],
    ['headings + text', '# Title\n\nBody text with **bold** and _italics_.'],
    ['blockquote', '> quoted line one\n> quoted line two'],
    ['inline code', 'Use the `useMemo` hook for memoization.'],
    ['mixed', '# H\n\nPara with `code`.\n\n| x | y |\n| - | - |\n| 1 | 2 |\n\n- a\n- b'],
    /* A fence indented too little to belong to item 10 is a top-level block whose
     * indentation the whole-message parse strips from every code line. */
    [
      'fence indented under a two-digit list item',
      [
        '9. Build:',
        '',
        '   make',
        '',
        '10. Run the tests:',
        '',
        '   ```python',
        '   def test():',
        '       assert True',
        '   ```',
      ].join('\n'),
    ],
    [
      'list indented by two spaces',
      [
        '  - Step one',
        '',
        '      Note: run this',
        '',
        '  - Step two',
        '',
        '    ```python',
        '    print(1)',
        '    ```',
      ].join('\n'),
    ],
  ];

  it.each(cases)('renders identical DOM to the whole-message renderer: %s', (_label, content) => {
    const { container: oldC } = render(
      <TestProviders>
        <OldMarkdown content={content} />
      </TestProviders>,
    );
    const { container: settledC } = render(
      <TestProviders>
        <SettledMarkdown content={content} />
      </TestProviders>,
    );
    const { container: streamedC } = streamAndFinish(content);
    expect(normalizeHtml(settledC.innerHTML)).toBe(normalizeHtml(oldC.innerHTML));
    expect(normalizeHtml(streamedC.innerHTML)).toBe(normalizeHtml(oldC.innerHTML));
  });
});

describe('MarkdownBlocks rendering smoke', () => {
  it('renders an empty cursor placeholder while initializing', () => {
    const { container } = render(
      <TestProviders>
        <Markdown content="" isLatestMessage={true} />
      </TestProviders>,
    );
    expect(container.querySelector('.result-thinking')).not.toBeNull();
  });

  it('renders executable code blocks for a multi-code message', () => {
    render(
      <TestProviders>
        <SettledMarkdown content={MIXED} />
      </TestProviders>,
    );
    expect(screen.getAllByTestId('cb')).toHaveLength(4);
  });
});

/**
 * Constructs that need the whole document render as one block on both paths: a
 * finished message always does, and the splitter falls back to it for a message
 * that streamed.
 */
describe.each([
  ['a finished', false],
  ['a streamed', true],
])('MarkdownBlocks document-level constructs in %s message', (_label, streamed) => {
  const renderMessage = (content: string) =>
    streamed
      ? streamAndFinish(content)
      : render(
          <TestProviders>
            <SettledMarkdown content={content} />
          </TestProviders>,
        );

  it('resolves a reference-style link whose definition is in a separate block', () => {
    const content = 'See [docs][d] for details.\n\n[d]: https://example.com/docs';
    const { container } = renderMessage(content);
    expect(within(container).getByRole('link', { name: 'docs' })).toHaveAttribute(
      'href',
      'https://example.com/docs',
    );
  });

  it('keeps the separator between adjacent raw HTML blocks', () => {
    const content = '<div>one</div>\n\n<div>two</div>';
    const { container: oldC } = render(
      <TestProviders>
        <OldMarkdown content={content} />
      </TestProviders>,
    );
    const { container } = renderMessage(content);
    expect(container.innerHTML).toBe(oldC.innerHTML);
  });
});
