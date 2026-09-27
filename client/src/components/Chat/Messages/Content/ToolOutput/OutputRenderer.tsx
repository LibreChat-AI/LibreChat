import { useState, useMemo, useCallback } from 'react';
import copy from 'copy-to-clipboard';
import { Button } from '@librechat/client';
import { hasToolCallErrorPrefix, stripToolCallErrorPrefix } from 'librechat-data-provider';
import CopyButton from '~/components/Messages/Content/CopyButton';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface ContentBlock {
  type?: string;
  text?: string;
}

const ERROR_INNER = /^Error\s+\w+ing to endpoint\s*\(HTTP \d+\):\s*/i;

function cleanError(text: string): string {
  let cleaned = stripToolCallErrorPrefix(text).trim();
  cleaned = cleaned.replace(ERROR_INNER, '').trim();
  if (cleaned.endsWith('Please fix your mistakes.')) {
    cleaned = cleaned.slice(0, -'Please fix your mistakes.'.length).trim();
  }
  return cleaned;
}

/** The feedback a call gets when its input fails schema validation: the SDK
 *  returns it to the model as a plain `Error:` block closed by this sentence,
 *  with the run step still `completed`. Mirrors the server's own verdict in
 *  `completedToolExecutionStatus`, so a card, a group header and a phase
 *  agree with the label the server wrote for the same call. */
const VALIDATION_FEEDBACK = /^Error:[\s\S]*\n Please fix your mistakes\.$/i;

export function isError(text: string): boolean {
  return (
    hasToolCallErrorPrefix(text) ||
    text.startsWith('Error processing tool') ||
    VALIDATION_FEEDBACK.test(text)
  );
}

function isStructuredText(text: string): boolean {
  return text.includes('\n') || text.includes('{') || text.includes(':');
}

interface ExtractedText {
  text: string;
  rawError: string;
  error: boolean;
  /** When true, `text` contains raw JSON that should be rendered as a highlighted code block. */
  isJson: boolean;
}

function extractText(raw: string): ExtractedText {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { text: '', rawError: '', error: false, isJson: false };
  }

  if (isError(trimmed)) {
    return { text: cleanError(trimmed), rawError: trimmed, error: true, isJson: false };
  }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);

      if (Array.isArray(parsed)) {
        const textBlocks = parsed.filter(
          (b: ContentBlock) => typeof b === 'object' && b !== null && typeof b.text === 'string',
        );
        if (textBlocks.length > 0) {
          const joined = (textBlocks as ContentBlock[])
            .map((b) => b.text)
            .join('\n')
            .trim();
          if (isError(joined)) {
            return { text: cleanError(joined), rawError: joined, error: true, isJson: false };
          }
          return { text: joined, rawError: '', error: false, isJson: false };
        }
      }

      // Render structured JSON as a highlighted code block
      return {
        text: JSON.stringify(parsed, null, 2),
        rawError: '',
        error: false,
        isJson: true,
      };
    } catch {
      // Not JSON
    }
  }

  return { text: trimmed, rawError: '', error: false, isJson: false };
}

const TRUNCATE_LINES = 20;
const VISIBLE_LINES = 15;

interface OutputRendererProps {
  text: string;
}

export default function OutputRenderer({ text }: OutputRendererProps) {
  const localize = useLocalize();
  const { text: displayText, rawError, error, isJson } = useMemo(() => extractText(text), [text]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const handleCopy = useCallback(() => {
    setIsCopied(true);
    copy(displayText, { format: 'text/plain' });
    setTimeout(() => setIsCopied(false), 3000);
  }, [displayText]);

  if (!displayText) {
    return null;
  }

  const lines = displayText.split('\n');
  const needsTruncation = lines.length > TRUNCATE_LINES;
  const visibleText =
    needsTruncation && !isExpanded ? lines.slice(0, VISIBLE_LINES).join('\n') : displayText;
  const structured = !isJson && isStructuredText(displayText);

  return (
    <div>
      <div className="relative pr-10">
        {isJson ? (
          <pre className="max-h-[300px] overflow-auto rounded text-xs">
            <code className="hljs language-json !whitespace-pre-wrap !break-words">
              {visibleText}
            </code>
          </pre>
        ) : (
          <pre
            className={cn(
              'max-h-[300px] overflow-auto whitespace-pre-wrap break-words text-xs',
              error && 'font-mono text-status-error',
              !error && structured && 'font-mono text-text-secondary',
              !error && !structured && 'font-sans text-sm text-text-primary',
            )}
          >
            {visibleText}
          </pre>
        )}
        <div className="absolute right-0 top-1/2 -translate-y-1/2">
          <CopyButton
            isCopied={isCopied}
            onClick={handleCopy}
            iconOnly
            label={localize('com_ui_copy')}
          />
        </div>
      </div>
      {needsTruncation && (
        <Button
          variant="link"
          size="sm"
          className="mt-1 h-auto p-0 text-xs text-text-secondary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
          onClick={() => setIsExpanded((prev) => !prev)}
        >
          {isExpanded ? localize('com_ui_show_less') : localize('com_ui_show_more')}
        </Button>
      )}
      {error && rawError && rawError !== displayText && (
        <Button
          variant="link"
          size="sm"
          className="mt-1 block h-auto p-0 text-xs text-text-secondary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
          onClick={() => setShowErrorDetails((prev) => !prev)}
        >
          {localize('com_ui_details')}
        </Button>
      )}
      {showErrorDetails && rawError && (
        <pre className="mt-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-status-error">
          {rawError}
        </pre>
      )}
    </div>
  );
}
