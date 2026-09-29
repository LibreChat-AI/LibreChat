import { Button } from '@librechat/client';
import { ChevronLeft } from 'lucide-react';
import { useGetConversationByIdQuery } from 'librechat-data-provider/react-query';
import { useLocalize, useNavigateToConvo } from '~/hooks';
import { cn } from '~/utils';

export default function SubagentThreadLink({
  threadId,
  className,
  labelClassName,
}: {
  threadId: string;
  className?: string;
  labelClassName?: string;
}) {
  const localize = useLocalize();
  const { navigateToConvo } = useNavigateToConvo();
  const normalizedThreadId = threadId.trim();
  const { data: targetConversation } = useGetConversationByIdQuery(normalizedThreadId, {
    enabled: normalizedThreadId !== '',
    retry: false,
  });
  if (normalizedThreadId === '' || targetConversation == null) {
    return null;
  }

  const label = localize('com_ui_subagent_back_to_parent');

  return (
    <Button
      type="button"
      /** Shares the chat header's translucent gradient with the model selector
       *  and the sidebar toggle, and the conversation scrolls under all three,
       *  so this takes the same opaque header treatment rather than `ghost`,
       *  whose empty fill let message text run through the label. */
      variant="header-action"
      size="sm"
      className={cn('shrink-0 gap-1', className)}
      aria-label={label}
      title={label}
      onClick={() => navigateToConvo(targetConversation)}
    >
      <ChevronLeft size={16} aria-hidden="true" />
      <span className={labelClassName}>{label}</span>
    </Button>
  );
}
