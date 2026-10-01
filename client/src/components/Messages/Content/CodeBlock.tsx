import React, { useRef, useState, useMemo, useEffect, useCallback } from 'react';
import { Tools } from 'librechat-data-provider';
import type { CodeBarProps } from '~/common';
import FloatingCodeBar from '~/components/Messages/Content/FloatingCodeBar';
import ResultSwitcher from '~/components/Messages/Content/ResultSwitcher';
import { useToolCallsMapContext, useMessageContext } from '~/Providers';
import { LogContent } from '~/components/Chat/Messages/Content/Parts';
import CodeBar from '~/components/Messages/Content/CodeBar';
import { useLocalize } from '~/hooks';
import cn from '~/utils/cn';

type CodeBlockProps = Pick<
  CodeBarProps,
  'lang' | 'plugin' | 'error' | 'allowExecution' | 'blockIndex'
> & {
  codeChildren: React.ReactNode;
  classProp?: string;
};

const CodeBlock: React.FC<CodeBlockProps> = ({
  lang,
  blockIndex,
  codeChildren,
  classProp = '',
  allowExecution = true,
  plugin = null,
  error,
}) => {
  const localize = useLocalize();
  const codeRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const codeBarRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isCodeBarVisible, setIsCodeBarVisible] = useState(true);

  const toolCallsMap = useToolCallsMapContext();
  const { messageId, partIndex } = useMessageContext();
  const key = allowExecution
    ? `${messageId}_${partIndex ?? 0}_${blockIndex ?? 0}_${Tools.execute_code}`
    : '';
  const [currentIndex, setCurrentIndex] = useState(0);

  const fetchedToolCalls = toolCallsMap?.[key];
  const [toolCalls, setToolCalls] = useState(toolCallsMap?.[key] ?? null);

  useEffect(() => {
    if (fetchedToolCalls) {
      setToolCalls(fetchedToolCalls);
      setCurrentIndex(fetchedToolCalls.length - 1);
    }
  }, [fetchedToolCalls]);

  useEffect(() => {
    const el = codeBarRef.current;
    if (!el) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => setIsCodeBarVisible(entry.isIntersecting),
      { root: null, threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleFocus = useCallback(() => setIsHovered(true), []);

  const handleBlur = useCallback((e: React.FocusEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setIsHovered(false);
    }
  }, []);

  const handleMouseEnter = useCallback(() => setIsHovered(true), []);

  const handleMouseLeave = useCallback(() => {
    if (!containerRef.current?.contains(document.activeElement)) {
      setIsHovered(false);
    }
  }, []);

  const currentToolCall = useMemo(() => toolCalls?.[currentIndex], [toolCalls, currentIndex]);

  const next = useCallback(() => {
    if (toolCalls && currentIndex < toolCalls.length - 1) {
      setCurrentIndex(currentIndex + 1);
    }
  }, [toolCalls, currentIndex]);

  const previous = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  }, [currentIndex]);

  const isNonCode = !!(plugin === true || error === true);
  const language = isNonCode ? 'json' : lang;
  const showFloating = isHovered && !isCodeBarVisible;

  return (
    <div
      ref={containerRef}
      className="border-border-light relative w-full overflow-hidden rounded-xl border text-xs"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <div ref={codeBarRef}>
        <CodeBar
          lang={lang}
          error={error}
          codeRef={codeRef}
          blockIndex={blockIndex}
          plugin={plugin === true}
          allowExecution={allowExecution}
        />
      </div>
      <div className={cn(classProp, 'bg-surface-code-body overflow-y-auto p-4')}>
        <code
          ref={codeRef}
          className={cn(
            isNonCode ? '!whitespace-pre-wrap' : `hljs language-${language} !whitespace-pre`,
          )}
        >
          {codeChildren}
        </code>
      </div>
      <FloatingCodeBar
        lang={lang}
        error={error}
        codeRef={codeRef}
        blockIndex={blockIndex}
        plugin={plugin === true}
        allowExecution={allowExecution}
        isVisible={showFloating}
      />
      {allowExecution === true && toolCalls && toolCalls.length > 0 && (
        <>
          <div className="border-border-light bg-surface-code border-t p-4 text-xs">
            <div className="text-text-secondary mb-1 text-[10px] font-medium tracking-wide uppercase">
              {localize('com_ui_output')}
            </div>
            <div className="text-text-primary flex flex-col-reverse">
              <pre className="shrink-0">
                <LogContent
                  output={(currentToolCall?.result as string | undefined) ?? ''}
                  attachments={currentToolCall?.attachments ?? []}
                  renderImages={true}
                />
              </pre>
            </div>
          </div>
          {toolCalls.length > 1 && (
            <ResultSwitcher
              currentIndex={currentIndex}
              totalCount={toolCalls.length}
              onPrevious={previous}
              onNext={next}
            />
          )}
        </>
      )}
    </div>
  );
};

export default CodeBlock;
