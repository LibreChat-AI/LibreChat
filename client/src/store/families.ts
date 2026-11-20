import { useEffect } from 'react';
import { createSearchParams } from 'react-router-dom';
import { LocalStorageKeys, isEphemeralAgentId, Constants } from 'librechat-data-provider';
import {
  atom,
  atomFamily,
  DefaultValue,
  selectorFamily,
  useRecoilValue,
  useSetRecoilState,
  useRecoilCallback,
} from 'recoil';
import type { EModelEndpoint, TConversation } from 'librechat-data-provider';
import {
  clearModelForNonEphemeralAgent,
  createChatSearchParams,
  storeEndpointSettings,
  logger,
} from '~/utils';
import { useSetConvoContext } from '~/Providers/SetConvoContext';

const conversationByIndex = atomFamily<TConversation | null, string | number>({
  key: 'conversationByIndex',
  default: null,
  effects: [
    ({ onSet, node }) => {
      onSet(async (newValue, oldValue) => {
        const index = Number(node.key.split('__')[1]);
        logger.log('conversation', 'Setting conversation:', {
          index,
          newValue,
          oldValue,
        });
        if (newValue?.assistant_id != null && newValue.assistant_id) {
          localStorage.setItem(
            `${LocalStorageKeys.ASST_ID_PREFIX}${index}${newValue.endpoint}`,
            newValue.assistant_id,
          );
        }
        if (newValue?.agent_id != null && !isEphemeralAgentId(newValue.agent_id)) {
          localStorage.setItem(`${LocalStorageKeys.AGENT_ID_PREFIX}${index}`, newValue.agent_id);
        }
        if (newValue?.spec != null && newValue.spec) {
          localStorage.setItem(LocalStorageKeys.LAST_SPEC, newValue.spec);
        }
        if (newValue?.tools && Array.isArray(newValue.tools)) {
          localStorage.setItem(
            LocalStorageKeys.LAST_TOOLS,
            JSON.stringify(newValue.tools.filter((el) => !!el)),
          );
        }

        if (!newValue) {
          return;
        }

        storeEndpointSettings(newValue);

        const convoToStore = { ...newValue };
        clearModelForNonEphemeralAgent(convoToStore);
        localStorage.setItem(
          `${LocalStorageKeys.LAST_CONVO_SETUP}_${index}`,
          JSON.stringify(convoToStore),
        );

        const disableParams = newValue.disableParams === true;
        const shouldUpdateParams =
          index === 0 &&
          !disableParams &&
          newValue.createdAt === '' &&
          JSON.stringify(newValue) !== JSON.stringify(oldValue) &&
          (oldValue as TConversation)?.conversationId === Constants.NEW_CONVO;

        if (shouldUpdateParams) {
          const newParams = createChatSearchParams(newValue);
          if (newValue.chatProjectId) {
            newParams.set('projectId', newValue.chatProjectId);
          }
          const searchParams = createSearchParams(newParams);
          const url = `${window.location.pathname}?${searchParams.toString()}`;
          /** Mirror, not navigation: Back-worthy entries are minted by real
           * `navigate()` calls (useNewConvo), and in-place writers like
           * ProjectLandingChip deliberately replace. Pushing here buried the
           * Back target under one inert entry per draft edit. */
          window.history.replaceState({}, '', url);
        }
      });
    },
  ] as const,
});

const conversationKeysAtom = atom<(string | number)[]>({
  key: 'conversationKeys',
  default: [],
});

const conversationIdByIndex = selectorFamily<string | null, string | number>({
  key: 'conversationIdByIndex',
  get:
    (index: string | number) =>
    ({ get }) =>
      get(conversationByIndex(index))?.conversationId ?? null,
});

const conversationEndpointByIndex = selectorFamily<EModelEndpoint | null, string | number>({
  key: 'conversationEndpointByIndex',
  get:
    (index: string | number) =>
    ({ get }) =>
      get(conversationByIndex(index))?.endpoint ?? null,
});

/** Returns `endpointType ?? endpoint`, matching the effective endpoint used for feature gating. */
const effectiveEndpointByIndex = selectorFamily<EModelEndpoint | null, string | number>({
  key: 'effectiveEndpointByIndex',
  get:
    (index: string | number) =>
    ({ get }) => {
      const convo = get(conversationByIndex(index));
      return convo?.endpointType ?? convo?.endpoint ?? null;
    },
});

const conversationModelByIndex = selectorFamily<string | null, string | number>({
  key: 'conversationModelByIndex',
  get:
    (index: string | number) =>
    ({ get }) =>
      get(conversationByIndex(index))?.model ?? null,
});

const conversationSpecByIndex = selectorFamily<string | null, string | number>({
  key: 'conversationSpecByIndex',
  get:
    (index: string | number) =>
    ({ get }) =>
      get(conversationByIndex(index))?.spec ?? null,
});

const conversationAgentIdByIndex = selectorFamily<string | null, string | number>({
  key: 'conversationAgentIdByIndex',
  get:
    (index: string | number) =>
    ({ get }) =>
      get(conversationByIndex(index))?.agent_id ?? null,
});

const conversationAssistantIdByIndex = selectorFamily<string | null, string | number>({
  key: 'conversationAssistantIdByIndex',
  get:
    (index: string | number) =>
    ({ get }) =>
      get(conversationByIndex(index))?.assistant_id ?? null,
});

const activePromptByIndex = atomFamily<string | undefined, string | number | null>({
  key: 'activePromptByIndex',
  default: undefined,
});

const showMentionPopoverFamily = atomFamily<boolean, string | number | null>({
  key: 'showMentionPopoverByIndex',
  default: false,
});

const showPlusPopoverFamily = atomFamily<boolean, string | number | null>({
  key: 'showPlusPopoverByIndex',
  default: false,
});

const showPromptsPopoverFamily = atomFamily<boolean, string | number | null>({
  key: 'showPromptsPopoverByIndex',
  default: false,
});

/**
 * Text handed to a conversation's composer by a surface the user is leaving —
 * today, a subagent thread continued into a chat of its own, where the panel
 * and its composer unmount as the destination opens.
 *
 * Keyed by conversation rather than by composer index because the handoff
 * outlives the navigation that carries it: a first visit resolves its record
 * before the route moves, so the destination's composer mounts commits later.
 * `useTextarea` drains it when that conversation's composer is on screen.
 *
 * Deliberately in memory rather than in the composer draft store: nothing the
 * user has not sent should be written to storage they asked not to use, and
 * draft restoration is itself gated on the Save Drafts preference.
 */
const pendingComposerTextByConvoId = atomFamily<string | undefined, string>({
  key: 'pendingComposerTextByConvoId',
  default: undefined,
});

const globalAudioURLFamily = atomFamily<string | null, string | number | null>({
  key: 'globalAudioURLByIndex',
  default: null,
});

const globalAudioFetchingFamily = atomFamily<boolean, string | number | null>({
  key: 'globalAudioisFetchingByIndex',
  default: false,
});

const globalAudioPlayingFamily = atomFamily<boolean, string | number | null>({
  key: 'globalAudioisPlayingByIndex',
  default: false,
});

const audioRunFamily = atomFamily<string | null, string | number | null>({
  key: 'audioRunByIndex',
  default: null,
});

/** Setter-only access to the conversation atom: registers the key like
 * `useCreateConversationAtom` but never subscribes to the value, so callers
 * that only write (navigation, per-row actions) don't re-render on every
 * conversation update. */
function useSetConversationAtom(key: string | number) {
  const hasSetConversation = useSetConvoContext();
  const setKeys = useSetRecoilState(conversationKeysAtom);
  const setConversation = useSetRecoilState(conversationByIndex(key));

  useEffect(() => {
    setKeys((prevKeys) => {
      if (prevKeys.includes(key)) {
        return prevKeys;
      }
      return [...prevKeys, key];
    });
  }, [key, setKeys]);

  return { hasSetConversation, setConversation };
}

function useCreateConversationAtom(key: string | number) {
  const { hasSetConversation, setConversation } = useSetConversationAtom(key);
  const conversation = useRecoilValue(conversationByIndex(key));

  return { hasSetConversation, conversation, setConversation };
}

function useClearConvoState() {
  /** Clears all active conversations. Pass `true` to skip the first or root conversation */
  const clearAllConversations = useRecoilCallback(
    ({ reset, snapshot }) =>
      async (skipFirst?: boolean) => {
        const conversationKeys = await snapshot.getPromise(conversationKeysAtom);

        for (const conversationKey of conversationKeys) {
          if (skipFirst === true && conversationKey == 0) {
            continue;
          }

          reset(conversationByIndex(conversationKey));
        }

        reset(conversationKeysAtom);
      },
    [],
  );

  return clearAllConversations;
}

const conversationByKeySelector = conversationByIndex;

const updateConversationSelector = selectorFamily({
  key: 'updateConversationSelector',
  get: () => () => null as Partial<TConversation> | null,
  set:
    (conversationId: string) =>
    ({ set, get }, newPartialConversation) => {
      if (newPartialConversation instanceof DefaultValue) {
        return;
      }

      const keys = get(conversationKeysAtom);
      keys.forEach((key) => {
        set(conversationByIndex(key), (prevConversation) => {
          if (prevConversation && prevConversation.conversationId === conversationId) {
            return {
              ...prevConversation,
              ...newPartialConversation,
            };
          }
          return prevConversation;
        });
      });
    },
});

export default {
  conversationKeysAtom,
  conversationByIndex,
  conversationIdByIndex,
  conversationEndpointByIndex,
  effectiveEndpointByIndex,
  conversationModelByIndex,
  conversationSpecByIndex,
  conversationAgentIdByIndex,
  conversationAssistantIdByIndex,
  conversationByKeySelector,
  useClearConvoState,
  useCreateConversationAtom,
  useSetConversationAtom,
  showMentionPopoverFamily,
  globalAudioURLFamily,
  audioRunFamily,
  globalAudioPlayingFamily,
  globalAudioFetchingFamily,
  showPlusPopoverFamily,
  activePromptByIndex,
  showPromptsPopoverFamily,
  pendingComposerTextByConvoId,
  updateConversationSelector,
};
