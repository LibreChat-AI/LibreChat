import { useCallback, useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilState, useRecoilValue } from 'recoil';
import { EventSubagentActivityGroup } from '@librechat/chat/components';
import { useUpdateFeedbackMutation } from 'librechat-data-provider/react-query';
import {
  setDefaultMessagesHost,
  useStreamedAttachments,
  revealedQueuedTurnFamily,
} from '@librechat/chat/react';
import type {
  ForkEvents,
  MessageFeedbackWrite,
  MessageCopy,
  MessagesHost,
  MessageCopyInput,
  ForkPreferences,
  ForkConversation,
  MessageAudioProps,
} from '@librechat/chat/react';
import type { Assistant, TMessage } from 'librechat-data-provider';
import {
  hasCopyableText,
  useNavigateToConvo,
  getMessageClipboardSource,
  useCopyMessageToClipboard,
} from '~/hooks';
import { useHideSelectedAuthor } from '~/components/Chat/Menus/Endpoints/shown';
import MessageContent from '~/components/Chat/Messages/Content/MessageContent';
import { useForkConvoMutation, useCachedMessages } from '~/data-provider';
import useConversationSeenSource from '~/hooks/Conversations/seenSource';
import useGetAddedConvo from '~/hooks/Conversations/useGetAddedConvo';
import { useOptionalMessagesOperations } from './MessagesViewContext';
import { PrivateText } from '~/components/Chat/Messages/PrivateText';
import MessageAudio from '~/components/Chat/Messages/MessageAudio';
import { useAssistantsMapContext } from './AssistantsMapContext';
import MessageIcon from '~/components/Chat/Messages/MessageIcon';
import Wakeup from '~/components/Chat/Messages/Content/Wakeup';
import { useFileMapContext } from '~/Providers/FileMapContext';
import Files from '~/components/Chat/Messages/Content/Files';
import { useScreenshot } from '~/hooks/ScreenshotContext';
import { useAgentsMapContext } from './AgentsMapContext';
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

function useAppConversationMessages(
  conversationId: string | null | undefined,
): TMessage[] | undefined {
  return useCachedMessages(conversationId ?? '').data;
}

function useAppAssistant(
  endpoint: string | null | undefined,
  model: string | null | undefined,
): Assistant | undefined {
  const map = useAssistantsMapContext();
  return map?.[endpoint ?? '']?.[model ?? ''];
}

function useAppMessageFeedback(conversationId: string, messageId: string): MessageFeedbackWrite {
  const { mutate } = useUpdateFeedbackMutation(conversationId, messageId);
  return mutate;
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
 *  fork request, the rich-text copy, its auto-scroll preference, screenshot and seen reporting, the thread's
 *  file map, and the row pieces that still live here: the message body, wake-up card, owner's text, step
 *  limit notice, author header and the subagent activity group. Registered as the default when this module loads, so rows read it on every route, the
 *  shared view included. */
export const appMessagesHost: MessagesHost = {
  useHour12: useClockFormat,
  renderFiles: (message) => <Files message={message} />,
  useForkPreferences: useAppForkPreferences,
  useForkConversation: useAppForkConversation,
  useMessageCopy: useAppMessageCopy,
  useGetMessages: useAppGetMessages,
  useHasPendingTurn: useAppHasPendingTurn,
  useConversationMessages: useAppConversationMessages,
  useAssistant: useAppAssistant,
  useGetAddedConvo,
  useStreamedAttachments,
  useMessageFeedback: useAppMessageFeedback,
  renderMessageAudio: (props) => <AppMessageAudio {...props} />,
  useScreenshotTarget: () => useScreenshot().screenshotTargetRef,
  useAutoScroll: () => useAtomValue(autoScrollAtom),
  useSeenSource: useConversationSeenSource,
  renderMessageIcon: (props) => <MessageIcon {...props} />,
  useMaximizeChatSpace: () => useRecoilValue(store.maximizeChatSpace),
  useHideSelectedAuthor,
  useAgentsMap: useAgentsMapContext,
  renderMessageBody: (props) => <MessageContent {...props} />,
  renderWakeup: (props) => <Wakeup {...props} />,
  renderPrivateText: (props) => <PrivateText {...props} />,
  renderActivity: (props) => <EventSubagentActivityGroup {...props} />,
  useFileMap: useFileMapContext,
};

setDefaultMessagesHost(appMessagesHost);
