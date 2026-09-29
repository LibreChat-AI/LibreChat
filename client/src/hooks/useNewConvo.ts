import { useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import { useRecoilState, useRecoilValue, useSetRecoilState, useRecoilCallback } from 'recoil';
import {
  Constants,
  FileSources,
  Permissions,
  EModelEndpoint,
  isParamEndpoint,
  PermissionTypes,
  getEndpointField,
  isAgentsEndpoint,
  LocalStorageKeys,
  isEphemeralAgentId,
  isAssistantsEndpoint,
  getDefaultParamsEndpoint,
} from 'librechat-data-provider';
import type {
  TPreset,
  TSubmission,
  TModelsConfig,
  TConversation,
  TEndpointsConfig,
} from 'librechat-data-provider';
import type { AssistantListItem } from '~/common';
import {
  updateLastSelectedModel,
  getLocalStorageItems,
  getDefaultModelSpec,
  getDefaultEndpoint,
  getModelSpecPreset,
  hasModelSelection,
  buildDefaultConvo,
  requestChatFocus,
  renewNewConversationDraftToken,
  getNewConversationDraftId,
  getPendingDraftId,
  isPastedTextFileMarked,
  loadPendingDiscardIds,
  storePendingDiscardIds,
  removeTabAttachmentPresence,
  collectForeignAttachmentClaims,
  scheduleRetainedFileDeletionRetry,
  retainFileDeletion,
  failedFileIdsFrom,
  logger,
} from '~/utils';
import { useDeleteFilesMutation, useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import { supersedeNavigation } from './Conversations/useNavigateToConvo';
import useGetConversation from './Conversations/useGetConversation';
import useAssistantListMap from './Assistants/useAssistantListMap';
import { clearUploadRecovery } from './Files/useFileHandling';
import { useResetChatBadges } from './useChatBadges';
import { useApplyModelSpecEffects } from './Agents';
import { useAgentsMapContext } from '~/Providers';
import { usePauseGlobalAudio } from './Audio';
import { useHasAccess } from '~/hooks';
import store from '~/store';

export function clearInheritedAgentWorkspace(
  conversation: TConversation,
  previousConversation?: TConversation | null,
): TConversation {
  const startsNewAgentConversation =
    conversation.conversationId === Constants.NEW_CONVO &&
    conversation.agent_id != null &&
    conversation.agent_id !== previousConversation?.agent_id;

  return startsNewAgentConversation
    ? { ...conversation, codeEnvironmentMode: undefined, codeWorkspaces: undefined }
    : conversation;
}

const useNewConvo = (index = 0) => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { data: startupConfig } = useGetStartupConfig();
  const getConversation = useGetConversation(index);
  const applyModelSpecEffects = useApplyModelSpecEffects();
  const clearAllConversations = store.useClearConvoState();
  const defaultPreset = useRecoilValue(store.defaultPreset);
  const { setConversation } = store.useSetConversationAtom(index);
  const [files, setFiles] = useRecoilState(store.filesByIndex(index));
  const saveBadgesState = useRecoilValue<boolean>(store.saveBadgesState);
  const setSubmission = useSetRecoilState<TSubmission | null>(store.submissionByIndex(index));
  const { data: endpointsConfig = {} as TEndpointsConfig } = useGetEndpointsQuery();
  const agentsMap = useAgentsMapContext();

  const hasAgentAccess = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.USE,
  });

  const modelsQuery = useGetModelsQuery();
  const assistantsListMap = useAssistantListMap();
  const { pauseGlobalAudio } = usePauseGlobalAudio(index);
  const saveDrafts = useRecoilValue<boolean>(store.saveDrafts);
  const resetBadges = useResetChatBadges();

  const { mutateAsync } = useDeleteFilesMutation({
    onSuccess: () => {
      console.log('Files deleted');
    },
    onError: (error) => {
      console.log('Error deleting files:', error);
    },
  });

  const switchToConversation = useRecoilCallback(
    () =>
      async (
        conversation: TConversation,
        preset: Partial<TPreset> | null = null,
        modelsData?: TModelsConfig,
        buildDefault?: boolean,
        keepAddedConvos?: boolean,
        disableFocus?: boolean,
        _disableParams?: boolean,
      ) => {
        const modelsConfig = modelsData ?? modelsQuery.data;
        const { endpoint = null } = conversation;
        const buildDefaultConversation = (endpoint === null || buildDefault) ?? false;
        const hasExplicitChatProjectId = Object.prototype.hasOwnProperty.call(
          conversation,
          'chatProjectId',
        );
        const explicitChatProjectId = conversation.chatProjectId;
        const activePreset =
          // use default preset only when it's defined,
          // preset is not provided,
          // endpoint matches or is null (to allow endpoint change),
          // and buildDefaultConversation is true
          defaultPreset &&
          !preset &&
          (defaultPreset.endpoint === endpoint || !endpoint) &&
          buildDefaultConversation
            ? defaultPreset
            : preset;

        const disableParams =
          _disableParams ??
          (activePreset?.presetId != null &&
            activePreset.presetId &&
            activePreset.presetId === defaultPreset?.presetId);

        if (buildDefaultConversation) {
          let defaultEndpoint = getDefaultEndpoint({
            convoSetup: activePreset ?? conversation,
            endpointsConfig,
          });

          // If the selected endpoint is agents but user doesn't have access, find an alternative
          // Skip this check for existing agent conversations (they have agent_id set)
          // Also check localStorage for new conversations restored after refresh
          const { lastConversationSetup } = getLocalStorageItems();
          const storedAgentId =
            isAgentsEndpoint(lastConversationSetup?.endpoint) && lastConversationSetup?.agent_id;
          const isExistingAgentConvo =
            isAgentsEndpoint(defaultEndpoint) &&
            ((conversation.agent_id && !isEphemeralAgentId(conversation.agent_id)) ||
              (storedAgentId && !isEphemeralAgentId(storedAgentId)));
          if (
            defaultEndpoint &&
            isAgentsEndpoint(defaultEndpoint) &&
            !hasAgentAccess &&
            !isExistingAgentConvo
          ) {
            defaultEndpoint = Object.keys(endpointsConfig ?? {}).find(
              (ep) => !isAgentsEndpoint(ep as EModelEndpoint) && endpointsConfig?.[ep],
            ) as EModelEndpoint | undefined;
          }

          if (!defaultEndpoint) {
            // Find first available endpoint that's not agents (if no access) or any endpoint
            defaultEndpoint = Object.keys(endpointsConfig ?? {}).find((ep) => {
              if (
                isAgentsEndpoint(ep as EModelEndpoint) &&
                !hasAgentAccess &&
                !isExistingAgentConvo
              ) {
                return false;
              }
              return !!endpointsConfig?.[ep];
            }) as EModelEndpoint;
          }

          const endpointType = getEndpointField(endpointsConfig, defaultEndpoint, 'type');
          if (!conversation.endpointType && endpointType) {
            conversation.endpointType = endpointType;
          } else if (conversation.endpointType && !endpointType) {
            conversation.endpointType = undefined;
          }

          const isAssistantEndpoint = isAssistantsEndpoint(defaultEndpoint);
          const assistants: AssistantListItem[] = assistantsListMap[defaultEndpoint] ?? [];
          const currentAssistantId = conversation.assistant_id ?? '';
          const currentAssistant = assistantsListMap[defaultEndpoint]?.[currentAssistantId] as
            | AssistantListItem
            | undefined;

          if (currentAssistantId && !currentAssistant) {
            conversation.assistant_id = undefined;
          }

          if (!currentAssistantId && isAssistantEndpoint) {
            conversation.assistant_id =
              localStorage.getItem(
                `${LocalStorageKeys.ASST_ID_PREFIX}${index}${defaultEndpoint}`,
              ) ?? assistants[0]?.id;
          }

          if (
            currentAssistantId &&
            isAssistantEndpoint &&
            conversation.conversationId === Constants.NEW_CONVO
          ) {
            const assistant = assistants.find((asst) => asst.id === currentAssistantId);
            conversation.model = assistant?.model;
            updateLastSelectedModel({
              endpoint: defaultEndpoint,
              model: conversation.model,
            });
          }

          if (currentAssistantId && !isAssistantEndpoint) {
            conversation.assistant_id = undefined;
          }

          const models = modelsConfig?.[defaultEndpoint] ?? [];
          const defaultParamsEndpoint = getDefaultParamsEndpoint(endpointsConfig, defaultEndpoint);
          conversation = buildDefaultConvo({
            conversation,
            lastConversationSetup: activePreset as TConversation,
            endpoint: defaultEndpoint,
            models,
            defaultParamsEndpoint,
          });

          if (hasExplicitChatProjectId) {
            conversation.chatProjectId = explicitChatProjectId ?? null;
          } else {
            delete conversation.chatProjectId;
          }
        }

        if (disableParams === true) {
          conversation.disableParams = true;
        }

        if (!(keepAddedConvos ?? false)) {
          clearAllConversations(true);
        }
        const isCancelled = conversation.conversationId?.startsWith('_');
        if (isCancelled) {
          logger.log(
            'conversation',
            'Cancelled conversation, setting to `new` in `useNewConvo`',
            conversation,
          );
          setConversation({
            ...conversation,
            conversationId: Constants.NEW_CONVO as string,
          });
        } else {
          logger.log('conversation', 'Setting conversation from `useNewConvo`', conversation);
          setConversation(conversation);
        }
        setSubmission({} as TSubmission);
        if (isCancelled) {
          return;
        }

        const getParams = (nextConversation: TConversation) => {
          const nextParams = new URLSearchParams(searchParams);
          nextParams.delete('projectId');
          if (
            nextConversation.conversationId === Constants.NEW_CONVO &&
            nextConversation.chatProjectId
          ) {
            nextParams.set('projectId', nextConversation.chatProjectId);
          }

          const searchParamsString = nextParams.toString();
          return searchParamsString ? `?${searchParamsString}` : '';
        };

        if (conversation.conversationId === Constants.NEW_CONVO && !modelsData) {
          const appTitle = localStorage.getItem(LocalStorageKeys.APP_TITLE) ?? '';
          if (appTitle) {
            document.title = appTitle;
          }
          const path = `/c/${Constants.NEW_CONVO}${getParams(conversation)}`;
          /** Honor disableFocus here too: the transient focus intent survives
           * follow-up navigations (unlike the old location.state), so e.g.
           * SearchBar's clear-search must not have focus stolen back. */
          if (!disableFocus) {
            requestChatFocus();
          }
          navigate(path);
          return;
        }

        const path = `/c/${conversation.conversationId}${getParams(conversation)}`;
        if (!disableFocus) {
          requestChatFocus();
        }
        navigate(path, { replace: true });
      },
    [
      endpointsConfig,
      defaultPreset,
      assistantsListMap,
      modelsQuery.data,
      hasAgentAccess,
      searchParams,
    ],
  );

  const newConversation = useCallback(
    function createNewConvo({
      template: _template = {},
      preset: _preset,
      modelsData,
      disableFocus,
      buildDefault = true,
      keepAddedConvos = false,
      keepComposerState = false,
      disableParams,
    }: {
      template?: Partial<TConversation>;
      preset?: Partial<TPreset>;
      modelsData?: TModelsConfig;
      buildDefault?: boolean;
      disableFocus?: boolean;
      keepAddedConvos?: boolean;
      /** Set when the call re-renders a composer an earlier call already opened, such as agent
       * metadata arriving late. The user never left that composer, so its draft identity and its
       * in-flight attachments outlive the refresh. */
      keepComposerState?: boolean;
      disableParams?: boolean;
    } = {}) {
      const nextConversationId = _template.conversationId ?? '';
      const keepsExistingDraft =
        keepComposerState ||
        (nextConversationId !== '' &&
          nextConversationId !== Constants.NEW_CONVO &&
          !nextConversationId.startsWith('_'));
      if (!keepsExistingDraft) {
        renewNewConversationDraftToken(index);
      }
      pauseGlobalAudio();
      if (!saveBadgesState) {
        resetBadges();
      }

      const templateConvoId = _template.conversationId ?? '';
      const paramEndpoint =
        isParamEndpoint(_template.endpoint ?? '', _template.endpointType ?? '') === true ||
        isParamEndpoint(_preset?.endpoint ?? '', _preset?.endpointType ?? '');
      const template =
        paramEndpoint === true && templateConvoId && templateConvoId === Constants.NEW_CONVO
          ? { endpoint: _template.endpoint, chatProjectId: _template.chatProjectId }
          : _template;

      let conversation = {
        conversationId: Constants.NEW_CONVO as string,
        title: 'New Chat',
        endpoint: null,
        ...template,
        createdAt: '',
        updatedAt: '',
      };

      let preset = _preset;
      const result = getDefaultModelSpec(startupConfig, endpointsConfig, agentsMap);
      const defaultModelSpec = result?.default ?? result?.last ?? result?.softDefault;
      const shouldApplyModelSpec =
        result?.softDefault != null
          ? !hasModelSelection(_template)
          : startupConfig?.modelSpecs?.prioritize === true ||
            (startupConfig?.interface?.modelSelect ?? true) !== true ||
            (result?.last != null &&
              Object.keys(_template).filter((key) => key !== 'chatProjectId').length === 0);
      if (!preset && startupConfig && shouldApplyModelSpec && defaultModelSpec) {
        preset = getModelSpecPreset(defaultModelSpec);
      }

      const prevConversation = getConversation();
      conversation = clearInheritedAgentWorkspace(conversation, prevConversation);
      applyModelSpecEffects({
        startupConfig,
        specName: preset?.spec,
        convoId: conversation.conversationId,
        prevConvoId: prevConversation?.conversationId,
        prevSpecName: prevConversation?.spec,
      });

      if (
        conversation.conversationId === Constants.NEW_CONVO &&
        !modelsData &&
        !keepComposerState
      ) {
        const filesToDelete = Array.from(files.entries()).flatMap(([fileId, file]) => {
          clearUploadRecovery(fileId);
          if (file.temp_file_id && file.temp_file_id !== fileId) {
            clearUploadRecovery(file.temp_file_id);
          }

          /** A generated paste is this composer's own upload and goes with it, even when that
           * upload was vectorized for file search: skipping every embedded record left an unsent
           * embedded paste with its metadata, storage and vectors all still on the server.
           * Anything else embedded is left alone, since those are shared. */
          const ownedPaste =
            [fileId, file.file_id, file.temp_file_id].some((id) => isPastedTextFileMarked(id)) &&
            file.attached !== true;
          if (
            file.filepath == null ||
            file.filepath === '' ||
            !file.source ||
            ((file.embedded ?? false) && !ownedPaste) ||
            (!file.temp_file_id && !ownedPaste)
          ) {
            return [];
          }

          return [
            {
              file_id: file.file_id,
              embedded: ownedPaste ? (file.embedded ?? false) : false,
              filepath: file.filepath,
              source: file.source as FileSources,
            },
          ];
        });
        if (!saveDrafts) {
          /** An upload still in flight has no filepath or source yet, so filesToDelete cannot build a
           * deletion payload for it. Direct newConversation callers need to persist its id before
           * clearing the composer map. Merge with the existing store because useNewChat may already
           * have recorded the same id. */
          const inFlightPasteIds: string[] = [];
          files.forEach((file, key) => {
            const isMarkedPaste = [key, file.file_id, file.temp_file_id].some((id) =>
              isPastedTextFileMarked(id),
            );
            if (file.attached !== true && file.progress < 1 && isMarkedPaste) {
              inFlightPasteIds.push(file.file_id);
            }
          });
          if (inFlightPasteIds.length > 0) {
            const pendingDiscardIds = new Set(loadPendingDiscardIds(index));
            inFlightPasteIds.forEach((fileId) => pendingDiscardIds.add(fileId));
            storePendingDiscardIds(index, Array.from(pendingDiscardIds));
          }
        }

        const discardedFileIds = Array.from(
          new Set([
            ...filesToDelete.map((f) => f.file_id),
            ...Array.from(files.keys()),
            ...Array.from(files.values()).flatMap(
              (f) => [f.file_id, f.temp_file_id].filter(Boolean) as string[],
            ),
          ]),
        );
        removeTabAttachmentPresence(discardedFileIds, index);
        setFiles(new Map());
        localStorage.setItem(LocalStorageKeys.FILES_TO_DELETE, JSON.stringify({}));
        if (!saveDrafts && filesToDelete.length > 0) {
          /** Another tab's draft or live presence wins over this reset's cleanup: its chip or sent
           * message may still reference the same server upload. The discarded draft keys are
           * excluded so this pane's own claims do not block its cleanup, and skipped records are
           * not retained for retry because they are not this pane's to delete. */
          const claimedElsewhere = collectForeignAttachmentClaims(
            [getNewConversationDraftId(index), getPendingDraftId(index)],
            index,
          );
          const deletableFiles = filesToDelete.filter(
            (record) => !claimedElsewhere.has(record.file_id),
          );
          if (deletableFiles.length > 0) {
            /** The map is already cleared above, so a lost request leaves nothing that could
             * rebuild these payloads. Whatever the server did not delete is retained for the
             * cleanup pass, since a failed storage delete comes back as a 200 naming the file in
             * `failedFileIds` rather than as a rejection. */
            const retainAll = (records: typeof filesToDelete) => {
              for (const record of records) {
                retainFileDeletion(record);
              }
              scheduleRetainedFileDeletionRetry();
            };
            mutateAsync({ files: deletableFiles })
              .then((result) => {
                const failed = new Set(failedFileIdsFrom(result));
                if (failed.size === 0) {
                  return;
                }
                retainAll(deletableFiles.filter((record) => failed.has(record.file_id)));
              })
              .catch(() => retainAll(deletableFiles));
          }
        }
      }

      /** A first visit to another conversation may still be waiting on its
       * record. Starting a new chat keeps the pathname, so the route check sees no change. That
       * record could then land and pull the user into the conversation they just abandoned.
       *
       * `keepComposerState` marks a call that re-renders a composer an earlier
       * call already opened, such as agent metadata arriving late. The user did
       * not ask for anything there, so it must not cancel a conversation they
       * clicked while it was in flight. */
      if (!keepComposerState) {
        supersedeNavigation();
      }

      switchToConversation(
        conversation,
        preset,
        modelsData,
        buildDefault,
        keepAddedConvos,
        disableFocus,
        disableParams,
      );
    },
    [
      index,
      files,
      setFiles,
      agentsMap,
      saveDrafts,
      mutateAsync,
      resetBadges,
      startupConfig,
      saveBadgesState,
      endpointsConfig,
      getConversation,
      pauseGlobalAudio,
      switchToConversation,
      applyModelSpecEffects,
    ],
  );

  return {
    switchToConversation,
    newConversation,
  };
};

export default useNewConvo;
