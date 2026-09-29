import React from 'react';
import remarkGfm from 'remark-gfm';
import supersub from 'remark-supersub';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import type { PluggableList } from 'unified';
import { code, codeNoExecution, a, p, img, table } from './MarkdownComponents';
import { langSubset, remarkApproxTilde } from '~/utils';
import { CodeBlockProvider } from '~/Providers';

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

interface MarkdownErrorBoundaryProps {
  children: React.ReactNode;
  content: string;
  codeExecution?: boolean;
}

class MarkdownErrorBoundary extends React.Component<
  MarkdownErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: MarkdownErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Markdown rendering error:', error, errorInfo);
  }

  componentDidUpdate(prevProps: MarkdownErrorBoundaryProps) {
    if (prevProps.content !== this.props.content && this.state.hasError) {
      this.setState({ hasError: false, error: undefined });
    }
  }

  render() {
    if (this.state.hasError) {
      const { content, codeExecution = true } = this.props;

      const rehypePlugins: PluggableList = [
        [
          rehypeHighlight,
          {
            detect: true,
            ignoreMissing: true,
            subset: langSubset,
          },
        ],
      ];

      return (
        <CodeBlockProvider>
          <ReactMarkdown
            remarkPlugins={[
              remarkApproxTilde,
              /** @ts-ignore */
              supersub,
              remarkGfm,
            ]}
            /** @ts-ignore */
            rehypePlugins={rehypePlugins}
            components={
              {
                code: codeExecution ? code : codeNoExecution,
                a,
                p,
                /** The recovery path is exactly where a generated reference
                 *  must still resolve; the default `img` would send
                 *  `![chart](chart.png)` to a page-relative URL. */
                img,
                table,
              } as {
                [nodeType: string]: React.ElementType;
              }
            }
          >
            {content}
          </ReactMarkdown>
        </CodeBlockProvider>
      );
    }

    return this.props.children;
  }
}

export default MarkdownErrorBoundary;
