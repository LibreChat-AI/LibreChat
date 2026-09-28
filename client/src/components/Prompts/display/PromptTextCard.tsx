import { useState, useCallback, useRef, useEffect } from 'react';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { Copy, Check } from 'lucide';
import rehypeKatex from 'rehype-katex';
import supersub from 'remark-supersub';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { Button, MorphIcon, TooltipAnchor, useToastContext } from '@librechat/client';
import { codeNoExecution } from '~/components/Chat/Messages/Content/MarkdownComponents';
import { PromptVariableGfm } from '../editor/Markdown';
import { useLocalize } from '~/hooks';

interface PromptTextCardProps {
  mainText: string;
}

const PromptTextCard = ({ mainText }: PromptTextCardProps) => {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    if (isCopied) {
      return;
    }
    try {
      await navigator.clipboard.writeText(mainText);
      setIsCopied(true);
      showToast({
        message: localize('com_ui_copied_to_clipboard'),
        status: 'success',
      });
      timeoutRef.current = setTimeout(() => {
        setIsCopied(false);
      }, 2000);
    } catch {
      showToast({
        message: localize('com_ui_copy_failed'),
        status: 'error',
      });
    }
  }, [mainText, showToast, localize, isCopied]);

  return (
    <div className="relative flex h-full flex-col rounded-xl border border-border-medium bg-transparent">
      <div className="absolute right-2 top-2 z-10">
        <TooltipAnchor
          description={isCopied ? localize('com_ui_copied') : localize('com_ui_copy')}
          render={
            <Button
              size="icon"
              variant="ghost"
              onClick={handleCopy}
              className="size-8 gap-1.5"
              aria-label={
                isCopied ? localize('com_ui_copied') : localize('com_ui_copy_to_clipboard')
              }
              aria-live="polite"
            >
              <MorphIcon icon={isCopied ? Check : Copy} className="size-4 text-text-secondary" />
            </Button>
          }
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <ReactMarkdown
          remarkPlugins={[
            /** @ts-ignore */
            supersub,
            remarkGfm,
            [remarkMath, { singleDollarTextMath: false }],
          ]}
          rehypePlugins={[
            /** @ts-ignore */
            [rehypeKatex],
            /** @ts-ignore */
            [rehypeHighlight, { ignoreMissing: true }],
          ]}
          /** @ts-ignore */
          components={{ p: PromptVariableGfm, code: codeNoExecution }}
          className="markdown prose dark:prose-invert light my-1 max-w-none break-words text-text-primary"
        >
          {mainText}
        </ReactMarkdown>
      </div>
    </div>
  );
};

export default PromptTextCard;
