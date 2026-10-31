import { useAtomValue } from 'jotai';
import { setDefaultMessagesHost } from '@librechat/chat/react';
import type { MessagesHost, MessagesScrolling } from '@librechat/chat/react';
import type { TMessage } from 'librechat-data-provider';
import useConversationSeen from '~/hooks/Conversations/useConversationSeen';
import useMessageScrolling from '~/hooks/Messages/useMessageScrolling';
import Files from '~/components/Chat/Messages/Content/Files';
import { useScreenshot } from '~/hooks/ScreenshotContext';
import useClockFormat from '~/hooks/useClockFormat';
import { autoScrollAtom } from '~/store/autoScroll';

/** The app's scrolling hook, as the message list reads it. */
function useScrolling(messagesTree: TMessage[] | null | undefined): MessagesScrolling {
  const { conversation, ...scrolling } = useMessageScrolling(messagesTree);
  return { ...scrolling, conversationId: conversation?.conversationId };
}

/** What the message list reads from the app: the viewer's clock format, its scrolling,
 *  screenshot and seen reporting, and the row pieces that still live here. Registered as the
 *  default when this module loads, so rows read it on every route, the shared view included. */
export const appMessagesHost: MessagesHost = {
  useHour12: useClockFormat,
  renderFiles: (message) => <Files message={message} />,

  useScrolling,
  useScreenshotTarget: () => useScreenshot().screenshotTargetRef,
  useAutoScroll: () => useAtomValue(autoScrollAtom),
  useConversationSeen,
};

setDefaultMessagesHost(appMessagesHost);
