import { memo, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import type { TMessage } from 'librechat-data-provider';
import type { TMessageProps, TMessageIcon } from '~/common';
import AuthorHeader from '~/components/Chat/Messages/Content/Parts/AuthorHeader';
import MinimalHoverButtons from '~/components/Chat/Messages/MinimalHoverButtons';
import { getHeaderModelName } from '~/components/Chat/Messages/ui/HeaderLabel';
import { getHeaderPrefixForScreenReader, getMessageAriaLabel } from '~/utils';
import SearchContent, { rendersMarkdownLite } from './Content/SearchContent';
import MessageRow from '~/components/Chat/Messages/ui/MessageRow';
import Icon from '~/components/Chat/Messages/MessageIcon';
import { useAuthContext, useLocalize } from '~/hooks';
import SearchButtons from './SearchButtons';
import SubRow from './SubRow';
import store from '~/store';

function searchFilesEqual(prev?: TMessage['files'], next?: TMessage['files']) {
  if (prev === next) {
    return true;
  }
  const prevLen = prev?.length ?? 0;
  const nextLen = next?.length ?? 0;
  if (prevLen !== nextLen) {
    return false;
  }
  return prev?.every((file, index) => file.file_id === next?.[index]?.file_id) ?? true;
}

/**
 * Field-level comparator for `memo(SearchMessage)`. The virtualized `rowRenderer`
 * closure and the file-remap `useMemo` in the Search route can hand a fresh
 * `message` object with identical content on every parent render, so a shallow
 * compare would defeat the memo — compare only the fields that drive the row.
 */
export function areSearchMessagePropsEqual(
  prev: Pick<TMessageProps, 'message'>,
  next: Pick<TMessageProps, 'message'>,
): boolean {
  const a = prev.message;
  const b = next.message;
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return a === b;
  }
  return (
    a.messageId === b.messageId &&
    a.text === b.text &&
    a.content === b.content &&
    a.createdAt === b.createdAt &&
    /** Timestamp falls back to `clientTimestamp` when `createdAt` is absent. */
    a.clientTimestamp === b.clientTimestamp &&
    a.isCreatedByUser === b.isCreatedByUser &&
    a.sender === b.sender &&
    a.model === b.model &&
    a.endpoint === b.endpoint &&
    a.iconURL === b.iconURL &&
    /** `SearchContent` renders an incomplete-response notice on `unfinished`. */
    a.unfinished === b.unfinished &&
    /** `SearchContent` renders a failed row through the error dispatcher, not as markdown. */
    a.error === b.error &&
    /** `SearchButtons` renders `title` and navigates by `conversationId`, so a
     *  rename/refetch that leaves the text and id intact must still re-render. */
    a.title === b.title &&
    a.conversationId === b.conversationId &&
    searchFilesEqual(a.files, b.files)
  );
}

function SearchMessage({ message }: Pick<TMessageProps, 'message'>) {
  const UsernameDisplay = useRecoilValue<boolean>(store.UsernameDisplay);
  const { user } = useAuthContext();
  const localize = useLocalize();

  const iconData: TMessageIcon = useMemo(
    () => ({
      endpoint: message?.endpoint ?? '',
      model: message?.model ?? '',
      iconURL: message?.iconURL ?? '',
      isCreatedByUser: message?.isCreatedByUser ?? false,
    }),
    [message?.endpoint, message?.model, message?.iconURL, message?.isCreatedByUser],
  );

  const messageLabel = useMemo(() => {
    if (message?.isCreatedByUser) {
      return UsernameDisplay
        ? (user?.name ?? '') || (user?.username ?? '')
        : localize('com_user_message');
    }
    return message?.sender ?? '';
  }, [
    message?.isCreatedByUser,
    message?.sender,
    UsernameDisplay,
    user?.name,
    user?.username,
    localize,
  ]);

  const authorHeader = useMemo(
    () =>
      message?.isCreatedByUser === true ? undefined : (
        <AuthorHeader icon={<Icon iconData={iconData} />} label={messageLabel} />
      ),
    [message?.isCreatedByUser, iconData, messageLabel],
  );

  if (!message) {
    return null;
  }

  return (
    <div className="w-full bg-transparent text-text-primary">
      <div className="m-auto px-4 py-3 sm:px-0">
        <MessageRow
          id={message.messageId}
          icon={<Icon iconData={iconData} />}
          label={messageLabel}
          hoverLabel={getHeaderModelName(message.model)}
          timestamp={message.createdAt ?? message.clientTimestamp}
          ariaLabel={getMessageAriaLabel(message, localize)}
          headerPrefix={getHeaderPrefixForScreenReader(message, localize)}
          isCreatedByUser={message.isCreatedByUser === true}
          className="final-completion"
          footer={
            <SubRow classes={message.isCreatedByUser ? 'justify-end text-xs' : 'text-xs'}>
              <MinimalHoverButtons
                message={message}
                variant={rendersMarkdownLite(message) ? 'lite' : undefined}
              />
              <SearchButtons message={message} />
            </SubRow>
          }
        >
          <SearchContent message={message} authorHeader={authorHeader} />
        </MessageRow>
      </div>
    </div>
  );
}

export default memo(SearchMessage, areSearchMessagePropsEqual);
