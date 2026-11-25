import { useRecoilValue } from 'recoil';
import { useMatch } from 'react-router-dom';
import { Constants } from 'librechat-data-provider';
import { useGetConvoIdQuery, usePrefetchConversationMessages } from '~/data-provider';
import { useAuthContext } from '~/hooks';
import store from '~/store';

/** Starts routed history before sidebar and tool queries; ChatRoute shares its cache. */
export default function ChatRecord() {
  const match = useMatch('/c/:conversationId');
  const id = match?.params.conversationId ?? '';
  const currentId = useRecoilValue(store.conversationIdByIndex(0));
  const { isAuthenticated } = useAuthContext();
  const enabled =
    isAuthenticated &&
    !!id &&
    id !== Constants.NEW_CONVO &&
    id !== Constants.SEARCH &&
    currentId !== id;
  useGetConvoIdQuery(id, { enabled });
  usePrefetchConversationMessages(id, enabled);
  return null;
}
