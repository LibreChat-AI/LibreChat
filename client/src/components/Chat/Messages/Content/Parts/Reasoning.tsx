import { memo, useMemo, useState, useCallback, useRef, useId } from 'react';
import { useAtom } from 'jotai';
import type { MouseEvent, FocusEvent } from 'react';
import { ContentTypes } from 'librechat-data-provider';
import { ThinkingContent, ThinkingButton, FloatingThinkingBar } from './Thinking';
import BklStageProgress, { parseBklStages } from '../BklStageProgress';
import { showThinkingAtom } from '~/store/showThinking';
import { useMessageContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type ReasoningProps = {
  reasoning: string;
  isLast: boolean;
};

/**
 * Reasoning Component (MODERN SYSTEM)
 *
 * Used for structured content parts with ContentTypes.THINK type.
 * This handles modern message format where content is an array of typed parts.
 *
 * Pattern: `{ content: [{ type: "think", think: "<think>content</think>" }, ...] }`
 *
 * Used by:
 * - ContentParts.tsx → Part.tsx for structured messages
 * - Agent/Assistant responses (OpenAI Assistants, custom agents)
 * - O-series models (o1, o3) with reasoning capabilities
 * - Modern Claude responses with thinking blocks
 *
 * Key differences from legacy Thinking.tsx:
 * - Works with content parts array instead of plain text
 * - Strips `<think>` tags instead of `:::thinking:::` markers
 * - Each THINK part has its own independent toggle button
 * - Can be interleaved with other content types
 *
 * For legacy text-based messages, see Thinking.tsx component.
 */
const Reasoning = memo(({ reasoning, isLast }: ReasoningProps) => {
  const contentId = useId();
  const localize = useLocalize();
  const [showThinking] = useAtom(showThinkingAtom);
  const [isExpanded, setIsExpanded] = useState(showThinking);
  const [isBarVisible, setIsBarVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { isSubmitting, isLatestMessage, nextType } = useMessageContext();

  // Strip <think> tags from the reasoning content (modern format)
  const reasoningText = useMemo(() => {
    return reasoning
      .replace(/^<think>\s*/, '')
      .replace(/\s*<\/think>$/, '')
      .trim();
  }, [reasoning]);

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

  const effectiveIsSubmitting = isLatestMessage ? isSubmitting : false;

  const label = useMemo(
    () =>
      effectiveIsSubmitting && isLast ? localize('com_ui_thinking') : localize('com_ui_thoughts'),
    [effectiveIsSubmitting, localize, isLast],
  );

  // BKL: bkl-api 의 진행 단계("라벨 — 상세" 줄)는 생각 블록 대신 체크리스트로
  const bklStages = useMemo(() => parseBklStages(reasoningText), [reasoningText]);

  if (!reasoningText) {
    return null;
  }

  if (bklStages) {
    return (
      <BklStageProgress
        stages={bklStages}
        isStreaming={effectiveIsSubmitting === true}
        isLast={isLast}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      className="group/reasoning"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <div className="group/thinking-container">
        <div className="mb-2 pb-2 pt-2">
          <ThinkingButton
            isExpanded={isExpanded}
            onClick={handleClick}
            label={label}
            content={reasoningText}
            contentId={contentId}
          />
        </div>
        <div
          id={contentId}
          role="group"
          aria-label={label}
          aria-hidden={!isExpanded || undefined}
          className={cn(
            'grid transition-all duration-300 ease-out',
            nextType !== ContentTypes.THINK && isExpanded && 'mb-4',
          )}
          style={{
            gridTemplateRows: isExpanded ? '1fr' : '0fr',
          }}
        >
          <div className="relative overflow-hidden">
            <ThinkingContent>{reasoningText}</ThinkingContent>
            <FloatingThinkingBar
              isVisible={isBarVisible && isExpanded}
              isExpanded={isExpanded}
              onClick={handleClick}
              content={reasoningText}
              contentId={contentId}
            />
          </div>
        </div>
      </div>
    </div>
  );
});

export default Reasoning;
