import { useState } from 'react';
import { Copy, Check } from 'lucide';
import { cn, Button, MorphIcon, useLocalize, TooltipAnchor } from '@librechat/client';
import type { TMessage, SearchResultData } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { MarkdownVariant } from '../../react/messages/host';
import { useMessagesHost } from '../../react/messages/host';
import { revealOnRowHoverClasses } from './styles';

type THoverButtons = {
  message: TMessage;
  searchResults?: { [key: string]: SearchResultData };
  /** The renderer this row's message was displayed with, when it is not the authorship default. */
  variant?: MarkdownVariant;
};

export default function MinimalHoverButtons({
  message,
  searchResults,
  variant,
}: THoverButtons): ReactNode {
  const localize = useLocalize();
  const { useMessageCopy } = useMessagesHost();
  const [isCopied, setIsCopied] = useState(false);
  const { copyToClipboard, canCopy } = useMessageCopy({ message, searchResults, variant });

  return (
    <div className="text-text-tertiary visible mt-1 flex justify-center gap-1 self-end lg:justify-start">
      <TooltipAnchor
        description={
          isCopied ? localize('com_ui_copied_to_clipboard') : localize('com_ui_copy_to_clipboard')
        }
        render={
          <Button
            variant="message-action"
            aria-label={
              isCopied
                ? localize('com_ui_copied_to_clipboard')
                : localize('com_ui_copy_to_clipboard')
            }
            className={cn('ms-0 flex items-center gap-1.5 text-xs', revealOnRowHoverClasses)}
            disabled={!canCopy}
            onClick={() => copyToClipboard(setIsCopied)}
          >
            <MorphIcon icon={isCopied ? Check : Copy} size="1.1875rem" />
          </Button>
        }
      />
    </div>
  );
}
