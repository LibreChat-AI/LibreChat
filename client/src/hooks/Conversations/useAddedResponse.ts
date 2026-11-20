import { useCallback, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { useQueryClient } from '@tanstack/react-query';
import {
  QueryKeys,
  getEndpointField,
  isAssistantsEndpoint,
  getDefaultParamsEndpoint,
} from 'librechat-data-provider';
import type {
  TEndpointsConfig,
  TModelsConfig,
  EModelEndpoint,
  TConversation,
} from 'librechat-data-provider';
import type { AddedChatContract } from '~/hooks/Chat/contract';
import type { NewConversationParams } from '~/common';
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
  const queryClient = useQueryClient();
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

      if (!isAssistantsEndpoint(defaultEndpoint)) {
        newConversation.assistant_id = undefined;
      }
      const models =
        modelsData?.[defaultEndpoint ?? ''] ??
        queryClient.getQueryData<TModelsConfig>([QueryKeys.models, defaultEndpoint])?.[
          defaultEndpoint ?? ''
        ];
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
    [endpointsConfig, setConversation, queryClient, rootConvo?.conversationId],
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
