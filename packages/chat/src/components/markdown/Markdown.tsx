import React, { memo, useMemo, useRef, useEffect } from 'react';
import type { NamedExoticComponent } from 'react';
import { useRehypeModules } from '../../react/parts/rehype';
import { useMessagePartsHost } from '../../react/host';
import { rehypeList, replyRemark } from './plugins';
import { FADE_HYDRATION_THRESHOLD } from '../fade';
import MarkdownErrorBoundary from './Boundary';
import { markdownElements } from './elements';
import MarkdownBlocks from './Blocks';

export interface MarkdownProps {
  content: string;
  /** Whether this is the conversation's latest message, the one that streams while a run is on. */
  isLatestMessage: boolean;
}

/**
 * A reply's markdown as LibreChat draws it: block by block while it streams, with newly arrived
 * words fading in where the reader has smooth streaming on, math and highlighted code once their
 * plugins have loaded, and whatever syntax the host adds through `markdownExtensions`.
 */
const Markdown: NamedExoticComponent<MarkdownProps> = memo(function Markdown({
  content = '',
  isLatestMessage,
}: MarkdownProps) {
  const { useMessage, useLaTeXParsing, useSmoothStreaming, markdownExtensions } =
    useMessagePartsHost();
  const { isSubmitting = false } = useMessage();
  const smoothStreaming = useSmoothStreaming();
  const LaTeXParsing = useLaTeXParsing();
  const rehypeModules = useRehypeModules(content);
  const isInitializing = content === '';
  const extensions = markdownExtensions?.();
  const remarkPlugins = useMemo(
    () => replyRemark(LaTeXParsing, extensions?.remarkPlugins),
    [LaTeXParsing, extensions],
  );
  const components = useMemo(
    () =>
      extensions?.elements ? { ...markdownElements, ...extensions.elements } : markdownElements,
    [extensions],
  );

  const streaming = isLatestMessage && isSubmitting;
  const animate = smoothStreaming && streaming;

  // Hydration signal for the fade: substantial content already present at the
  // render where `animate` flips on means resumed/switched-to/follow-up
  // content, which becomes the fade baseline instead of re-animating. The flag
  // is cleared after that render commits, so blocks mounting later in the same
  // stream (new paragraphs, however large) always animate.
  const prevAnimateRef = useRef(false);
  const hydratedRef = useRef(false);
  if (animate && !prevAnimateRef.current) {
    hydratedRef.current = content.length > FADE_HYDRATION_THRESHOLD;
  }
  prevAnimateRef.current = animate;
  useEffect(() => {
    if (animate) {
      hydratedRef.current = false;
    }
  }, [animate]);

  if (isInitializing) {
    return (
      <div className="absolute">
        <p className="relative">
          <span className={isLatestMessage ? 'result-thinking' : ''} />
        </p>
      </div>
    );
  }

  return (
    <MarkdownErrorBoundary content={content} codeExecution={true}>
      <MarkdownBlocks
        content={content}
        streaming={streaming}
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypeList(rehypeModules)}
        components={components}
        animate={animate}
        hydrated={hydratedRef.current}
      />
    </MarkdownErrorBoundary>
  );
});
Markdown.displayName = 'Markdown';

export default Markdown;
