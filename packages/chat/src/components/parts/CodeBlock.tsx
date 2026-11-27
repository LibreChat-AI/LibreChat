import React, { useRef, useState, useEffect, useCallback } from 'react';
import { cn } from '@librechat/client';
import type { CodeBarProps } from './CodeBar';
import FloatingCodeBar from './FloatingCodeBar';
import CodeBar from './CodeBar';

export type CodeBlockProps = Pick<
  CodeBarProps,
  'lang' | 'plugin' | 'error' | 'allowExecution' | 'blockIndex' | 'renderRun'
> & {
  codeChildren: React.ReactNode;
  classProp?: string;
  /** What the block's runs printed, drawn under the code where execution is allowed. */
  output?: React.ReactNode;
};

/**
 * A fenced code block: the bar that names its language and holds its actions, the code, and the
 * same actions floating over the code once the bar has scrolled out of view. Running the code is
 * the host's: it passes the run button and what the runs printed.
 */
const CodeBlock: React.FC<CodeBlockProps> = ({
  lang,
  output,
  renderRun,
  blockIndex,
  codeChildren,
  classProp = '',
  allowExecution = true,
  plugin = null,
  error,
}: CodeBlockProps) => {
  const codeRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const codeBarRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isCodeBarVisible, setIsCodeBarVisible] = useState(true);

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

  const isNonCode = !!(plugin === true || error === true);
  const language = isNonCode ? 'json' : lang;
  const showFloating = isHovered && !isCodeBarVisible;

  return (
    <div
      ref={containerRef}
      className="border-border-inset theme-chrome-quiet:border-2 theme-chrome-quiet:border-surface-code theme-chrome-quiet:bg-surface-code relative w-full overflow-hidden rounded-xl border text-xs"
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
          renderRun={renderRun}
          plugin={plugin === true}
          allowExecution={allowExecution}
        />
      </div>
      <div dir="ltr" className={cn(classProp, 'bg-surface-code-body overflow-y-auto p-4')}>
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
        renderRun={renderRun}
        plugin={plugin === true}
        allowExecution={allowExecution}
        isVisible={showFloating}
      />
      {allowExecution === true && output}
    </div>
  );
};

export default CodeBlock;
