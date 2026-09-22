import { useStore } from 'jotai';
import { useRecoilCallback } from 'recoil';
import {
  getReasoningStateKey,
  pendingReasoningOverrideFamily,
  removePendingReasoningOverride,
} from '~/components/Chat/Input/Composer/state';
import { siblingIdxFamily, siblingKey } from '~/components/Chat/Messages/Thread/state';
import { showFilesDialogAtom, filesDialogTriggerAtom } from '~/store/filesDialog';
import { showSkillsPopoverFamily } from '~/components/Chat/Input/skillsState';
import { clearLocalStorage } from '~/utils/localStorage';
import store from '~/store';

export default function useClearStates() {
  const clearConversations = store.useClearConvoState();
  const clearSubmissions = store.useClearSubmissionState();
  const jotaiStore = useStore();

  const clearStates = useRecoilCallback(
    ({ reset, snapshot }) =>
      async (skipFirst?: boolean) => {
        await clearSubmissions(skipFirst);
        await clearConversations(skipFirst);
        /* Jotai's default store outlives the authenticated route: left alone, a
           file manager open at logout reopens for the next session, still
           holding the previous session's unmounted opener. */
        jotaiStore.set(showFilesDialogAtom, false);
        jotaiStore.set(filesDialogTriggerAtom, null);

        const keys = await snapshot.getPromise(store.conversationKeysAtom);

        for (const key of keys) {
          if (skipFirst === true && key === 0) {
            continue;
          }

          reset(store.filesByIndex(key));
          reset(store.presetByIndex(key));
          reset(store.textByIndex(key));
          reset(store.showStopButtonByIndex(key));
          reset(store.abortScrollFamily(key));
          reset(store.isSubmittingFamily(key));
          reset(store.optionSettingsFamily(key));
          reset(store.showPopoverFamily(key));
          reset(store.showMentionPopoverFamily(key));
          reset(store.showPlusPopoverFamily(key));
          reset(store.showPromptsPopoverFamily(key));
          jotaiStore.set(showSkillsPopoverFamily(key), false);
          reset(store.pendingManualSkillsByConvoId(key.toString()));
          reset(store.pendingQuotesByConvoId(key.toString()));
          const newConversationKey = getReasoningStateKey(null, key);
          jotaiStore.set(pendingReasoningOverrideFamily(newConversationKey), undefined);
          removePendingReasoningOverride(newConversationKey);
          /**
           * Pending skill/quote queues are keyed by the conversation id the
           * composer wrote under, not this UI index — also clear by the resolved
           * id so queued-but-unsent selections don't linger in Recoil.
           */
          const convoId = (await snapshot.getPromise(store.conversationByIndex(key)))
            ?.conversationId;
          if (convoId != null) {
            reset(store.pendingManualSkillsByConvoId(convoId));
            reset(store.pendingQuotesByConvoId(convoId));
            const reasoningStateKey = getReasoningStateKey(convoId, key);
            jotaiStore.set(pendingReasoningOverrideFamily(reasoningStateKey), undefined);
            removePendingReasoningOverride(reasoningStateKey);
          }
          reset(store.activePromptByIndex(key));
          reset(store.globalAudioURLFamily(key));
          reset(store.globalAudioFetchingFamily(key));
          reset(store.globalAudioPlayingFamily(key));
          reset(store.activeRunFamily(key));
          reset(store.audioRunFamily(key));
          jotaiStore.set(siblingIdxFamily(siblingKey(key.toString())), 0);
        }

        clearLocalStorage(skipFirst);
      },
    [clearConversations, clearSubmissions, jotaiStore],
  );

  return clearStates;
}
