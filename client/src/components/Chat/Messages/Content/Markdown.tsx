import React, { memo, useRef, useEffect } from 'react';
import { getRemarkPlugins, getRehypePlugins, getMarkdownComponents } from './markdownConfig';
import { useMessagePartsHost } from '~/Providers/MessagePartsHostContext';
import useSmoothStreaming from '~/hooks/Messages/useSmoothStreaming';
import MarkdownErrorBoundary from './MarkdownErrorBoundary';
import { FADE_HYDRATION_THRESHOLD } from './animate';
import MarkdownBlocks from './MarkdownBlocks';

type TContentProps = {
  content: string;
  isLatestMessage: boolean;
};

const Markdown = memo(function Markdown({ content = '', isLatestMessage }: TContentProps) {
  const { useMessage, useLaTeXParsing } = useMessagePartsHost();
  const { isSubmitting = false } = useMessage();
  const smoothStreaming = useSmoothStreaming();
  const LaTeXParsing = useLaTeXParsing();
  const isInitializing = content === '';

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
        remarkPlugins={getRemarkPlugins(LaTeXParsing)}
        rehypePlugins={getRehypePlugins()}
        components={getMarkdownComponents()}
        animate={animate}
        hydrated={hydratedRef.current}
      />
    </MarkdownErrorBoundary>
  );
});
Markdown.displayName = 'Markdown';

export default Markdown;
