import { useRef, useState, useMemo, useCallback, useLayoutEffect } from 'react';
import copy from 'copy-to-clipboard';
import { Button } from '@librechat/client';
import { useToolContentPending } from '@librechat/chat/react';
import { PANE_COPY_REVEAL, CopyButton } from '@librechat/chat/components';
import { isError, extractText, isStructuredText, hasRenderableOutput } from '@librechat/chat';
import type { UIEvent } from 'react';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export interface OutputSegment {
  text: string;
  className?: string;
}

interface OutputRendererProps {
  text: string;
  copyText?: string;
  /** Forces error styling when the caller detected a failure the text itself does not mark. */
  error?: boolean;
  /** `terminal` renders command output: monospace and verbatim (no JSON reformatting). */
  variant?: 'default' | 'terminal';
  /** Terminal output split into styled runs whose texts join to `text` (for example stdout,
   *  stderr and an exit trailer). Rendered in place of the plain text. */
  segments?: OutputSegment[];
}

export default function OutputRenderer({
  text,
  copyText,
  error: forceError = false,
  variant = 'default',
  segments,
}: OutputRendererProps) {
  const localize = useLocalize();
  const terminal = variant === 'terminal';
  const extracted = useMemo(() => extractText(text, terminal), [text, terminal]);
  const { text: displayText, rawError, isJson } = extracted;
  const error = extracted.error || forceError;
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  /** Whether the reader is at the bottom of the box; scrolling up stops the follow. */
  const followRef = useRef(true);

  /* Terminal output opens on its last lines, where failures, stack traces and the
     exit trailer land, and keeps following new output until the reader scrolls up. */
  useLayoutEffect(() => {
    const node = outputRef.current;
    if (terminal && node != null && followRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [terminal, displayText, segments]);

  const handleOutputScroll = useCallback((event: UIEvent<HTMLPreElement>) => {
    const node = event.currentTarget;
    followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 8;
  }, []);

  const contentPending = useToolContentPending();
  const handleCopy = useCallback(() => {
    if (contentPending) {
      return;
    }
    setIsCopied(true);
    copy(copyText ?? displayText, { format: 'text/plain' });
    setTimeout(() => setIsCopied(false), 3000);
  }, [contentPending, copyText, displayText]);

  if (!displayText) {
    return null;
  }

  const structured = !isJson && (terminal || isStructuredText(displayText));
  const styled = terminal && segments != null && !error;

  return (
    <div>
      <div className="group/copy relative">
        {isJson ? (
          <pre dir="ltr" className="max-h-[18.75rem] overflow-auto rounded pe-6 text-xs">
            <code className="hljs language-json !break-words !whitespace-pre-wrap">
              {displayText}
            </code>
          </pre>
        ) : (
          <pre
            dir="ltr"
            ref={outputRef}
            onScroll={terminal ? handleOutputScroll : undefined}
            className={cn(
              'max-h-[18.75rem] overflow-auto pe-6 text-xs break-words whitespace-pre-wrap',
              error && 'text-status-error font-mono',
              !error && structured && 'font-mono',
              !error && structured && (terminal ? 'text-text-primary' : 'text-text-secondary'),
              !error && !structured && 'text-text-primary font-sans text-sm',
            )}
          >
            {styled
              ? segments?.map((segment, i) =>
                  segment.text === '' ? null : (
                    <span key={i} className={segment.className}>
                      {segment.text}
                    </span>
                  ),
                )
              : displayText}
          </pre>
        )}
        <CopyButton
          isCopied={isCopied}
          onClick={handleCopy}
          disabled={contentPending}
          iconOnly
          compact
          label={localize('com_ui_copy')}
          /** Pinned to the top corner, 4px out from the text box, so it sits an
           *  even distance from the panel's top and end edges at any length. */
          className={cn('bg-presentation absolute -inset-e-1 -top-1 z-[1]', PANE_COPY_REVEAL)}
        />
      </div>
      {error && rawError && rawError !== displayText && (
        <Button
          variant="link"
          size="bare"
          className="text-text-secondary mt-1 block text-xs underline"
          onClick={() => setShowErrorDetails((prev) => !prev)}
        >
          {localize('com_ui_details')}
        </Button>
      )}
      {showErrorDetails && rawError && (
        <pre
          dir="ltr"
          className="text-status-error mt-2 max-h-[12.5rem] overflow-auto font-mono text-xs break-words whitespace-pre-wrap"
        >
          {rawError}
        </pre>
      )}
    </div>
  );
}

export { isError, hasRenderableOutput };
