import { useEffect, useCallback, useRef, useState } from 'react';
import isEqual from 'lodash/isEqual';
import { useRecoilValue } from 'recoil';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  QueryKeys,
  parseConvo,
  EModelEndpoint,
  PermissionBits,
  getDefaultParamsEndpoint,
} from 'librechat-data-provider';
import type {
  AgentListResponse,
  TEndpointsConfig,
  TStartupConfig,
  TPreset,
} from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import {
  clearModelForNonEphemeralAgent,
  removeUnavailableTools,
  specDisplayFieldReset,
  processValidSettings,
  getModelSpecIconURL,
  getConvoSwitchLogic,
  logger,
} from '~/utils';
import { useAuthContext, useAgentsMap, useDefaultConvo, useSubmitMessage } from '~/hooks';
import { startupConfigKey, useGetAgentByIdQuery } from '~/data-provider';
import { useChatContext, useChatFormContext } from '~/Providers';
import store from '~/store';

const PROJECT_ID_SEARCH_PARAM = 'projectId';

const injectAgentIntoAgentsMap = (
  queryClient: QueryClient,
  agent: AgentListResponse['data'][number],
) => {
  const editCacheKey = [QueryKeys.agents, { requiredPermission: PermissionBits.EDIT }];
  const editCache = queryClient.getQueryData<AgentListResponse>(editCacheKey);

  if (editCache?.data && !editCache.data.some((cachedAgent) => cachedAgent.id === agent.id)) {
    // Inject agent into EDIT cache so dropdown can display it
    const updatedCache = {
      ...editCache,
      data: [agent, ...editCache.data],
    };
    queryClient.setQueryData(editCacheKey, updatedCache);
    logger.log('agent', 'Injected URL agent into cache:', agent);
  }
};

/** Stages URL prompts, then auto-submits once normalized conversation settings match. */
export default function useQueryParams({
  textAreaRef,
}: {
  textAreaRef: React.RefObject<HTMLTextAreaElement>;
}) {
  const maxAttempts = 50;
  const attemptsRef = useRef(0);
  const MAX_SETTINGS_WAIT_MS = 3000;
  const processedRef = useRef(false);
  const pendingSubmitRef = useRef(false);
  const submissionHandledRef = useRef(false);
  const promptTextRef = useRef<string | null>(null);
  const validSettingsRef = useRef<TPreset | null>(null);
  const settingsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [submissionStatus, setSubmissionStatus] = useState<'idle' | 'preparing' | 'failed'>('idle');

  const methods = useChatFormContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const getDefaultConversation = useDefaultConvo();
  const modularChat = useRecoilValue(store.modularChat);
  const availableTools = useRecoilValue(store.availableTools);
  const { submitMessage } = useSubmitMessage();

  const queryClient = useQueryClient();
  const { conversation, newConversation } = useChatContext();

  const urlAgentId = searchParams.get('agent_id') || '';
  const { data: urlAgent } = useGetAgentByIdQuery(urlAgentId);

  const getPreservedSearchParams = useCallback(() => {
    const preservedParams = new URLSearchParams();
    const projectId = searchParams.get(PROJECT_ID_SEARCH_PARAM);
    if (projectId) {
      preservedParams.set(PROJECT_ID_SEARCH_PARAM, projectId);
    }
    return preservedParams;
  }, [searchParams]);

  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;

  const areSettingsApplied = useCallback(() => {
    const convo = conversationRef.current;
    if (!validSettingsRef.current || !convo) {
      return false;
    }

    const normalizedSettings = convo.endpoint
      ? parseConvo({
          endpoint: convo.endpoint,
          endpointType: convo.endpointType,
          conversation: validSettingsRef.current,
          defaultParamsEndpoint: getDefaultParamsEndpoint(
            queryClient.getQueryData<TEndpointsConfig>([QueryKeys.endpoints]) ?? {},
            convo.endpoint,
          ),
        })
      : validSettingsRef.current;

    for (const [key, value] of Object.entries(validSettingsRef.current)) {
      if (['presetOverride', 'iconURL', 'modelLabel'].includes(key)) {
        continue;
      }

      const expectedValue =
        key === 'endpoint' || key === 'endpointType' ? value : normalizedSettings?.[key];
      if (!isEqual(convo[key], expectedValue)) {
        return false;
      }
    }

    return true;
  }, [queryClient]);

  /**
   * Applies settings from URL query parameters to create a new conversation.
   * Handles model spec lookup, endpoint normalization, and conversation switching logic.
   * Ensures tools compatibility and preserves existing conversation when appropriate.
   */
  const newQueryConvo = useCallback(
    (_newPreset?: TPreset) => {
      if (!_newPreset) {
        return;
      }
      let newPreset = removeUnavailableTools(_newPreset, availableTools);
      if (newPreset.spec != null && newPreset.spec !== '') {
        const startupConfig = queryClient.getQueryData<TStartupConfig>(startupConfigKey(true));
        const modelSpecs = startupConfig?.modelSpecs?.list ?? [];
        const spec = modelSpecs.find((s) => s.name === newPreset.spec);
        if (spec) {
          newPreset = {
            ...spec.preset,
            iconURL: getModelSpecIconURL(spec),
            spec: spec.name,
          } as TPreset;
        }
        /** Hidden specs remain opaque here and are resolved server-side by name. */
      }

      let newEndpoint = newPreset.endpoint ?? '';
      const endpointsConfig = queryClient.getQueryData<TEndpointsConfig>([QueryKeys.endpoints]);

      if (newEndpoint && endpointsConfig && !endpointsConfig[newEndpoint]) {
        const normalizedNewEndpoint = newEndpoint.toLowerCase();
        for (const [key, value] of Object.entries(endpointsConfig)) {
          if (
            value &&
            value.type === EModelEndpoint.custom &&
            key.toLowerCase() === normalizedNewEndpoint
          ) {
            newEndpoint = key;
            newPreset.endpoint = key;
            newPreset.endpointType = EModelEndpoint.custom;
            break;
          }
        }
      }

      clearModelForNonEphemeralAgent(newPreset);
      validSettingsRef.current = newPreset;
      if (areSettingsApplied()) {
        return true;
      }

      const {
        template,
        shouldSwitch,
        isNewModular,
        newEndpointType,
        isCurrentModular,
        isExistingConversation,
      } = getConvoSwitchLogic({
        newEndpoint,
        modularChat,
        conversation,
        endpointsConfig,
      });

      const resetFields = newPreset.spec == null ? specDisplayFieldReset : {};
      if (newPreset.spec == null) {
        Object.assign(template, specDisplayFieldReset);
        newPreset = { ...newPreset, ...specDisplayFieldReset };
      }

      // Sync agent_id from newPreset to template, then clear model if non-ephemeral agent
      if (newPreset.agent_id) {
        template.agent_id = newPreset.agent_id;
      }
      clearModelForNonEphemeralAgent(template);

      const isModular = isCurrentModular && isNewModular && shouldSwitch;
      if (isExistingConversation && isModular) {
        template.endpointType = newEndpointType as EModelEndpoint | undefined;

        const currentConvo = getDefaultConversation({
          /* target endpointType is necessary to avoid endpoint mixing */
          conversation: {
            ...(conversation ?? {}),
            endpointType: template.endpointType,
            ...resetFields,
          },
          preset: template,
          cleanOutput: newPreset.spec != null && newPreset.spec !== '',
        });

        /* We don't reset the latest message, only when changing settings mid-converstion */
        logger.log('conversation', 'Switching conversation from query params', currentConvo);
        newConversation({
          template: currentConvo,
          preset: newPreset,
          keepAddedConvos: true,
          keepComposerState: true,
        });
        return true;
      }

      newConversation({
        template: {
          chatProjectId: conversation?.chatProjectId ?? null,
          ...(newPreset.agent_id ? { agent_id: newPreset.agent_id } : {}),
        },
        preset: newPreset,
        keepAddedConvos: true,
        keepComposerState: true,
      });
      return true;
    },
    [
      areSettingsApplied,
      queryClient,
      modularChat,
      conversation,
      availableTools,
      newConversation,
      getDefaultConversation,
    ],
  );

  const restoreUrlPrompt = useCallback(() => {
    const prompt = promptTextRef.current;
    if (prompt != null && methods.getValues('text') !== prompt) {
      methods.setValue('text', prompt, { shouldValidate: true });
    }
  }, [methods]);

  /** Consumes an auto-submit once, leaving a refused submission in the composer. */
  const processSubmission = useCallback(() => {
    if (submissionHandledRef.current || !pendingSubmitRef.current || !promptTextRef.current) {
      return;
    }

    submissionHandledRef.current = true;
    pendingSubmitRef.current = false;

    setSubmissionStatus('idle');
    if (settingsTimeoutRef.current) {
      clearTimeout(settingsTimeoutRef.current);
      settingsTimeoutRef.current = null;
    }

    restoreUrlPrompt();
    methods.handleSubmit((data) => {
      if (data.text?.trim()) {
        submitMessage(data);
        logger.log('conversation', 'Message submitted from query params');
      }
    })();

    setSearchParams(getPreservedSearchParams(), { replace: true });
  }, [methods, submitMessage, setSearchParams, getPreservedSearchParams, restoreUrlPrompt]);

  useEffect(() => {
    const processQueryParams = () => {
      const queryParams: Record<string, string> = {};
      searchParams.forEach((value, key) => {
        queryParams[key] = value;
      });

      // Support both 'prompt' and 'q' as query parameters, with 'prompt' taking precedence
      const decodedPrompt = queryParams.prompt || queryParams.q || '';
      const shouldAutoSubmit = queryParams.submit?.toLowerCase() === 'true';
      delete queryParams.prompt;
      delete queryParams.q;
      delete queryParams.submit;
      delete queryParams[PROJECT_ID_SEARCH_PARAM];
      const validSettings = processValidSettings(queryParams);

      return { decodedPrompt, validSettings, shouldAutoSubmit };
    };

    const intervalId = setInterval(() => {
      if (processedRef.current || attemptsRef.current >= maxAttempts) {
        clearInterval(intervalId);
        if (attemptsRef.current >= maxAttempts) {
          console.warn('Max attempts reached, failed to process parameters');
        }
        return;
      }

      attemptsRef.current += 1;

      if (!textAreaRef.current) {
        return;
      }
      const { decodedPrompt, validSettings, shouldAutoSubmit } = processQueryParams();
      if (decodedPrompt && promptTextRef.current == null) {
        promptTextRef.current = decodedPrompt;
        methods.setValue('text', decodedPrompt, { shouldValidate: true });
        textAreaRef.current.focus();
        textAreaRef.current.setSelectionRange(decodedPrompt.length, decodedPrompt.length);
      }

      const startupConfig = queryClient.getQueryData<TStartupConfig>(startupConfigKey(true));
      if (!startupConfig) {
        return;
      }
      const hasSettings = Object.keys(validSettings).length > 0;

      const autoSubmitAllowed = startupConfig.interface?.autoSubmitFromUrl !== false;
      const willAutoSubmit = shouldAutoSubmit && autoSubmitAllowed;

      if (!willAutoSubmit) {
        submissionHandledRef.current = true;
      }

      /** Mark processing as complete and clean up as needed */
      const success = () => {
        processedRef.current = true;
        logger.log('conversation', 'Query parameters processed successfully');
        clearInterval(intervalId);

        // Defer URL cleanup until after submission completes (processSubmission handles it)
        if (!pendingSubmitRef.current) {
          setSearchParams(getPreservedSearchParams(), { replace: true });
        }
      };

      const settingsAccepted = !hasSettings || newQueryConvo(validSettings) === true;
      if (willAutoSubmit && decodedPrompt.trim()) {
        pendingSubmitRef.current = true;
        if (!settingsAccepted) {
          pendingSubmitRef.current = false;
          submissionHandledRef.current = true;
          setSubmissionStatus('failed');
        } else if (!hasSettings || areSettingsApplied()) {
          processSubmission();
        } else {
          setSubmissionStatus('preparing');
          settingsTimeoutRef.current = setTimeout(() => {
            settingsTimeoutRef.current = null;
            if (!submissionHandledRef.current && pendingSubmitRef.current) {
              restoreUrlPrompt();
              pendingSubmitRef.current = false;
              submissionHandledRef.current = true;
              setSubmissionStatus('failed');
              logger.log('conversation', 'Settings application timeout, retaining prompt');
              setSearchParams(getPreservedSearchParams(), { replace: true });
            }
          }, MAX_SETTINGS_WAIT_MS);
        }
      } else {
        submissionHandledRef.current = true;
      }

      success();
    }, 100);

    return () => {
      clearInterval(intervalId);
    };
  }, [
    searchParams,
    methods,
    textAreaRef,
    newQueryConvo,
    newConversation,
    submitMessage,
    setSearchParams,
    getPreservedSearchParams,
    queryClient,
    processSubmission,
    areSettingsApplied,
    restoreUrlPrompt,
  ]);

  useEffect(() => {
    // Only proceed if we've already processed URL parameters but haven't yet handled submission
    if (
      !processedRef.current ||
      submissionHandledRef.current ||
      !pendingSubmitRef.current ||
      !validSettingsRef.current ||
      !conversation
    ) {
      return;
    }

    restoreUrlPrompt();
    if (areSettingsApplied()) {
      logger.log('conversation', 'Settings fully applied, processing submission');
      processSubmission();
    }
  }, [conversation, processSubmission, areSettingsApplied, restoreUrlPrompt]);

  useEffect(
    () => () => {
      if (settingsTimeoutRef.current) {
        clearTimeout(settingsTimeoutRef.current);
      }
    },
    [],
  );

  const { isAuthenticated } = useAuthContext();
  const agentsMap = useAgentsMap({ isAuthenticated });
  useEffect(() => {
    if (urlAgent) {
      injectAgentIntoAgentsMap(queryClient, urlAgent);
    }
  }, [urlAgent, queryClient, agentsMap]);

  const clearSettingsError = useCallback(() => setSubmissionStatus('idle'), []);

  return {
    clearSettingsError,
    isPreparing: submissionStatus === 'preparing',
    settingsError: submissionStatus === 'failed',
  };
}
