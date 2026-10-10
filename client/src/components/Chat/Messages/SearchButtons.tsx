import { Link } from 'lucide-react';
import { useRecoilValue } from 'recoil';
import { buttonVariants } from '@librechat/client';
import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import type { TMessage, TConversation } from 'librechat-data-provider';
import type { InfiniteData } from '@tanstack/react-query';
import type { ConversationCursorData } from '~/utils';
import { cn, findConversationInInfinite, setDocumentTitle } from '~/utils';
import { useLocalize, useNavigateToConvo } from '~/hooks';
import store from '~/store';

export default function SearchButtons({ message }: { message: TMessage }) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const search = useRecoilValue(store.search);
  const { navigateToConvo } = useNavigateToConvo();
  const conversationId = message.conversationId ?? '';

  const clickHandler = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!conversationId) {
      return;
    }

    let title = message.title ?? '';
    let cachedConvo = queryClient.getQueryData<TConversation>([
      QueryKeys.conversation,
      conversationId,
    ]);
    const convos = queryClient.getQueryData<InfiniteData<ConversationCursorData>>([
      QueryKeys.allConversations,
      { search: search.debouncedQuery },
    ]);
    if (!cachedConvo && convos) {
      cachedConvo = findConversationInInfinite(convos, conversationId);
    }
    if (!title) {
      title = cachedConvo?.title ?? '';
    }

    setDocumentTitle(title);
    navigateToConvo(
      cachedConvo ??
        ({
          conversationId,
          title,
        } as TConversation),
    );
  };

  if (!conversationId) {
    return null;
  }

  return (
    <div className="text-text-secondary flex min-w-0 items-center">
      {/* The chat this result came from, and the way back to it: the same quiet chip
          the rest of the app uses for a secondary action, holding a title that can
          be any length. */}
      <button
        type="button"
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'xs' }),
          'text-text-secondary hover:text-text-primary max-w-full min-w-0 gap-1.5 font-normal',
        )}
        onClick={clickHandler}
        title={localize('com_ui_go_to_conversation')}
      >
        <Link className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{message.title}</span>
      </button>
    </div>
  );
}
