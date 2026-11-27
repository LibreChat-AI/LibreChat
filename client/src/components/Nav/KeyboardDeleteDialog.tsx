import { useCallback } from 'react';
import { useRecoilState } from 'recoil';
import useOpenConversationId from '~/hooks/Conversations/useOpenConversationId';
import DeleteButton from '~/components/Conversations/ConvoOptions/DeleteButton';
import store from '~/store';

const retainView = () => {};

export default function KeyboardDeleteDialog() {
  const [target, setTarget] = useRecoilState(store.keyboardDeleteTarget);
  /** Outlives the dialog, which can be dismissed while its delete is still in flight. */
  const getOpenConversationId = useOpenConversationId();

  const setShowDeleteDialog = useCallback(
    (open: boolean) => {
      if (!open) {
        setTarget(null);
      }
    },
    [setTarget],
  );

  if (!target) {
    return null;
  }

  return (
    <DeleteButton
      title={target.title}
      conversationId={target.conversationId}
      getCurrentConversationId={getOpenConversationId}
      retainView={retainView}
      showDeleteDialog={true}
      setShowDeleteDialog={setShowDeleteDialog}
    />
  );
}
