import { useCallback } from 'react';
import { useRecoilState } from 'recoil';
import DeleteButton from '~/components/Conversations/ConvoOptions/DeleteButton';
import store from '~/store';

const retainView = () => {};

export default function KeyboardDeleteDialog() {
  const [target, setTarget] = useRecoilState(store.keyboardDeleteTarget);

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
      currentConversationId={target.conversationId}
      retainView={retainView}
      showDeleteDialog={true}
      setShowDeleteDialog={setShowDeleteDialog}
    />
  );
}
