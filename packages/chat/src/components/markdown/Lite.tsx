import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { NamedExoticComponent } from 'react';
import { markdownElements, markdownPreviewElements } from './elements';
import { ArtifactProvider } from '../../react/parts/artifactIndex';
import { CodeBlockProvider } from '../../react/parts/codeIndex';
import { useRehypeModules } from '../../react/parts/rehype';
import { MATH_REMARK, rehypeList } from './plugins';
import MarkdownErrorBoundary from './Boundary';

export interface MarkdownLiteProps {
  content?: string;
  /** Whether a code block may offer to run. On by default; a card that only shows text turns it off. */
  codeExecution?: boolean;
}

/**
 * Markdown without the reply-only parts: no streaming fade, no per-block memoization, no
 * single-dollar math and none of the host's extensions. For text a card shows whole, such as a
 * tool's output, a search result or a notice.
 */
const MarkdownLite: NamedExoticComponent<MarkdownLiteProps> = memo(function MarkdownLite({
  content = '',
  codeExecution = true,
}: MarkdownLiteProps) {
  const rehypePlugins = rehypeList(useRehypeModules(content));

  return (
    <MarkdownErrorBoundary content={content} codeExecution={codeExecution}>
      <ArtifactProvider>
        <CodeBlockProvider>
          <ReactMarkdown
            remarkPlugins={MATH_REMARK}
            rehypePlugins={rehypePlugins}
            components={codeExecution ? markdownElements : markdownPreviewElements}
          >
            {content}
          </ReactMarkdown>
        </CodeBlockProvider>
      </ArtifactProvider>
    </MarkdownErrorBoundary>
  );
});

export default MarkdownLite;
