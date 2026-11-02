import { useCallback, useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilState, useRecoilValue } from 'recoil';
import { EventSubagentActivityGroup } from '@librechat/chat/components';
import { setDefaultMessagesHost, revealedQueuedTurnFamily } from '@librechat/chat/react';
import type {
  ForkEvents,
  MessageCopy,
  MessagesHost,
  MessageCopyInput,
  ForkPreferences,
  ForkConversation,
  MessagesScrolling,
  MessageAudioProps,
} from '@librechat/chat/react';
import type { TMessage } from 'librechat-data-provider';
import {
  hasCopyableText,
  useNavigateToConvo,
  getMessageClipboardSource,
  useCopyMessageToClipboard,
} from '~/hooks';
import useConversationSeen from '~/hooks/Conversations/useConversationSeen';
import useMessageScrolling from '~/hooks/Messages/useMessageScrolling';
import { useOptionalMessagesOperations } from './MessagesViewContext';
import ThreadMessage from '~/components/Chat/Messages/Thread/Message';
import MessageAudio from '~/components/Chat/Messages/MessageAudio';
import MessageIcon from '~/components/Chat/Messages/MessageIcon';
import { useFileMapContext } from '~/Providers/FileMapContext';
import Files from '~/components/Chat/Messages/Content/Files';
import { useScreenshot } from '~/hooks/ScreenshotContext';
import { useForkConvoMutation } from '~/data-provider';
import useClockFormat from '~/hooks/useClockFormat';
import { autoScrollAtom } from '~/store/autoScroll';
import store from '~/store';

function useAppForkPreferences(): ForkPreferences {
  const [option, setOption] = useRecoilState(store.forkSetting);
  const [splitAtTarget, setSplitAtTarget] = useRecoilState(store.splitAtTarget);
  const [rememberOption, setRememberOption] = useRecoilState(store.rememberDefaultFork);
  return useMemo(
    () => ({
      option,
      setOption,
      splitAtTarget,
      setSplitAtTarget,
      rememberOption,
      setRememberOption,
    }),
    [option, setOption, splitAtTarget, setSplitAtTarget, rememberOption, setRememberOption],
  );
}

/** The events ride on the mutation's own callbacks, not `mutate`'s, so the fork still opens and
 *  reports when the row that started it unmounted before the server answered. */
function useAppForkConversation(): ForkConversation {
  const { navigateToConvo } = useNavigateToConvo();
  const events = useRef<ForkEvents | null>(null);
  const { mutate } = useForkConvoMutation({
    onSuccess: (data) => {
      navigateToConvo(data.conversation);
      events.current?.onSuccess();
    },
    onError: (error) => events.current?.onError(error),
  });
  return useCallback<ForkConversation>(
    (request, next) => {
      events.current = next;
      mutate(request);
    },
    [mutate],
  );
}

/** The app's scrolling hook, as the message list reads it. */
function useScrolling(messagesTree: TMessage[] | null | undefined): MessagesScrolling {
  const { conversation, ...scrolling } = useMessageScrolling(messagesTree);
  return { ...scrolling, conversationId: conversation?.conversationId };
}

function useAppMessageCopy({ message, searchResults, variant }: MessageCopyInput): MessageCopy {
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
  return { copyToClipboard, canCopy };
}

function useAppGetMessages(): () => TMessage[] | undefined {
  return useOptionalMessagesOperations().getMessages;
}

function useAppHasPendingTurn(conversationId: string): boolean {
  return useAtomValue(revealedQueuedTurnFamily(conversationId)) != null;
}

/** Read-aloud follows the viewer's text-to-speech setting; off, the row draws no control. */
function AppMessageAudio(props: MessageAudioProps) {
  const textToSpeech = useRecoilValue<boolean>(store.textToSpeech);
  if (!textToSpeech) {
    return null;
  }
  return <MessageAudio {...props} />;
}

/** What the message list reads from the app: the viewer's clock format and fork defaults, the
 *  fork request, the rich-text copy, its scrolling, screenshot and seen reporting, the thread's
 *  file map, and the row pieces that still live here: the message body and the subagent activity
 *  group. Registered as the default when this module loads, so rows read it on every route, the
 *  shared view included. */
export const appMessagesHost: MessagesHost = {
  useHour12: useClockFormat,
  renderFiles: (message) => <Files message={message} />,
  useForkPreferences: useAppForkPreferences,
  useForkConversation: useAppForkConversation,
  useMessageCopy: useAppMessageCopy,
  useGetMessages: useAppGetMessages,
  useHasPendingTurn: useAppHasPendingTurn,
  renderMessageAudio: (props) => <AppMessageAudio {...props} />,
  useScrolling,
  useScreenshotTarget: () => useScreenshot().screenshotTargetRef,
  useAutoScroll: () => useAtomValue(autoScrollAtom),
  useConversationSeen,
  renderMessageIcon: (props) => <MessageIcon {...props} />,
  renderMessageRow: (props) => <ThreadMessage {...props} />,
  renderActivity: (props) => <EventSubagentActivityGroup {...props} />,
  useFileMap: useFileMapContext,
};

setDefaultMessagesHost(appMessagesHost);
