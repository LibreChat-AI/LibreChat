import {
  useState,
  useMemo,
  memo,
  useEffect,
  useCallback,
  useRef,
  useId,
  type MouseEvent,
} from 'react';
import { useAtomValue } from 'jotai';
import { Lightbulb, ChevronDown } from 'lucide-react';
import { Button, MorphIcon, TooltipAnchor } from '@librechat/client';
import { ChevronUp as ChevronUpNode, ChevronDown as ChevronDownNode } from 'lucide';
import type { FocusEvent, FC } from 'react';
import CopyButton from '~/components/Messages/Content/CopyButton';
import { useLocalize, useExpandCollapse } from '~/hooks';
import { showThinkingAtom } from '~/store/showThinking';
import { fontSizeAtom } from '~/store/fontSize';
import { AnimatedText } from '../animate';
import { ROW_GLYPH_SLOT } from '../rows';
import { cn } from '~/utils';

/**
 * Tracks whether the referenced element is within the viewport. Mirrors the
 * CodeBlock pattern: the header copy/collapse controls live at the top, and the
 * floating bottom-right bar only takes over once the header scrolls out of view.
 */
export function useInViewport(): {
  ref: React.RefObject<HTMLDivElement>;
  inViewport: boolean;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [inViewport, setInViewport] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setInViewport(entry.isIntersecting), {
      root: null,
      threshold: 0,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, inViewport };
}

/**
 * ThinkingContent - Displays the actual thinking/reasoning content
 * Used by both legacy text-based messages and modern content parts
 */
export const ThinkingContent: FC<{
  children: React.ReactNode;
  animate?: boolean;
}> = memo(({ children, animate = false }) => {
  const fontSize = useAtomValue(fontSizeAtom);
  const content =
    animate && typeof children === 'string' ? <AnimatedText text={children} /> : children;

  return (
    <div className="relative rounded-lg border border-border-light bg-surface-secondary p-3 pb-8 text-text-secondary">
      <p className={cn('whitespace-pre-wrap leading-[26px]', fontSize)}>{content}</p>
    </div>
  );
});

/**
 * ThinkingButton - Toggle button for expanding/collapsing thinking content
 * Shows lightbulb icon by default, chevron on hover
 * Shared between legacy Thinking component and modern ContentParts
 */
export const ThinkingButton = memo(
  ({
    isExpanded,
    onClick,
    label,
    content,
    contentId,
    showCopyButton = true,
    animateLabel = false,
    shimmerLabel = false,
  }: {
    isExpanded: boolean;
    onClick: (e: MouseEvent<HTMLButtonElement>) => void;
    label: string;
    content?: string;
    contentId: string;
    showCopyButton?: boolean;
    animateLabel?: boolean;
    /** Reasoning is still being generated: carry the same shimmer a running
     *  tool call's label carries, so "thinking" reads as in-flight rather
     *  than as a settled disclosure. Off for finished thoughts. */
    shimmerLabel?: boolean;
  }) => {
    const localize = useLocalize();

    const [isCopied, setIsCopied] = useState(false);

    const handleCopy = useCallback(() => {
      if (content) {
        navigator.clipboard.writeText(content);
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
      }
    }, [content]);

    return (
      <div className="group/thinking relative flex w-full items-center">
        <button
          type="button"
          onClick={onClick}
          aria-expanded={isExpanded}
          aria-controls={contentId}
          /** `tool-status-text`, not the reader's body size: this header is a
           *  row in the same list as tool calls, grouped thoughts and phase
           *  summaries, all set at that scale. Sized to the body it read as a
           *  second, larger kind of row beside them. */
          className="group/button tool-status-text flex flex-1 items-center justify-start rounded-lg pr-10"
        >
          <span className={cn(ROW_GLYPH_SLOT, 'relative mr-2')}>
            <Lightbulb
              className="icon-sm absolute text-text-secondary opacity-100 transition-opacity group-hover/button:opacity-0"
              aria-hidden="true"
            />
            <ChevronDown
              className={cn(
                'icon-sm absolute transform-gpu text-text-primary opacity-0 transition-all duration-300 group-hover/button:opacity-100',
                isExpanded && 'rotate-180',
              )}
              aria-hidden="true"
            />
          </span>
          {/* The sweep rides the label row itself. That row is a flex item, so
              `.shimmer`'s `inline-block` is blockified away and the text sits
              exactly where the un-shimmered label sits — which matters, because
              an `inline-block` carrying `truncate` takes its baseline from its
              bottom margin edge, growing the line box and lifting the label off
              the icon's axis.

              Only the generated-label entrance forces a nested span: it and the
              sweep both drive `animation-name`, so they cannot share an element.
              There the entrance must stay outside — the clipped element paints
              the glyphs itself, so a descendant's opacity cannot fade them — and
              the inner span takes `align-top` to keep the baseline rule above
              from reopening the same gap.

              `key` remounts the row so the entrance replays, and that restarts
              the sweep with it. Reasoning labels revise on a 3s default against
              a 4s sweep, so the restart is frequent; it reads as intentional
              only while the entrance is there to cover it. With no entrance to
              play, the row keeps its identity and the sweep runs unbroken. */}
          <span
            key={animateLabel ? label : undefined}
            className={cn(
              'min-w-0 truncate text-left font-medium',
              shimmerLabel && !animateLabel && 'shimmer',
              animateLabel &&
                'duration-300 ease-out animate-in fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none',
            )}
          >
            {shimmerLabel && animateLabel ? (
              <span className="shimmer max-w-full truncate align-top">{label}</span>
            ) : (
              label
            )}
          </span>
        </button>
        {content && showCopyButton && isExpanded && (
          <CopyButton
            isCopied={isCopied}
            iconOnly
            onClick={handleCopy}
            label={localize('com_ui_copy_thoughts_to_clipboard')}
            copiedLabel={localize('com_ui_copied_to_clipboard')}
            className={cn(
              'absolute right-0 top-1/2 -translate-y-1/2 opacity-0 transition-opacity',
              'group-focus-within/thinking-container:opacity-100 group-hover/thinking-container:opacity-100',
              'focus-visible:opacity-100',
            )}
          />
        )}
      </div>
    );
  },
);

/**
 * ThinkingLabel - Non-interactive variant of the ThinkingButton header row,
 * for reasoning that happened but whose text is not available to this view
 * (detached subagent projections retain only a marker). Keeps the reasoning
 * presentation identical across surfaces without offering an empty disclosure.
 */
export const ThinkingLabel = memo(({ label, title }: { label: string; title?: string }) => {
  return (
    <div className="mb-2 pb-2 pt-2">
      <div className="tool-status-text flex w-full items-center justify-start" title={title}>
        <span className={cn(ROW_GLYPH_SLOT, 'relative mr-2')}>
          <Lightbulb className="icon-sm text-text-secondary" aria-hidden="true" />
        </span>
        <span className="min-w-0 truncate text-left font-medium text-text-secondary">{label}</span>
      </div>
    </div>
  );
});

/**
 * FloatingThinkingBar - Floating bar with expand/collapse and copy buttons
 * Shows on hover/focus, positioned at bottom right of thinking content
 * Inspired by CodeBlock's FloatingCodeBar pattern
 */
export const FloatingThinkingBar = memo(
  ({
    isVisible,
    isExpanded,
    onClick,
    content,
    contentId,
  }: {
    isVisible: boolean;
    isExpanded: boolean;
    onClick: (e: MouseEvent<HTMLButtonElement>) => void;
    content?: string;
    contentId: string;
  }) => {
    const localize = useLocalize();
    const [isCopied, setIsCopied] = useState(false);

    const handleCopy = useCallback(() => {
      if (content) {
        navigator.clipboard.writeText(content);
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
      }
    }, [content]);

    const collapseTooltip = isExpanded
      ? localize('com_ui_collapse_thoughts')
      : localize('com_ui_expand_thoughts');

    return (
      <div
        className={cn(
          'absolute bottom-3 right-3 flex items-center gap-2 transition-opacity duration-150',
          isVisible ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        <TooltipAnchor
          description={collapseTooltip}
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              tabIndex={isVisible ? 0 : -1}
              onClick={onClick}
              aria-label={collapseTooltip}
              aria-expanded={isExpanded}
              aria-controls={contentId}
            >
              <MorphIcon
                icon={isExpanded ? ChevronUpNode : ChevronDownNode}
                className="h-[18px] w-[18px]"
              />
            </Button>
          }
        />
        {content && (
          <CopyButton
            isCopied={isCopied}
            iconOnly
            tabIndex={isVisible ? 0 : -1}
            onClick={handleCopy}
            label={localize('com_ui_copy_thoughts_to_clipboard')}
            copiedLabel={localize('com_ui_copied_to_clipboard')}
          />
        )}
      </div>
    );
  },
);

/**
 * Thinking Component (LEGACY SYSTEM)
 *
 * Used for simple text-based messages with `:::thinking:::` markers.
 * This handles the old message format where text contains embedded thinking blocks.
 *
 * Pattern: `:::thinking\n{content}\n:::\n{response}`
 *
 * Used by:
 * - MessageContent.tsx for plain text messages
 * - Legacy message format compatibility
 * - User messages when manually adding thinking content
 *
 * For modern structured content (agents/assistants), see Reasoning.tsx component.
 */
const Thinking: React.ElementType = memo(({ children }: { children: React.ReactNode }) => {
  const localize = useLocalize();
  const showThinking = useAtomValue(showThinkingAtom);
  const [isExpanded, setIsExpanded] = useState(showThinking);
  const [isBarVisible, setIsBarVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { ref: headerRef, inViewport: headerInViewport } = useInViewport();
  const contentId = useId();
  const { style: expandStyle, ref: expandRef } = useExpandCollapse(isExpanded);

  const handleClick = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setIsExpanded((prev) => !prev);
  }, []);

  const handleFocus = useCallback(() => {
    setIsBarVisible(true);
  }, []);

  const handleBlur = useCallback((e: FocusEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setIsBarVisible(false);
    }
  }, []);

  const handleMouseEnter = useCallback(() => {
    setIsBarVisible(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (!containerRef.current?.contains(document.activeElement)) {
      setIsBarVisible(false);
    }
  }, []);

  const label = useMemo(() => localize('com_ui_thoughts'), [localize]);

  // Extract text content for copy functionality
  const textContent = useMemo(() => {
    if (typeof children === 'string') {
      return children;
    }
    return '';
  }, [children]);

  if (children == null) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="group/thinking-container"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <div className="mb-4 pb-2 pt-2" ref={headerRef}>
        <ThinkingButton
          isExpanded={isExpanded}
          onClick={handleClick}
          label={label}
          content={textContent}
          contentId={contentId}
        />
      </div>
      <div
        id={contentId}
        role="group"
        aria-label={label}
        aria-hidden={!isExpanded || undefined}
        style={expandStyle}
      >
        {/** Trailing gap lives inside the animated grid track (padding), not as
         *   an expand-only margin on the grid container, so it grows with the
         *   height instead of snapping in and jumping the content below. */}
        <div className="overflow-hidden pb-8" ref={expandRef}>
          <div className="relative">
            <ThinkingContent>{children}</ThinkingContent>
            <FloatingThinkingBar
              isVisible={isBarVisible && isExpanded && !headerInViewport}
              isExpanded={isExpanded}
              onClick={handleClick}
              content={textContent}
              contentId={contentId}
            />
          </div>
        </div>
      </div>
    </div>
  );
});

ThinkingButton.displayName = 'ThinkingButton';
ThinkingContent.displayName = 'ThinkingContent';
ThinkingLabel.displayName = 'ThinkingLabel';
FloatingThinkingBar.displayName = 'FloatingThinkingBar';
Thinking.displayName = 'Thinking';

export default Thinking;
