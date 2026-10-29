import { useCallback, useMemo, useRef } from 'react';
import { useRecoilState } from 'recoil';
import { setDefaultMessagesHost } from '@librechat/chat/react';
import type {
  ForkEvents,
  MessageCopy,
  MessagesHost,
  MessageCopyInput,
  ForkPreferences,
  ForkConversation,
} from '@librechat/chat/react';
import {
  hasCopyableText,
  useNavigateToConvo,
  getMessageClipboardSource,
  useCopyMessageToClipboard,
} from '~/hooks';
import Files from '~/components/Chat/Messages/Content/Files';
import { useForkConvoMutation } from '~/data-provider';
import useClockFormat from '~/hooks/useClockFormat';
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

/** What the message list reads from the app: the viewer's clock format and fork defaults, the
 *  fork request, the rich-text copy, and the row pieces that still live here. Registered as the default when this
 *  module loads, so rows read it on every route, the shared view included. */
export const appMessagesHost: MessagesHost = {
  useHour12: useClockFormat,
  renderFiles: (message) => <Files message={message} />,
  useForkPreferences: useAppForkPreferences,
  useForkConversation: useAppForkConversation,
  useMessageCopy: useAppMessageCopy,
};

setDefaultMessagesHost(appMessagesHost);
