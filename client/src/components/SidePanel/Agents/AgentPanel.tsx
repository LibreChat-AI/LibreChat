import React, { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import isEqual from 'lodash/isEqual';
import { Button, useToastContext } from '@librechat/client';
import { useWatch, useForm, FormProvider } from 'react-hook-form';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import {
  MemoryScope,
  SystemRoles,
  ResourceType,
  EModelEndpoint,
  LocalStorageKeys,
  PermissionBits,
  removeCodeExecutionCaller,
  resolveModelCatalogKey,
  resolveStatefulCodeEnvironment,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import type { Agent, AgentUpdateParams } from 'librechat-data-provider';
import type { FieldNamesMarkedBoolean } from 'react-hook-form';
import type { TranslationKeys } from '~/hooks/useLocalize';
import type { AgentParameterConfig } from './parameters';
import type { AgentForm, StringOption } from '~/common';
import {
  useCreateAgentMutation,
  useUpdateAgentMutation,
  useGetAgentByIdQuery,
  useGetExpandedAgentByIdQuery,
  useUploadAgentAvatarMutation,
} from '~/data-provider';
import {
  createProviderOption,
  getAvailableAgentSelection,
  getDefaultAgentFormValues,
} from '~/utils';
import { pruneAgentModelParameters, resolveAgentParameterSettings } from './parameters';
import { useResourcePermissions } from '~/hooks/useResourcePermissions';
import { useSelectAgent, useLocalize, useAuthContext } from '~/hooks';
import { useAgentPanelContext } from '~/Providers/AgentPanelContext';
import { resolveCapabilityTools } from './Tools/items/capabilities';
import AgentPanelSkeleton from './AgentPanelSkeleton';
import AdvancedPanel from './Advanced/AdvancedPanel';
import { Panel, isEphemeralAgent } from '~/common';
import AgentConfig from './AgentConfig';
import AgentSelect from './AgentSelect';
import AgentFooter from './AgentFooter';
import ModelPanel from './ModelPanel';

/* Helpers */
function getUpdateToastMessage(
  noVersionChange: boolean,
  avatarActionState: AgentForm['avatar_action'],
  name: string | null | undefined,
  localize: (key: TranslationKeys, vars?: Record<string, unknown>) => string,
): string | null {
  // If only avatar upload is pending (separate endpoint), suppress the no-changes toast.
  if (noVersionChange && avatarActionState === 'upload') {
    return null;
  }
  if (noVersionChange) {
    return localize('com_ui_no_changes');
  }
  return localize('com_assistants_update_success_name', { name: name ?? localize('com_ui_agent') });
}

/**
 * Normalizes the payload sent to the agent update/create endpoints.
 * Handles avatar reset requests for persistent agents independently of avatar uploads.
 * @param {AgentForm} data - Form data from the agent configuration form.
 * @param {string | null} [agent_id] - Agent identifier, if the agent already exists.
 * @returns {{ payload: Partial<AgentForm>; provider: string; model: string }} Payload metadata.
 */
export function composeAgentUpdatePayload(
  data: AgentForm,
  agent_id?: string | null,
  parameterConfig?: AgentParameterConfig,
) {
  const {
    name,
    artifacts,
    description,
    instructions,
    model: _model,
    model_parameters: currentModelParameters,
    provider: _provider,
    agent_ids,
    edges,
    subagents,
    end_after_tools,
    hide_sequential_outputs,
    stateful_code_sessions,
    stateful_code_environment,
    code_environment_id,
    repositoryInstructions,
    code_workspace_id,
    git_identity,
    recursion_limit,
    category,
    support_contact,
    tool_options,
    skills,
    skills_enabled,
    skill_authoring_enabled,
    skills_scope,
    memory_scope,
    avatar_action: avatarActionState,
  } = data;

  /* stateful_code_sessions requires Code Interpreter; force it off on save when
   * execute_code is disabled so a stale opt-in can't silently reactivate later. */
  const normalizedStatefulCodeSessions =
    data.execute_code === true ? stateful_code_sessions : false;
  const normalizedToolOptions =
    data.execute_code === true ? tool_options : removeCodeExecutionCaller(tool_options);
  const normalizedStatefulCodeEnvironment = stateful_code_environment ?? 'user';

  const shouldResetAvatar =
    avatarActionState === 'reset' && Boolean(agent_id) && !isEphemeralAgent(agent_id);
  const model = _model ?? '';
  const provider =
    (typeof _provider === 'string' ? _provider : (_provider as StringOption).value) ?? '';
  /** Pruning reads the complete schema, not the rendered subset, so a role-gated
   *  parameter is preserved rather than deleted when someone without the
   *  permission saves an unrelated edit. `webSearchAllowed` narrows only
   *  `visibleParameters`, which this path does not use. */
  const modelParameterSettings = parameterConfig
    ? resolveAgentParameterSettings({
        ...parameterConfig,
        model,
        provider,
        webSearchAllowed: true,
      })
    : undefined;
  const model_parameters = modelParameterSettings
    ? pruneAgentModelParameters(currentModelParameters, modelParameterSettings)
    : currentModelParameters;
  let normalizedGitIdentity: AgentUpdateParams['git_identity'];
  const gitIdentityName = git_identity?.name?.trim() ?? '';
  const gitIdentityEmail = git_identity?.email?.trim() ?? '';
  if (gitIdentityName || gitIdentityEmail) {
    normalizedGitIdentity = {
      name: gitIdentityName,
      email: gitIdentityEmail,
    };
  } else if (agent_id && git_identity != null) {
    normalizedGitIdentity = null;
  }

  return {
    payload: {
      name,
      artifacts,
      description,
      instructions,
      model,
      provider,
      model_parameters,
      agent_ids,
      edges,
      subagents,
      end_after_tools,
      hide_sequential_outputs,
      stateful_code_sessions: normalizedStatefulCodeSessions,
      stateful_code_environment: normalizedStatefulCodeEnvironment,
      code_environment_id: agent_id ? code_environment_id : (code_environment_id ?? undefined),
      repositoryInstructions,
      code_workspace_id,
      git_identity: normalizedGitIdentity,
      recursion_limit,
      category,
      support_contact,
      tool_options: normalizedToolOptions,
      skills,
      skills_enabled,
      skill_authoring_enabled,
      skills_scope,
      /** A hidden stale 'agent' scope must not survive disabling memory —
       *  runtime partitioning keys off memory_scope alone. */
      memory_scope: data.memory === true ? memory_scope : MemoryScope.user,
      ...(shouldResetAvatar ? { avatar: null } : {}),
    },
    provider,
    model,
  } as const;
}

type UploadAvatarFn = (variables: { agent_id: string; formData: FormData }) => Promise<Agent>;

export interface PersistAvatarChangesParams {
  agentId?: string | null;
  avatarActionState: AgentForm['avatar_action'];
  avatarFile?: File | null;
  uploadAvatar: UploadAvatarFn;
}

/**
 * Uploads a new avatar when the form indicates an avatar upload is pending.
 * The helper ensures we only attempt uploads for persisted agents and when
 * the avatar action is explicitly set to "upload".
 * @returns {Promise<boolean>} Resolves true if an upload occurred, false otherwise.
 */
export async function persistAvatarChanges({
  agentId,
  avatarActionState,
  avatarFile,
  uploadAvatar,
}: PersistAvatarChangesParams): Promise<boolean> {
  if (!agentId || isEphemeralAgent(agentId)) {
    return false;
  }

  if (avatarActionState !== 'upload' || !avatarFile) {
    return false;
  }

  const formData = new FormData();
  formData.append('file', avatarFile, avatarFile.name);

  await uploadAvatar({
    agent_id: agentId,
    formData,
  });

  return true;
}

const AVATAR_ONLY_DIRTY_FIELDS = new Set(['avatar_action', 'avatar_file', 'avatar_preview']);
const IGNORED_DIRTY_FIELDS = new Set(['agent']);

const isNestedDirtyField = (
  value: FieldNamesMarkedBoolean<AgentForm>[keyof AgentForm],
): value is FieldNamesMarkedBoolean<AgentForm> => typeof value === 'object' && value !== null;

const evaluateDirtyFields = (
  fields: FieldNamesMarkedBoolean<AgentForm>,
): { sawDirty: boolean; onlyAvatarDirty: boolean } => {
  let sawDirty = false;

  for (const [key, value] of Object.entries(fields)) {
    if (!value) {
      continue;
    }

    if (IGNORED_DIRTY_FIELDS.has(key)) {
      continue;
    }

    if (isNestedDirtyField(value)) {
      const nested = evaluateDirtyFields(value);
      if (!nested.onlyAvatarDirty) {
        return { sawDirty: true, onlyAvatarDirty: false };
      }
      sawDirty = sawDirty || nested.sawDirty;
      continue;
    }

    sawDirty = true;

    if (AVATAR_ONLY_DIRTY_FIELDS.has(key)) {
      continue;
    }

    return { sawDirty: true, onlyAvatarDirty: false };
  }

  return { sawDirty, onlyAvatarDirty: true };
};

/**
 * Determines whether the dirty form state only contains avatar uploads/resets.
 * This enables short-circuiting the general agent update flow when only the avatar
 * needs to be uploaded.
 */
export const isAvatarUploadOnlyDirty = (
  dirtyFields?: FieldNamesMarkedBoolean<AgentForm>,
): boolean => {
  if (!dirtyFields) {
    return false;
  }

  const result = evaluateDirtyFields(dirtyFields);
  return result.sawDirty && result.onlyAvatarDirty;
};

/**
 * Whether the submission carries an edit the agent update endpoint persists. Only an
 * avatar upload travels through its own endpoint; a reset rides the update payload as
 * `avatar: null` (see `composeAgentUpdatePayload`), so it is an edit like any other.
 */
export const hasPersistedDirtyFields = (
  dirtyFields?: FieldNamesMarkedBoolean<AgentForm>,
  avatarAction?: AgentForm['avatar_action'],
): boolean => {
  if (avatarAction === 'reset') {
    return true;
  }

  if (!dirtyFields) {
    return false;
  }

  const result = evaluateDirtyFields(dirtyFields);
  return result.sawDirty && !result.onlyAvatarDirty;
};

/**
 * Whether the save may have left the stored agent different from the one it replaced,
 * across the fields the submission carried. A dirty field is no promise that anything was
 * written: the server can normalize a submission straight back to the stored value, by
 * pruning a skill that no longer exists or by dropping an MCP tool authorization rejects.
 *
 * `previous` must be the expanded agent. A basic projection omits fields the submission
 * still carries, and the update endpoint answers with their unchanged values, which would
 * read as a change that never happened. Without it the comparison cannot be trusted and
 * reports true, leaving the dirty check to decide: claiming nothing changed for a save
 * that did is the worse error of the two.
 */
export const mayHavePersistedChange = (
  submitted?: AgentUpdateParams,
  previous?: Agent,
  updated?: Agent,
): boolean => {
  if (!submitted || !previous || !updated) {
    return true;
  }

  const fields = Object.keys(submitted) as Array<keyof AgentUpdateParams & keyof Agent>;
  return fields.some((field) => !isEqual(previous[field], updated[field]));
};

export default function AgentPanel() {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { showToast } = useToastContext();
  const {
    activePanel,
    agentsConfig,
    startupConfig,
    setActivePanel,
    endpointsConfig,
    setCurrentAgentId,
    agent_id: current_agent_id,
  } = useAgentPanelContext();
  const defaultStatefulCodeEnvironment =
    resolveStatefulCodeEnvironment(
      user?.personalization?.statefulCodeEnvironment ?? 'user',
      agentsConfig?.statefulCodeSessions?.allowedEnvironments,
    ) ?? 'user';

  const { onSelect: onSelectAgent } = useSelectAgent();

  const modelsQuery = useGetModelsQuery({ refetchOnMount: 'always' });
  const basicAgentQuery = useGetAgentByIdQuery(current_agent_id);

  const { hasPermission, isLoading: permissionsLoading } = useResourcePermissions(
    ResourceType.AGENT,
    basicAgentQuery.data?._id || '',
  );

  const canEdit = hasPermission(PermissionBits.EDIT);

  const expandedAgentQuery = useGetExpandedAgentByIdQuery(current_agent_id ?? '', {
    enabled: !isEphemeralAgent(current_agent_id) && canEdit && !permissionsLoading,
  });

  const agentQuery = canEdit && expandedAgentQuery.data ? expandedAgentQuery : basicAgentQuery;

  const modelsReady = modelsQuery.isFetchedAfterMount && !modelsQuery.isFetching;
  const modelsError = modelsQuery.isFetchedAfterMount && !modelsQuery.isSuccess;
  /** The models query is seeded with a static fallback config, so its entries only describe the
   *  active server once the fetch issued on mount has resolved. Until then there is nothing
   *  authoritative to offer, and an outright failure must not fall back to the seed either. */
  const models = useMemo(
    () => (modelsQuery.isFetchedAfterMount && !modelsError ? (modelsQuery.data ?? {}) : {}),
    [modelsError, modelsQuery.isFetchedAfterMount, modelsQuery.data],
  );
  const methods = useForm<AgentForm>({
    defaultValues: getDefaultAgentFormValues(defaultStatefulCodeEnvironment),
    mode: 'onChange',
  });

  const {
    control,
    handleSubmit,
    reset,
    getValues,
    setValue,
    formState: { dirtyFields },
  } = methods;
  const [isAvatarUploadInFlight, setIsAvatarUploadInFlight] = useState(false);

  const uploadAvatarMutation = useUploadAgentAvatarMutation({
    onSuccess: (updatedAgent) => {
      showToast({ message: localize('com_ui_upload_agent_avatar') });

      setValue('avatar_preview', updatedAgent.avatar?.filepath ?? '', { shouldDirty: false });
      setValue('avatar_file', null, { shouldDirty: false });
      setValue('avatar_action', null, { shouldDirty: false });

      const agentOption = getValues('agent');
      if (agentOption && typeof agentOption !== 'string') {
        setValue('agent', { ...agentOption, ...updatedAgent }, { shouldDirty: false });
      }
    },
    onError: () => {
      showToast({ message: localize('com_ui_upload_error'), status: 'error' });
    },
  });

  const handleAvatarUpload = useCallback(
    async (agentId?: string | null) => {
      const avatarActionState = getValues('avatar_action');
      const avatarFile = getValues('avatar_file');
      if (!agentId || isEphemeralAgent(agentId) || avatarActionState !== 'upload' || !avatarFile) {
        return false;
      }

      setIsAvatarUploadInFlight(true);
      try {
        return await persistAvatarChanges({
          agentId,
          avatarActionState,
          avatarFile,
          uploadAvatar: uploadAvatarMutation.mutateAsync,
        });
      } catch (error) {
        console.error('[AgentPanel] Avatar upload failed', error);
        throw error;
      } finally {
        setIsAvatarUploadInFlight(false);
      }
    },
    [getValues, uploadAvatarMutation],
  );
  const agent_id = useWatch({ control, name: 'id' });
  const previousVersionRef = useRef<number | undefined>();
  const submittedDirtyRef = useRef(false);
  const submittedRef = useRef<{ payload?: AgentUpdateParams; previous?: Agent }>({});

  const allowedProviders = useMemo(
    () => new Set(agentsConfig?.allowedProviders),
    [agentsConfig?.allowedProviders],
  );

  const providers = useMemo(
    () =>
      Object.keys(endpointsConfig ?? {})
        .filter(
          (key) =>
            !isAssistantsEndpoint(key) &&
            (allowedProviders.size > 0 ? allowedProviders.has(key) : true) &&
            key !== EModelEndpoint.agents,
        )
        .map((provider) => createProviderOption(provider)),
    [endpointsConfig, allowedProviders],
  );
  useEffect(() => {
    if (endpointsConfig == null || !modelsReady || !modelsQuery.isSuccess) {
      return;
    }

    const storedProvider = localStorage.getItem(LocalStorageKeys.LAST_AGENT_PROVIDER) ?? '';
    const storedModel = localStorage.getItem(LocalStorageKeys.LAST_AGENT_MODEL) ?? '';
    const storedSelection = getAvailableAgentSelection({
      provider: storedProvider,
      model: storedModel,
      providers,
      models,
    });

    if (storedSelection.provider !== storedProvider) {
      localStorage.removeItem(LocalStorageKeys.LAST_AGENT_PROVIDER);
      localStorage.removeItem(LocalStorageKeys.LAST_AGENT_MODEL);
    } else if (storedSelection.model !== storedModel) {
      localStorage.removeItem(LocalStorageKeys.LAST_AGENT_MODEL);
    }

    if (current_agent_id || dirtyFields.provider === true || dirtyFields.model === true) {
      return;
    }

    const selectedProviderOption = getValues('provider');
    const selectedProvider =
      (typeof selectedProviderOption === 'string'
        ? selectedProviderOption
        : (selectedProviderOption as StringOption | undefined)?.value) ?? '';
    const selectedModel = getValues('model') ?? '';

    if (storedSelection.provider !== selectedProvider) {
      setValue('provider', createProviderOption(storedSelection.provider));
    }
    if (storedSelection.model !== selectedModel) {
      setValue('model', storedSelection.model);
    }
  }, [
    current_agent_id,
    dirtyFields.model,
    dirtyFields.provider,
    endpointsConfig,
    getValues,
    models,
    modelsQuery.isSuccess,
    modelsReady,
    providers,
    setValue,
  ]);

  /* Mutations */
  const update = useUpdateAgentMutation({
    onMutate: (variables) => {
      /** The agent as it stands before the write, taken from the expanded query so every
       *  submitted field is comparable. The mutation replaces this cache entry on success,
       *  so it has to be captured here to stay comparable afterwards. */
      previousVersionRef.current = agentQuery.data?.version;
      submittedDirtyRef.current = hasPersistedDirtyFields(dirtyFields, getValues('avatar_action'));
      submittedRef.current = { payload: variables.data, previous: expandedAgentQuery.data };
    },
    onSuccess: async (data) => {
      const avatarActionState = getValues('avatar_action');
      /** An update whose result matches the newest version is written without recording a
       *  version entry, so an unchanged count no longer means the save was a no-op. Only
       *  a save that both carried no edit and left the agent as it found it can claim
       *  nothing changed. */
      const persistedEdit =
        submittedDirtyRef.current &&
        mayHavePersistedChange(submittedRef.current.payload, submittedRef.current.previous, data);
      const noVersionChange =
        !persistedEdit &&
        previousVersionRef.current !== undefined &&
        data.version === previousVersionRef.current;
      const toastMessage = getUpdateToastMessage(
        noVersionChange,
        avatarActionState,
        data.name,
        localize,
      );
      if (toastMessage) {
        showToast({ message: toastMessage, status: noVersionChange ? 'info' : undefined });
      }

      const agentOption = getValues('agent');
      if (agentOption && typeof agentOption !== 'string') {
        setValue('agent', { ...agentOption, ...data }, { shouldDirty: false });
      }

      try {
        await handleAvatarUpload(data.id ?? agent_id);
      } catch (error) {
        console.error('[AgentPanel] Avatar upload failed after update', error);
        showToast({
          message: localize('com_agents_avatar_upload_error'),
          status: 'error',
        });
      }

      if (avatarActionState === 'reset') {
        setValue('avatar_action', null, { shouldDirty: false });
        setValue('avatar_file', null, { shouldDirty: false });
        setValue('avatar_preview', '', { shouldDirty: false });
      }

      // Clear the refs after use
      previousVersionRef.current = undefined;
      submittedDirtyRef.current = false;
      submittedRef.current = {};
    },
    onError: (err) => {
      const error = err as Error;
      showToast({
        message: `${localize('com_agents_update_error')}${
          error.message ? ` ${localize('com_ui_error')}: ${error.message}` : ''
        }`,
        status: 'error',
      });
    },
  });

  const create = useCreateAgentMutation({
    onSuccess: async (data) => {
      setCurrentAgentId(data.id);
      showToast({
        message: `${localize('com_assistants_create_success')} ${
          data.name ?? localize('com_ui_agent')
        }`,
      });

      try {
        await handleAvatarUpload(data.id);
      } catch (error) {
        console.error('[AgentPanel] Avatar upload failed after create', error);
        showToast({
          message: localize('com_agents_avatar_upload_error'),
          status: 'error',
        });
      }
    },
    onError: (err) => {
      const error = err as Error;
      showToast({
        message: `${localize('com_agents_create_error')}${
          error.message ? ` ${localize('com_ui_error')}: ${error.message}` : ''
        }`,
        status: 'error',
      });
    },
  });

  const onSubmit = useCallback(
    async (data: AgentForm) => {
      const tools = Array.from(new Set([...(data.tools ?? []), ...resolveCapabilityTools(data)]));

      const {
        payload: basePayload,
        provider,
        model,
      } = composeAgentUpdatePayload(data, agent_id, {
        endpointsConfig,
        startupConfig,
      });

      if (agent_id) {
        if (data.avatar_action === 'upload' && isAvatarUploadOnlyDirty(dirtyFields)) {
          try {
            const uploaded = await handleAvatarUpload(agent_id);
            if (!uploaded) {
              showToast({
                message: localize('com_agents_avatar_upload_error'),
                status: 'error',
              });
            }
          } catch (error) {
            console.error('[AgentPanel] Avatar upload failed for avatar-only submission', error);
            showToast({
              message: localize('com_agents_avatar_upload_error'),
              status: 'error',
            });
          }
          return;
        }
        update.mutate({ agent_id, data: { ...basePayload, tools } });
        return;
      }

      if (!provider || !model) {
        return showToast({
          message: localize('com_agents_missing_provider_model'),
          status: 'error',
        });
      }
      if (!modelsReady || modelsError) {
        return showToast({
          message: localize('com_error_models_not_loaded'),
          status: 'error',
        });
      }
      if (!(models[resolveModelCatalogKey(provider, models)] ?? []).includes(model)) {
        return showToast({
          message: localize('com_error_model_not_found'),
          status: 'error',
        });
      }
      if (!data.name) {
        return showToast({
          message: localize('com_agents_missing_name'),
          status: 'error',
        });
      }

      create.mutate({
        ...basePayload,
        git_identity: basePayload.git_identity ?? undefined,
        repositoryInstructions: basePayload.repositoryInstructions,
        model,
        tools,
        provider,
      });
    },
    [
      agent_id,
      create,
      dirtyFields,
      endpointsConfig,
      handleAvatarUpload,
      models,
      modelsError,
      modelsReady,
      update,
      showToast,
      startupConfig,
      localize,
    ],
  );

  const handleSelectAgent = useCallback(() => {
    if (agent_id) {
      onSelectAgent(agent_id);
    }
  }, [agent_id, onSelectAgent]);

  const canEditAgent = useMemo(() => {
    if (!agentQuery.data?.id) {
      return true;
    }

    if (user?.role === SystemRoles.ADMIN) {
      return true;
    }

    return canEdit;
  }, [agentQuery.data?.id, user?.role, canEdit]);

  return (
    <FormProvider {...methods}>
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="scrollbar-gutter-stable flex flex-1 flex-col px-3 pb-3 pt-2"
        aria-label="Agent configuration form"
      >
        <div className="flex-1">
          <div className="flex w-full flex-wrap gap-2">
            <div className="w-full">
              <AgentSelect
                createMutation={create}
                agentQuery={agentQuery}
                setCurrentAgentId={setCurrentAgentId}
                selectedAgentId={agentQuery.isInitialLoading ? null : (current_agent_id ?? null)}
                defaultStatefulCodeEnvironment={defaultStatefulCodeEnvironment}
              />
            </div>
            {agent_id && (
              <div className="flex w-full gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-center"
                  onClick={() => {
                    reset(getDefaultAgentFormValues(defaultStatefulCodeEnvironment));
                    setCurrentAgentId(undefined);
                  }}
                  disabled={agentQuery.isInitialLoading}
                  aria-label={localize('com_ui_create_new_agent')}
                >
                  <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
                  {localize('com_ui_create_new_agent')}
                </Button>
                <Button
                  variant="submit"
                  disabled={isEphemeralAgent(agent_id) || agentQuery.isInitialLoading}
                  onClick={(e) => {
                    e.preventDefault();
                    handleSelectAgent();
                  }}
                  aria-label={localize('com_ui_select_agent')}
                >
                  {localize('com_ui_select')}
                </Button>
              </div>
            )}
          </div>
          {agentQuery.isInitialLoading && <AgentPanelSkeleton />}
          {!canEditAgent && !agentQuery.isInitialLoading && (
            <div className="flex h-[30vh] w-full items-center justify-center">
              <div className="text-center">
                <h2 className="text-token-text-primary m-2 text-xl font-semibold">
                  {localize('com_agents_not_available')}
                </h2>
                <p className="text-token-text-secondary">{localize('com_agents_no_access')}</p>
              </div>
            </div>
          )}
          {canEditAgent && !agentQuery.isInitialLoading && activePanel === Panel.model && (
            <ModelPanel
              models={models}
              providers={providers}
              modelsError={modelsError}
              modelsReady={modelsReady}
              setActivePanel={setActivePanel}
            />
          )}
          {canEditAgent && !agentQuery.isInitialLoading && activePanel === Panel.builder && (
            <AgentConfig />
          )}
          {canEditAgent && !agentQuery.isInitialLoading && activePanel === Panel.advanced && (
            <AdvancedPanel />
          )}
        </div>
        {canEditAgent && !agentQuery.isInitialLoading && (
          <AgentFooter
            createMutation={create}
            updateMutation={update}
            isAvatarUploading={isAvatarUploadInFlight || uploadAvatarMutation.isLoading}
            activePanel={activePanel}
            setActivePanel={setActivePanel}
            setCurrentAgentId={setCurrentAgentId}
          />
        )}
      </form>
    </FormProvider>
  );
}
