import { useCallback } from 'react';
import { useSetRecoilState, useRecoilValue } from 'recoil';
import { isAssistantsEndpoint } from 'librechat-data-provider';

import type { TConversation } from 'librechat-data-provider';

import { useGetConversation } from '~/hooks';
import { mainTextareaId } from '~/common';
import store from '~/store';

export type UseMultiConvoResult = {
  /** Assistants render their own comparison surface, so the action is hidden there. */
  show: boolean;
  addConversation: () => void;
};

/** Clones the current conversation into the second pane for side-by-side comparison. */
export default function useMultiConvo(): UseMultiConvoResult {
  const getConversation = useGetConversation(0);
  const endpoint = useRecoilValue(store.conversationEndpointByIndex(0));
  const setAddedConvo = useSetRecoilState(store.conversationByIndex(1));

  const addConversation = useCallback(() => {
    const conversation = getConversation();
    const { title: _title, ...convo } = conversation ?? ({} as TConversation);
    setAddedConvo({ ...convo, title: '' } as TConversation);
    document.getElementById(mainTextareaId)?.focus();
  }, [getConversation, setAddedConvo]);

  return {
    show: endpoint != null && !isAssistantsEndpoint(endpoint),
    addConversation,
  };
}
