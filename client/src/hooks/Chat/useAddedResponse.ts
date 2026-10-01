import { useCallback, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import {
  getEndpointField,
  LocalStorageKeys,
  isAssistantsEndpoint,
  getDefaultParamsEndpoint,
} from 'librechat-data-provider';
import type { TEndpointsConfig, EModelEndpoint, TConversation } from 'librechat-data-provider';
import type { AssistantListItem, NewConversationParams } from '~/common';
import type { AddedChatContract } from './contract';
import useAssistantListMap from '~/hooks/Assistants/useAssistantListMap';
import { buildDefaultConvo, getDefaultEndpoint } from '~/utils';
import { useGetEndpointsQuery } from '~/data-provider';
import { mainTextareaId } from '~/common';
import store from '~/store';

const ADDED_INDEX = 1;

/**
 * Simplified hook for added conversation state.
 * Provides just the conversation state and a function to generate a new conversation,
 * mirroring the pattern from useNewConvo.
 */
export default function useAddedResponse(): AddedChatContract {
  const modelsQuery = useGetModelsQuery();
  const assistantsListMap = useAssistantListMap();
  const rootConvo = useRecoilValue(store.conversationByKeySelector(0));
  const { data: endpointsConfig = {} as TEndpointsConfig } = useGetEndpointsQuery();
  const { conversation, setConversation } = store.useCreateConversationAtom(ADDED_INDEX);

  /**
   * Generate a new conversation based on template and preset.
   * Mirrors the logic from useNewConvo's switchToConversation.
   */
  const generateConversation = useCallback(
    ({ template = {}, preset, modelsData }: NewConversationParams = {}) => {
      let newConversation: TConversation = {
        conversationId: rootConvo?.conversationId ?? 'new',
        title: '',
        endpoint: null,
        ...template,
        createdAt: '',
        updatedAt: '',
      } as TConversation;

      const modelsConfig = modelsData ?? modelsQuery.data;
      const activePreset = preset ?? newConversation;

      const defaultEndpoint = getDefaultEndpoint({
        convoSetup: activePreset,
        endpointsConfig,
      });

      const endpointType = getEndpointField(endpointsConfig, defaultEndpoint, 'type');
      if (!newConversation.endpointType && endpointType) {
        newConversation.endpointType = endpointType;
      } else if (newConversation.endpointType && !endpointType) {
        newConversation.endpointType = undefined;
      }

      const isAssistantEndpoint = isAssistantsEndpoint(defaultEndpoint);
      const assistants: AssistantListItem[] = assistantsListMap[defaultEndpoint ?? ''] ?? [];

      if (
        newConversation.assistant_id &&
        !assistantsListMap[defaultEndpoint ?? '']?.[newConversation.assistant_id]
      ) {
        newConversation.assistant_id = undefined;
      }

      if (!newConversation.assistant_id && isAssistantEndpoint) {
        newConversation.assistant_id =
          localStorage.getItem(`${LocalStorageKeys.ASST_ID_PREFIX}0${defaultEndpoint}`) ??
          assistants[0]?.id;
      }

      if (
        newConversation.assistant_id != null &&
        isAssistantEndpoint &&
        newConversation.conversationId === 'new'
      ) {
        const assistant = assistants.find((asst) => asst.id === newConversation.assistant_id);
        newConversation.model = assistant?.model;
      }

      if (newConversation.assistant_id != null && !isAssistantEndpoint) {
        newConversation.assistant_id = undefined;
      }

      const models = modelsConfig?.[defaultEndpoint ?? ''] ?? [];
      const defaultParamsEndpoint = getDefaultParamsEndpoint(endpointsConfig, defaultEndpoint);
      newConversation = buildDefaultConvo({
        conversation: newConversation,
        lastConversationSetup: preset as TConversation,
        endpoint: defaultEndpoint ?? ('' as EModelEndpoint),
        models,
        defaultParamsEndpoint,
      });

      if (preset?.title != null && preset.title !== '') {
        newConversation.title = preset.title;
      }

      setConversation(newConversation);

      setTimeout(() => {
        const textarea = document.getElementById(mainTextareaId);
        if (textarea) {
          textarea.focus();
        }
      }, 150);

      return newConversation;
    },
    [
      endpointsConfig,
      setConversation,
      modelsQuery.data,
      assistantsListMap,
      rootConvo?.conversationId,
    ],
  );

  return useMemo(
    (): AddedChatContract => ({
      conversation,
      setConversation,
      generateConversation,
    }),
    [conversation, setConversation, generateConversation],
  );
}
