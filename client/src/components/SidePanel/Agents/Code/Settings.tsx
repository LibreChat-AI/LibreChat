import { useCallback, useEffect, useId } from 'react';
import { useFormContext } from 'react-hook-form';
import {
  Switch,
  Dropdown,
  HoverCard,
  HoverCardPortal,
  HoverCardContent,
  HoverCardTrigger,
  CircleHelpIcon,
  Input,
  Checkbox,
} from '@librechat/client';
import {
  AgentCapabilities,
  DEFAULT_AGENT_CODE_ENVIRONMENT_CHOICES,
  agentGitIdentitySchema,
  STATEFUL_CODE_ENVIRONMENTS,
  resolveStatefulCodeEnvironment,
  resolveAllowedStatefulCodeEnvironments,
} from 'librechat-data-provider';
import type { StatefulCodeEnvironment } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import { useAuthContext, useGetAgentsConfig, useLocalize } from '~/hooks';
import { useCodeEnvironmentStatusQueries } from '~/data-provider';
import { ESide } from '~/common';

const ENVIRONMENT_LABELS = {
  user: 'com_ui_stateful_code_environment_user',
  'agent-user': 'com_ui_stateful_code_environment_agent_user',
  conversation: 'com_ui_stateful_code_environment_conversation',
} as const;

const DEPLOYMENT_DEFAULT_ENVIRONMENT = '__deployment_default__';
const WORKSPACE_STATUS_LABELS = {
  loading: 'com_ui_code_workspace_loading',
  unavailable: 'com_ui_code_workspace_unavailable',
  unsupported: 'com_ui_code_workspace_unsupported',
} as const;

export default function CodeSettings() {
  const labelId = useId();
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { agentsConfig } = useGetAgentsConfig();
  const methods = useFormContext<AgentForm>();
  const {
    register,
    unregister,
    getValues,
    setValue,
    watch,
    formState: { errors },
  } = methods;

  const enabled = watch(AgentCapabilities.stateful_code_sessions) ?? false;
  const codeEnabled = watch(AgentCapabilities.execute_code);
  const environment = watch('stateful_code_environment') ?? 'user';
  const codeEnvironmentId = watch('code_environment_id');
  const additionalMachines = watch('code_environment_ids') ?? [];
  const machineChoiceLimit =
    agentsConfig?.statefulCodeSessions?.maxEnvironmentChoices ??
    DEFAULT_AGENT_CODE_ENVIRONMENT_CHOICES;
  const workspaceId = watch('code_workspace_id') ?? '';
  const configuredEnvironments = agentsConfig?.statefulCodeSessions?.allowedEnvironments;
  const executionEnvironments = agentsConfig?.statefulCodeSessions?.environments ?? [];
  const statefulSessionsAvailable =
    agentsConfig?.capabilities.includes(AgentCapabilities.stateful_code_sessions) ?? false;
  const allowedEnvironments = resolveAllowedStatefulCodeEnvironments(configuredEnvironments);
  const effectiveExecutionEnvironment = codeEnvironmentId
    ? executionEnvironments.find((candidate) => candidate.id === codeEnvironmentId)
    : executionEnvironments.find((candidate) => candidate.default === true);
  const showGitIdentity =
    statefulSessionsAvailable &&
    codeEnabled &&
    enabled &&
    effectiveExecutionEnvironment?.type === 'attached';
  const workspaceStatuses = useCodeEnvironmentStatusQueries(
    effectiveExecutionEnvironment?.type === 'attached' ? [effectiveExecutionEnvironment.id] : [],
    showGitIdentity === true,
  );
  const workspaceStatusQuery = workspaceStatuses[0];
  const workspaceStatus = workspaceStatusQuery?.data;
  let workspaceDiscoveryState: 'loading' | 'unavailable' | 'unsupported' | 'ready' = 'ready';
  if (workspaceStatusQuery == null || workspaceStatusQuery.isLoading) {
    workspaceDiscoveryState = 'loading';
  } else if (
    workspaceStatusQuery.isError ||
    workspaceStatus?.status !== 'ready' ||
    workspaceStatus.environmentId !== effectiveExecutionEnvironment?.id
  ) {
    workspaceDiscoveryState = 'unavailable';
  } else if (workspaceStatus.workspaces == null) {
    workspaceDiscoveryState = 'unsupported';
  }
  const workspaces =
    workspaceDiscoveryState === 'ready' &&
    workspaceStatus?.status === 'ready' &&
    workspaceStatus.environmentId === effectiveExecutionEnvironment?.id
      ? (workspaceStatus.workspaces ?? [])
      : [];
  const releaseIdentity = useCallback(() => {
    const identity = getValues('git_identity');
    const empty = !identity?.name?.trim() && !identity?.email?.trim();
    unregister('git_identity', {
      keepValue: empty || agentGitIdentitySchema.safeParse(identity).success,
      keepDefaultValue: true,
    });
  }, [getValues, unregister]);
  useEffect(() => {
    if (!showGitIdentity) releaseIdentity();
  }, [showGitIdentity, releaseIdentity]);
  useEffect(() => releaseIdentity, [releaseIdentity]);
  const validateGitIdentity = (_value: string | undefined, values: AgentForm) => {
    const identity = values.git_identity;
    const empty = !identity?.name?.trim() && !identity?.email?.trim();
    return (
      empty ||
      agentGitIdentitySchema.safeParse(identity).success ||
      localize('com_ui_agent_git_identity_both_required')
    );
  };

  const handleChange = (value: boolean) => {
    setValue(AgentCapabilities.stateful_code_sessions, value, { shouldDirty: true });
    const currentEnvironment = watch('stateful_code_environment');
    if (value && (!currentEnvironment || !allowedEnvironments.includes(currentEnvironment))) {
      setValue(
        'stateful_code_environment',
        resolveStatefulCodeEnvironment(
          user?.personalization?.statefulCodeEnvironment ?? 'user',
          configuredEnvironments,
        ) ?? 'user',
        { shouldDirty: true },
      );
    }
  };

  if (!statefulSessionsAvailable) {
    return null;
  }

  return (
    <div className="space-y-3">
      <HoverCard openDelay={50}>
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className={codeEnabled ? 'text-sm' : 'text-text-tertiary text-sm'}>
              {localize('com_ui_stateful_sessions')}
            </div>
            <HoverCardTrigger>
              <span className="text-text-tertiary">
                <CircleHelpIcon className="h-4 w-4" />
              </span>
            </HoverCardTrigger>
          </div>
          <HoverCardPortal>
            <HoverCardContent side={ESide.Top} className="w-80">
              <div className="space-y-2">
                <p className="text-text-secondary text-sm">
                  {localize('com_nav_info_stateful_sessions')}
                </p>
              </div>
            </HoverCardContent>
          </HoverCardPortal>
          <Switch
            id="stateful-code-sessions"
            checked={enabled && codeEnabled === true}
            onCheckedChange={handleChange}
            className="ms-4"
            data-testid="stateful-code-sessions"
            disabled={codeEnabled !== true}
            aria-label={localize('com_ui_stateful_sessions')}
          />
        </div>
      </HoverCard>
      {additionalMachines
        .filter((id) => !executionEnvironments.some((candidate) => candidate.id === id))
        .map((machineId) => (
          <div key={machineId} className="flex items-center gap-2">
            <Checkbox
              id={`unavailable-code-machine-${machineId}`}
              checked={true}
              aria-label={localize('com_ui_code_environment_unavailable_choice', { 0: machineId })}
              onCheckedChange={() =>
                setValue(
                  'code_environment_ids',
                  additionalMachines.filter((id) => id !== machineId),
                  { shouldDirty: true },
                )
              }
            />
            <label
              htmlFor={`unavailable-code-machine-${machineId}`}
              className="text-text-secondary text-sm"
            >
              {localize('com_ui_code_environment_unavailable_choice', { 0: machineId })}
            </label>
          </div>
        ))}
      {enabled && codeEnabled === true && (
        <div className="space-y-2 ps-1">
          {executionEnvironments.length > 0 && (
            <>
              <span
                id={`${labelId}-code-environment`}
                className="text-text-secondary text-xs font-medium"
              >
                {localize('com_ui_code_environment')}
              </span>
              <Dropdown
                variant="field"
                testId="code-environment-id"
                aria-labelledby={`${labelId}-code-environment`}
                value={codeEnvironmentId ?? DEPLOYMENT_DEFAULT_ENVIRONMENT}
                onChange={(value) => {
                  setValue('code_workspace_id', '', { shouldDirty: true });
                  setValue(
                    'code_environment_id',
                    value === DEPLOYMENT_DEFAULT_ENVIRONMENT ? null : value,
                    { shouldDirty: true },
                  );
                }}
                options={[
                  {
                    value: DEPLOYMENT_DEFAULT_ENVIRONMENT,
                    label: localize('com_ui_code_environment_deployment_default'),
                  },
                  ...executionEnvironments.map((candidate) => ({
                    value: candidate.id,
                    label:
                      candidate.type === 'attached'
                        ? `${candidate.name} (${localize('com_ui_code_environment_attached')})`
                        : candidate.name,
                  })),
                ]}
              />
              <p className="text-text-tertiary text-xs">
                {localize('com_nav_info_code_environment')}
              </p>
              {agentsConfig?.statefulCodeSessions?.allowEnvironmentSelection === true &&
                effectiveExecutionEnvironment?.type === 'attached' && (
                  <div className="space-y-1">
                    <p className="text-text-secondary text-sm font-medium">
                      {localize('com_ui_code_environment_per_chat')}
                    </p>
                    <p className="text-text-tertiary text-xs">
                      {localize('com_ui_code_environment_per_chat_info')}
                    </p>
                    <p className="text-text-tertiary text-xs">
                      {localize('com_ui_code_environment_choice_limit', { 0: machineChoiceLimit })}
                    </p>
                    {executionEnvironments
                      .filter(({ type }) => type === 'attached')
                      .map((candidate) => {
                        const isDefault = candidate.id === effectiveExecutionEnvironment.id;
                        const id = `code-machine-${candidate.id}`;
                        return (
                          <div key={candidate.id} className="flex items-center gap-2">
                            <Checkbox
                              id={id}
                              aria-label={candidate.name}
                              checked={isDefault || additionalMachines.includes(candidate.id)}
                              disabled={
                                isDefault ||
                                (!additionalMachines.includes(candidate.id) &&
                                  additionalMachines.length >= machineChoiceLimit)
                              }
                              onCheckedChange={(checked) =>
                                setValue(
                                  'code_environment_ids',
                                  checked === true
                                    ? [...new Set([...additionalMachines, candidate.id])]
                                    : additionalMachines.filter((value) => value !== candidate.id),
                                  { shouldDirty: true },
                                )
                              }
                            />
                            <label htmlFor={id} className="text-text-secondary text-sm">
                              {candidate.name}
                              {isDefault
                                ? ` (${localize('com_ui_code_environment_default_machine')})`
                                : ''}
                            </label>
                          </div>
                        );
                      })}
                  </div>
                )}
            </>
          )}
          <span
            id={`${labelId}-stateful-code-environment`}
            className="text-text-secondary text-xs font-medium"
          >
            {localize('com_ui_stateful_code_environment')}
          </span>
          <Dropdown
            variant="field"
            testId="stateful-code-environment"
            aria-labelledby={`${labelId}-stateful-code-environment`}
            value={environment}
            onChange={(value) => {
              const nextEnvironment = value as StatefulCodeEnvironment;
              if (allowedEnvironments.includes(nextEnvironment)) {
                setValue('stateful_code_environment', nextEnvironment, { shouldDirty: true });
              }
            }}
            options={STATEFUL_CODE_ENVIRONMENTS.filter(
              (candidate) => allowedEnvironments.includes(candidate) || candidate === environment,
            ).map((candidate) => ({
              value: candidate,
              label: localize(ENVIRONMENT_LABELS[candidate]),
              disabled: !allowedEnvironments.includes(candidate),
            }))}
          />
          <p className="text-text-tertiary text-xs">
            {localize('com_nav_info_stateful_code_environment')}
          </p>
          {showGitIdentity && (
            <div className="space-y-2">
              <span
                id={`${labelId}-code-workspace-default`}
                className="text-text-secondary text-xs font-medium"
              >
                {localize('com_ui_code_workspace_default')}
              </span>
              <Dropdown
                variant="field"
                testId="code-workspace-default"
                aria-labelledby={`${labelId}-code-workspace-default`}
                value={workspaceId || '__automatic__'}
                onChange={(value) => {
                  if (value !== '__automatic__' && !workspaces.some(({ id }) => id === value))
                    return;
                  setValue('code_workspace_id', value === '__automatic__' ? '' : value, {
                    shouldDirty: true,
                  });
                  if (value !== '__automatic__' && effectiveExecutionEnvironment) {
                    setValue('code_environment_id', effectiveExecutionEnvironment.id, {
                      shouldDirty: true,
                    });
                  }
                }}
                options={[
                  { value: '__automatic__', label: localize('com_ui_code_workspace_last_used') },
                  ...(workspaceId &&
                  (workspaceDiscoveryState !== 'ready' ||
                    !workspaces.some(({ id }) => id === workspaceId))
                    ? [
                        {
                          value: workspaceId,
                          label: `${workspaceId} (${localize(
                            workspaceDiscoveryState === 'ready'
                              ? 'com_ui_code_workspace_missing'
                              : WORKSPACE_STATUS_LABELS[workspaceDiscoveryState],
                          )})`,
                          disabled: true,
                        },
                      ]
                    : []),
                  ...workspaces.map(({ id, name }) => ({ value: id, label: name ?? id })),
                ]}
              />
              {workspaceDiscoveryState !== 'ready' && (
                <p className="text-text-tertiary text-xs" role="status">
                  {localize(WORKSPACE_STATUS_LABELS[workspaceDiscoveryState])}
                </p>
              )}
              <p className="text-text-tertiary text-xs">
                {localize('com_ui_code_workspace_default_description')}
              </p>
            </div>
          )}
          {showGitIdentity && (
            <div className="border-border-light space-y-2 border-t pt-3">
              <span
                id={`${labelId}-repository-instructions`}
                className="text-text-secondary text-xs font-medium"
              >
                {localize('com_ui_repository_instructions')}
              </span>
              <Dropdown
                variant="field"
                testId="repository-instructions"
                aria-labelledby={`${labelId}-repository-instructions`}
                value={watch('repositoryInstructions') ?? 'prefer'}
                onChange={(value) => {
                  if (value === 'prefer' || value === 'defer' || value === 'off')
                    setValue('repositoryInstructions', value, { shouldDirty: true });
                }}
                options={[
                  { value: 'prefer', label: localize('com_ui_repository_instructions_prefer') },
                  { value: 'defer', label: localize('com_ui_repository_instructions_defer') },
                  { value: 'off', label: localize('com_ui_repository_instructions_off') },
                ]}
              />
              <p className="text-text-tertiary text-xs">
                {localize('com_ui_repository_instructions_description')}
              </p>
              <div className="text-text-secondary text-xs font-medium">
                {localize('com_ui_agent_git_identity')}
              </div>
              <Input
                {...register('git_identity.name', {
                  validate: validateGitIdentity,
                  deps: ['git_identity.email'],
                })}
                maxLength={128}
                placeholder={localize('com_ui_agent_git_name')}
                aria-label={localize('com_ui_agent_git_name')}
              />
              <Input
                {...register('git_identity.email', {
                  validate: validateGitIdentity,
                  deps: ['git_identity.name'],
                })}
                type="text"
                inputMode="email"
                maxLength={254}
                placeholder={localize('com_ui_agent_git_email')}
                aria-label={localize('com_ui_agent_git_email')}
              />
              {(errors.git_identity?.name || errors.git_identity?.email) && (
                <p className="text-text-destructive text-xs" role="alert">
                  {localize('com_ui_agent_git_identity_both_required')}
                </p>
              )}
              <p className="text-text-tertiary text-xs">
                {localize('com_nav_info_agent_git_identity')}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
