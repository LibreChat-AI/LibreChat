import { useRecoilCallback } from 'recoil';
import { useMatch } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Constants, QueryKeys } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import ToggleSwitch from '../ToggleSwitch';
import { setDocumentTitle } from '~/utils';
import store from '~/store';

export default function ChatTitleInTab() {
  const queryClient = useQueryClient();
  const conversationId = useMatch('/c/:conversationId')?.params.conversationId;

  const handleCheckedChange = useRecoilCallback(
    ({ snapshot }) =>
      (value: boolean) => {
        if (!conversationId) {
          return;
        }

        const cachedConversation = queryClient.getQueryData<TConversation>([
          QueryKeys.conversation,
          conversationId,
        ]);
        const recoilConversation = snapshot.getLoadable(store.conversationByIndex(0)).getValue();
        const conversation =
          cachedConversation ??
          (recoilConversation?.conversationId === conversationId ? recoilConversation : undefined);

        setDocumentTitle(
          conversationId === Constants.NEW_CONVO ? undefined : conversation?.title,
          value,
        );
      },
    [conversationId, queryClient],
  );

  return (
    <ToggleSwitch
      stateAtom={store.chatTitleInTab}
      localizationKey="com_nav_chat_title_in_tab"
      switchId="chatTitleInTab"
      onCheckedChange={handleCheckedChange}
    />
  );
}
