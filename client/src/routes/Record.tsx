import { useRecoilValue } from 'recoil';
import { useMatch } from 'react-router-dom';
import { Constants } from 'librechat-data-provider';
import { useGetConvoIdQuery } from '~/data-provider';
import { useAuthContext } from '~/hooks';
import store from '~/store';

/** Starts the routed record before sidebar and tool queries; ChatRoute shares its cache. */
export default function ChatRecord() {
  const match = useMatch('/c/:conversationId');
  const id = match?.params.conversationId ?? '';
  const currentId = useRecoilValue(store.conversationIdByIndex(0));
  const { isAuthenticated } = useAuthContext();
  useGetConvoIdQuery(id, {
    enabled:
      isAuthenticated &&
      !!id &&
      id !== Constants.NEW_CONVO &&
      id !== Constants.SEARCH &&
      currentId !== id,
  });
  return null;
}
