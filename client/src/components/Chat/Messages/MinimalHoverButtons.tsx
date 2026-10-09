import { useState, useMemo } from 'react';
import { Copy, Check } from 'lucide';
import { Button, MorphIcon, TooltipAnchor } from '@librechat/client';
import type { TMessage, SearchResultData } from 'librechat-data-provider';
import type { MarkdownVariant } from '~/utils/richtext';
import {
  useLocalize,
  useCopyMessageToClipboard,
  getMessageClipboardSource,
  hasCopyableText,
} from '~/hooks';
import { revealOnRowHoverClasses } from './styles';
import { cn } from '~/utils';

type THoverButtons = {
  message: TMessage;
  searchResults?: { [key: string]: SearchResultData };
  /** The renderer this row's message was displayed with, when it is not the authorship default. */
  variant?: MarkdownVariant;
};

export default function MinimalHoverButtons({ message, searchResults, variant }: THoverButtons) {
  const localize = useLocalize();
  const [isCopied, setIsCopied] = useState(false);
  const clipboardSource = useMemo(() => getMessageClipboardSource(message), [message]);
  const copyToClipboard = useCopyMessageToClipboard({
    ...clipboardSource,
    searchResults,
    variant: clipboardSource.variant ?? variant,
  });
  const canCopy = useMemo(
    () => hasCopyableText({ ...clipboardSource, searchResults }),
    [clipboardSource, searchResults],
  );

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
            className={cn('ml-0 flex items-center gap-1.5 text-xs', revealOnRowHoverClasses)}
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
