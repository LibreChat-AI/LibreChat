import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRecoilCallback, useRecoilValue } from 'recoil';
import { useParams, useSearchParams } from 'react-router-dom';
import { Button, Spinner, useToastContext } from '@librechat/client';
import { Constants, isForcedTemporaryRetention } from 'librechat-data-provider';
import type { TPreset, TAgentsMap } from 'librechat-data-provider';
import {
  defaultSpecAwaitsAgents,
  mergeQuerySettingsWithSpec,
  processValidSettings,
  getDefaultModelSpec,
  getModelSpecPreset,
  getLocalStorageItems,
  hasModelSelection,
  isNotFoundError,
  isTemporaryConversation,
  logger,
  clearMessagesCache,
} from '~/utils';
import {
  useGetConvoIdQuery,
  useGetStartupConfig,
  useGetEndpointsQuery,
  useGetAgentByIdQuery,
  useGetPresetsQuery,
  useProjectQuery,
} from '~/data-provider';
import { useIdChangeEffect, useAppStartup, useNewConvo, useLocalize } from '~/hooks';
import { ToolCallsMapProvider } from '~/Providers';
import ChatView from '~/components/Chat/ChatView';
import { NotificationSeverity } from '~/common';
import useAuthRedirect from './useAuthRedirect';
import temporaryStore from '~/store/temporary';
import store from '~/store';

const isValidChatProjectId = (projectId: string | null): projectId is string =>
  projectId != null && /^[a-f\d]{24}$/i.test(projectId);

export default function ChatRoute() {
  const { data: startupConfig } = useGetStartupConfig();
  const { isAuthenticated, user, roles } = useAuthRedirect();
  const queryClient = useQueryClient();

  const defaultTemporaryChat = useRecoilValue(temporaryStore.defaultTemporaryChat);
  const setIsTemporary = useRecoilCallback(
    ({ set }) =>
      (value: boolean) => {
        set(temporaryStore.isTemporary, value);
      },
    [],
  );
  const index = 0;
  const [searchParams, setSearchParams] = useSearchParams();
  const { conversationId = '' } = useParams();
  const projectIdParam = searchParams.get('projectId');
  const chatProjectId = isValidChatProjectId(projectIdParam) ? projectIdParam : null;
  useIdChangeEffect(conversationId);
  const { hasSetConversation, conversation } = store.useCreateConversationAtom(index);
  const [routeState, setRouteState] = useState({
    conversationId,
    pending: conversation != null && conversation.conversationId !== conversationId,
  });
  /** History navigation changes the route without running the sidebar's conversation setter.
   * Only a route change may request reconciliation: a newly submitted conversation can acquire
   * its server id before the URL catches up, and must not be reset to a new chat. */
  if (routeState.conversationId !== conversationId) {
    setRouteState({ conversationId, pending: conversation?.conversationId !== conversationId });
  } else if (routeState.pending && conversation?.conversationId === conversationId) {
    setRouteState({ conversationId, pending: false });
  }
  useAppStartup({ startupConfig, user });
  const { newConversation } = useNewConvo();
  const { showToast } = useToastContext();
  const localize = useLocalize();
  const projectQuery = useProjectQuery(chatProjectId, {
    enabled: isAuthenticated && Boolean(chatProjectId),
    retry: false,
    staleTime: 30000,
    cacheTime: 300000,
  });
  /**
   * The scoped project is *confirmed gone* — a not-found/not-owned (404) response,
   * or a success that resolved to a different/empty project. Transient failures
   * (500, network, auth refresh race) are deliberately excluded: this query runs with
   * `retry: false`, so treating any error as "gone" would unscope a valid project on
   * a single blip.
   */
  const projectNotFound = projectQuery.isError && isNotFoundError(projectQuery.error);
  /**
   * Trust the scope when the project resolves to itself, and keep showing it through
   * transient errors via React Query's retained data — but never for a project that
   * is confirmed gone (otherwise the deleted project's chip lingers).
   */
  const verifiedChatProjectId =
    !projectNotFound && projectQuery.data?._id === chatProjectId ? chatProjectId : null;
  const projectTemplate = useMemo(
    () => (verifiedChatProjectId ? { chatProjectId: verifiedChatProjectId } : {}),
    [verifiedChatProjectId],
  );

  /**
   * The scoped project is gone even though the URL still carries `?projectId`. Drop
   * the param so the new-chat landing reverts to an unscoped chat — otherwise the
   * stale chip lingers and sends target a dead project.
   */
  const projectScopeMissing =
    Boolean(chatProjectId) &&
    conversationId === Constants.NEW_CONVO &&
    (projectNotFound || (projectQuery.isSuccess && projectQuery.data?._id !== chatProjectId));

  useEffect(() => {
    if (!projectScopeMissing) {
      return;
    }
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        next.delete('projectId');
        return next;
      },
      { replace: true },
    );
  }, [projectScopeMissing, setSearchParams]);

  const initialConvoQuery = useGetConvoIdQuery(conversationId, {
    enabled:
      isAuthenticated &&
      conversationId !== Constants.NEW_CONVO &&
      (!hasSetConversation.current || routeState.pending),
  });
  const endpointsQuery = useGetEndpointsQuery({ enabled: isAuthenticated });
  // Capture stored intent once per route/account, before startup writes defaults.
  const storedSelection = useMemo(
    () => getLocalStorageItems().lastConversationSetup,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId, user?.id],
  );
  const awaitsStoredAgent = defaultSpecAwaitsAgents(startupConfig, endpointsQuery.data);
  const storedAgentQuery = useGetAgentByIdQuery(storedSelection?.agent_id, {
    enabled: isAuthenticated && awaitsStoredAgent,
  });
  const storedAgentGone = storedAgentQuery.isError && isNotFoundError(storedAgentQuery.error);
  const agentsMap = useMemo<TAgentsMap | undefined>(() => {
    if (storedAgentQuery.data) return { [storedAgentQuery.data.id]: storedAgentQuery.data };
    return storedAgentGone ? {} : undefined;
  }, [storedAgentQuery.data, storedAgentGone]);
  const presetsQuery = useGetPresetsQuery({ enabled: isAuthenticated });

  const isTemporaryChat = isTemporaryConversation(conversation);
  const forceTemporaryChat = isForcedTemporaryRetention(startupConfig?.interface?.retentionMode);

  useEffect(() => {
    if (conversationId === Constants.NEW_CONVO) {
      setIsTemporary(forceTemporaryChat || defaultTemporaryChat);
    } else if (forceTemporaryChat || isTemporaryChat) {
      setIsTemporary(true);
    } else {
      setIsTemporary(false);
    }
  }, [conversationId, isTemporaryChat, setIsTemporary, defaultTemporaryChat, forceTemporaryChat]);

  /** This effect is mainly for the first conversation state change on first load of the page.
   *  Adjusting this may have unintended consequences on the conversation state.
   */
  useEffect(() => {
    // Wait for roles to load so hasAgentAccess has a definitive value in useNewConvo
    const rolesLoaded = roles?.USER != null && (!user?.role || roles?.[user.role] != null);
    const isNewConvo = conversationId === Constants.NEW_CONVO;
    const isDraftNewConvo = conversation?.conversationId === Constants.NEW_CONVO;
    const draftProjectMismatch = verifiedChatProjectId
      ? conversation?.chatProjectId !== verifiedChatProjectId
      : conversation?.chatProjectId != null;
    const newConvoNeedsInit =
      isNewConvo && (!conversation || (isDraftNewConvo && draftProjectMismatch));
    const shouldSetConvo =
      (startupConfig &&
        rolesLoaded &&
        (!hasSetConversation.current || newConvoNeedsInit || routeState.pending)) ??
      false;
    // Configuration and permissions resolve independently of discovery.
    if (!shouldSetConvo) {
      return;
    }

    if (isNewConvo && chatProjectId && projectQuery.isLoading) {
      return;
    }

    const queryParams: Record<string, string> = {};
    searchParams.forEach((value, key) => {
      if (key !== 'prompt' && key !== 'q' && key !== 'submit' && key !== 'projectId') {
        queryParams[key] = value;
      }
    });
    const querySettings = processValidSettings(queryParams);

    const notFoundConvo =
      Boolean(conversationId) &&
      !isNewConvo &&
      initialConvoQuery.isError &&
      isNotFoundError(initialConvoQuery.error);

    if (
      awaitsStoredAgent &&
      !storedAgentQuery.isFetched &&
      (notFoundConvo || (isNewConvo && !hasModelSelection(querySettings)))
    ) {
      return;
    }

    const getNewConvoPreset = () => {
      /** A spec named in the URL is an explicit selection: it must resolve to its own
       * full preset, or stale last-selection state (endpoint/agent) fills the gaps.
       * Names absent from the client config (e.g. `showInMenu: false`) stay in the
       * query settings untouched, since they remain resolvable server-side by name. */
      const urlSpec = querySettings.spec
        ? startupConfig?.modelSpecs?.list?.find((spec) => spec.name === querySettings.spec)
        : undefined;

      const result = urlSpec
        ? undefined
        : getDefaultModelSpec(startupConfig, endpointsQuery.data, agentsMap);
      const spec = urlSpec ?? result?.default ?? result?.last ?? result?.softDefault;
      const specPreset = spec ? getModelSpecPreset(spec) : undefined;

      if (Object.keys(querySettings).length > 0) {
        return mergeQuerySettingsWithSpec(specPreset, querySettings);
      }
      if (specPreset) {
        return specPreset;
      }
      return presetsQuery.data?.find((preset) => preset.defaultPreset) ?? storedSelection;
    };

    const hasPresetSelection =
      hasModelSelection(querySettings) ||
      getDefaultModelSpec(startupConfig, endpointsQuery.data, agentsMap) != null;
    if (isNewConvo && !hasPresetSelection && !presetsQuery.isFetched) {
      return;
    }

    if (isNewConvo && endpointsQuery.data) {
      const preset = getNewConvoPreset();

      logger.log('conversation', 'ChatRoute, new convo effect', conversation);
      clearMessagesCache(queryClient, conversation?.conversationId);
      newConversation({
        keepComposerState: true,
        template: projectTemplate,
        ...(preset ? { preset } : {}),
      });

      hasSetConversation.current = true;
    } else if (initialConvoQuery.data && endpointsQuery.data) {
      logger.log('conversation', 'ChatRoute initialConvoQuery', initialConvoQuery.data);
      newConversation({
        template: initialConvoQuery.data,
        /* this is necessary to load all existing settings */
        preset: initialConvoQuery.data as TPreset,
        keepComposerState: true,
      });
      hasSetConversation.current = true;
    } else if (
      conversationId &&
      endpointsQuery.data &&
      initialConvoQuery.isError &&
      isNotFoundError(initialConvoQuery.error)
    ) {
      const result = getDefaultModelSpec(startupConfig, endpointsQuery.data, agentsMap);
      const spec = result?.default ?? result?.last ?? result?.softDefault;
      showToast({
        message: localize('com_ui_conversation_not_found'),
        severity: NotificationSeverity.WARNING,
      });
      logger.log(
        'conversation',
        'ChatRoute initialConvoQuery isNotFoundError',
        initialConvoQuery.error,
      );
      newConversation({
        keepComposerState: true,
        ...(spec ? { preset: getModelSpecPreset(spec) } : {}),
      });
      hasSetConversation.current = true;
    }
    /* Creates infinite render if all dependencies included due to newConversation invocations exceeding call stack before hasSetConversation.current becomes truthy */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    conversationId,
    routeState.pending,
    roles,
    user?.role,
    agentsMap,
    storedAgentQuery.data,
    storedAgentQuery.isFetched,
    storedAgentQuery.isError,
    awaitsStoredAgent,
    presetsQuery.data,
    presetsQuery.isFetched,
    startupConfig,
    initialConvoQuery.data,
    initialConvoQuery.isError,
    endpointsQuery.data,
    chatProjectId,
    projectQuery.data?._id,
    projectQuery.isLoading,
    projectTemplate,
    queryClient,
    conversation?.chatProjectId,
    conversation?.conversationId,
  ]);

  if (!isAuthenticated) {
    return null;
  }

  // if not a conversation
  if (conversation?.conversationId === Constants.SEARCH) {
    return null;
  }
  // if conversationId not match
  if (conversationId !== Constants.NEW_CONVO && !conversation) {
    return null;
  }
  // if conversationId is null
  if (!conversationId) {
    return null;
  }

  return (
    <ToolCallsMapProvider conversationId={conversation?.conversationId ?? ''}>
      {routeState.pending && (
        <div className="flex h-screen items-center justify-center" aria-live="polite" role="status">
          {initialConvoQuery.isError && !initialConvoQuery.isFetching ? (
            <div className="flex flex-col items-center gap-3" role="alert">
              <p>{localize('com_ui_conversation_load_error')}</p>
              <Button onClick={() => initialConvoQuery.refetch()}>
                {localize('com_ui_retry')}
              </Button>
            </div>
          ) : (
            <Spinner tone="primary" />
          )}
        </div>
      )}
      <div hidden={routeState.pending} className={routeState.pending ? 'hidden' : 'contents'}>
        <ChatView
          index={index}
          project={verifiedChatProjectId ? projectQuery.data : undefined}
          routePending={routeState.pending || conversation == null}
        />
      </div>
    </ToolCallsMapProvider>
  );
}
