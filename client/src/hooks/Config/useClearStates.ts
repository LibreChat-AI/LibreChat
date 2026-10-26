import { useStore } from 'jotai';
import { useRecoilCallback } from 'recoil';
import { Constants } from 'librechat-data-provider';
import {
  getReasoningStateKey,
  clearPendingComposerContext,
  clearPendingReasoningOverrides,
  filesFamily,
  presetFamily,
  abortScrollFamily,
  isSubmittingFamily,
  optionSettingsFamily,
  showStopButtonByIndex,
  submissionStartFamily,
  useClearSubmissions,
} from '@librechat/chat/react';
import { siblingIdxFamily, siblingKey } from '~/components/Chat/Messages/Thread/state';
import { showFilesDialogAtom, filesDialogTriggerAtom } from '~/store/filesDialog';
import { showSkillsPopoverFamily } from '~/components/Chat/Input/skillsState';
import { clearLocalStorage } from '~/utils/localStorage';
import { activeRunFamily } from '~/hooks/SSE/atoms';
import store from '~/store';

export default function useClearStates() {
  const clearConversations = store.useClearConvoState();
  const clearSubmissions = useClearSubmissions();
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
        const keptReasoningKeys = new Set<string>();
        const keptContextKeys = new Set<string>();
        if (skipFirst === true) {
          const firstConvoId = (await snapshot.getPromise(store.conversationByIndex(0)))
            ?.conversationId;
          keptReasoningKeys.add(getReasoningStateKey(null, 0));
          keptReasoningKeys.add(getReasoningStateKey(firstConvoId, 0));
          keptContextKeys.add('0');
          keptContextKeys.add(firstConvoId ?? Constants.NEW_CONVO);
        }
        clearPendingReasoningOverrides(jotaiStore, keptReasoningKeys);
        /* Staged quotes and skill picks are keyed by every conversation the
           composer has visited, not only the panes mounted now: sweep them all
           so none reaches the next session's composer. */
        clearPendingComposerContext(jotaiStore, keptContextKeys);

        for (const key of keys) {
          if (skipFirst === true && key === 0) {
            continue;
          }

          jotaiStore.set(filesFamily(key), new Map());
          jotaiStore.set(presetFamily(key), null);
          jotaiStore.set(showStopButtonByIndex(key), false);
          jotaiStore.set(abortScrollFamily(key), false);
          jotaiStore.set(submissionStartFamily(key), null);
          jotaiStore.set(isSubmittingFamily(key), false);
          jotaiStore.set(optionSettingsFamily(key), {});
          reset(store.showMentionPopoverFamily(key));
          reset(store.showPlusPopoverFamily(key));
          reset(store.showPromptsPopoverFamily(key));
          jotaiStore.set(showSkillsPopoverFamily(key), false);
          reset(store.activePromptByIndex(key));
          reset(store.globalAudioURLFamily(key));
          reset(store.globalAudioFetchingFamily(key));
          reset(store.globalAudioPlayingFamily(key));
          jotaiStore.set(activeRunFamily(key), null);
          reset(store.audioRunFamily(key));
          jotaiStore.set(siblingIdxFamily(siblingKey(key.toString())), 0);
        }

        clearLocalStorage(skipFirst);
      },
    [clearConversations, clearSubmissions, jotaiStore],
  );

  return clearStates;
}
