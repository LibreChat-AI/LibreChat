import React from 'react';
import { RecoilRoot } from 'recoil';
import ReactMarkdown from 'react-markdown';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getRehypePlugins, getMarkdownComponents } from '../markdownConfig';
import { ArtifactProvider, CodeBlockProvider } from '~/Providers';
import MarkdownErrorBoundary from '../MarkdownErrorBoundary';
import MarkdownLite from '../MarkdownLite';
import Markdown from '../Markdown';

jest.mock('~/components/Messages/Content/CodeBlock', () => ({
  __esModule: true,
  default: ({ lang, codeChildren }: { lang: string; codeChildren: React.ReactNode }) => (
    <code data-language={lang}>{codeChildren}</code>
  ),
}));

const WholeMessage = ({ content }: { content: string }) => (
  <ArtifactProvider>
    <CodeBlockProvider>
      <ReactMarkdown
        rehypePlugins={
          getRehypePlugins() as React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']
        }
        components={getMarkdownComponents()}
      >
        {content}
      </ReactMarkdown>
    </CodeBlockProvider>
  </ArtifactProvider>
);

const Throw = (): never => {
  throw new Error('Exercise markdown fallback');
};

const Fallback = ({
  content,
  codeExecution = true,
}: {
  content: string;
  codeExecution?: boolean;
}) => (
  <MarkdownErrorBoundary content={content} codeExecution={codeExecution}>
    <Throw />
  </MarkdownErrorBoundary>
);

const renderers = [
  ['whole message', WholeMessage],
  ['blocks', (props: { content: string }) => <Markdown {...props} isLatestMessage={false} />],
  ['lite', MarkdownLite],
  [
    'lite without execution',
    (props: { content: string }) => <MarkdownLite {...props} codeExecution={false} />,
  ],
  ['fallback', Fallback],
  [
    'fallback without execution',
    (props: { content: string }) => <Fallback {...props} codeExecution={false} />,
  ],
] as const;

const prose = 'Pick up milk, eggs and bread on the way home. Call the dentist: Tuesday at 3.';

describe.each(renderers)('%s highlighting', (_name, Renderer) => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  const renderContent = (content: string) => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <RecoilRoot>
          <Renderer content={content} />
        </RecoilRoot>
      </QueryClientProvider>,
    );
    return container.querySelector('code');
  };

  it.each([
    ['', prose, true],
    ['', prose, false],
    ['', 'const answer = 42;', true],
    ['text', prose, true],
    ['plaintext', prose, true],
    ['unknownlang', prose, true],
  ])('keeps %s fences plain for %s (closed: %s)', (language, content, closed) => {
    const code = renderContent(`\`\`\`${language}\n${content}\n${closed ? '```' : ''}`);
    expect(code).toHaveAttribute('data-language', language || 'text');
    expect(code?.textContent).toBe(`${content}\n`);
    expect(code?.querySelector('[class*="hljs-"]')).toBeNull();
  });

  it('retains explicit Python highlighting', () => {
    const code = renderContent('```python\nprint("hello")\n```');
    expect(code).toHaveAttribute('data-language', 'python');
    expect(code?.querySelector('[class*="hljs-"]')).not.toBeNull();
  });

  it('keeps inline code inline', () => {
    const code = renderContent('Use `const answer = 42;` here.');
    expect(code).not.toHaveAttribute('data-language');
    expect(code?.textContent).toBe('const answer = 42;');
  });
});
