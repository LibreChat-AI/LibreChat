import React, { useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import type { PluggableList } from 'unified';
import { MESSAGE_HIGHLIGHT, getLoadedRehypeModules } from '../../react/parts/rehype';
import { markdownElements, markdownPreviewElements } from './elements';
import { CodeBlockProvider } from '../../react/parts/codeIndex';
import { useMessagePartsHost } from '../../react/host';
import { BASE_REMARK } from './plugins';

interface BoundaryState {
  hasError: boolean;
  error?: Error;
}

export interface MarkdownErrorBoundaryProps {
  children: React.ReactNode;
  content: string;
  codeExecution?: boolean;
}

interface BoundaryProps extends MarkdownErrorBoundaryProps {
  onError: (error: Error) => void;
}

class Boundary extends React.Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('Markdown rendering error:', error, errorInfo);
    this.props.onError(error);
  }

  componentDidUpdate(prevProps: BoundaryProps): void {
    if (prevProps.content !== this.props.content && this.state.hasError) {
      this.setState({ hasError: false, error: undefined });
    }
  }

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }
    const { content, codeExecution = true } = this.props;

    /* A class component cannot wait on the loader; highlight only if it already arrived. Both
       plugins are typed against an older `unified`, hence the cast. */
    const loaded = getLoadedRehypeModules();
    const rehypePlugins = (loaded
      ? [[loaded.rehypeHighlight, MESSAGE_HIGHLIGHT]]
      : []) as unknown as PluggableList;

    /* The recovery path is exactly where a generated reference must still resolve, so it keeps
       the package's `img`: the default one would send `![chart](chart.png)` to a page-relative
       URL. */
    return (
      <CodeBlockProvider>
        <ReactMarkdown
          remarkPlugins={BASE_REMARK}
          rehypePlugins={rehypePlugins}
          components={codeExecution ? markdownElements : markdownPreviewElements}
        >
          {content}
        </ReactMarkdown>
      </CodeBlockProvider>
    );
  }
}

/**
 * Catches a markdown tree that throws while rendering and draws the same text with the base
 * plugins instead, until the content changes. The host hears about the error through
 * `onBoundaryError`.
 */
export default function MarkdownErrorBoundary({
  children,
  content,
  codeExecution,
}: MarkdownErrorBoundaryProps): React.JSX.Element {
  const { onBoundaryError } = useMessagePartsHost();
  const report = useCallback(
    (error: Error) => onBoundaryError?.('markdown', error),
    [onBoundaryError],
  );
  return (
    <Boundary content={content} codeExecution={codeExecution} onError={report}>
      {children}
    </Boundary>
  );
}
