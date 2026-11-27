import { useRef, useCallback } from 'react';
import { useRecoilValue } from 'recoil';
import { useParams } from 'react-router-dom';
import { Constants } from 'librechat-data-provider';
import store from '~/store';

/**
 * Reads which conversation the main pane shows at the moment it is called, for work that settles
 * after the click that started it and must compare against whichever chat is open by then.
 *
 * The route names that conversation, except at `/c/new`: a new chat's first turn renames the
 * address without the router, so the route keeps reading `new` while the chat already carries its
 * own id. An unsent chat still carries `new`, which no saved conversation matches. The sidebar
 * marks its open row by the same rule.
 */
export default function useOpenConversationId(): () => string | undefined {
  const { conversationId: route } = useParams();
  const chatId = useRecoilValue(store.conversationIdByIndex(0));
  const openRef = useRef<string | undefined>(undefined);
  openRef.current = route === Constants.NEW_CONVO ? (chatId ?? undefined) : route;
  return useCallback(() => openRef.current, []);
}
