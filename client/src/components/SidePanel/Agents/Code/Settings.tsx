import { useCallback, useEffect } from 'react';
import { useFormContext } from 'react-hook-form';
import {
  AgentCapabilities,
  agentGitIdentitySchema,
  STATEFUL_CODE_ENVIRONMENTS,
  resolveStatefulCodeEnvironment,
  resolveAllowedStatefulCodeEnvironments,
} from 'librechat-data-provider';
import {
  Switch,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  HoverCard,
  HoverCardPortal,
  HoverCardContent,
  HoverCardTrigger,
  CircleHelpIcon,
  Input,
} from '@librechat/client';
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
              <CircleHelpIcon className="text-text-tertiary h-4 w-4" />
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
            className="ml-4"
            data-testid="stateful-code-sessions"
            disabled={codeEnabled !== true}
            aria-label={localize('com_ui_stateful_sessions')}
          />
        </div>
      </HoverCard>
      {enabled && codeEnabled === true && (
        <div className="space-y-2 pl-1">
          {executionEnvironments.length > 0 && (
            <>
              <label
                className="text-text-secondary text-xs font-medium"
                htmlFor="code-environment-id"
              >
                {localize('com_ui_code_environment')}
              </label>
              <Select
                value={codeEnvironmentId ?? DEPLOYMENT_DEFAULT_ENVIRONMENT}
                onValueChange={(value) => {
                  setValue('code_workspace_id', '', { shouldDirty: true });
                  setValue(
                    'code_environment_id',
                    value === DEPLOYMENT_DEFAULT_ENVIRONMENT ? null : value,
                    { shouldDirty: true },
                  );
                }}
              >
                <SelectTrigger id="code-environment-id" data-testid="code-environment-id">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEPLOYMENT_DEFAULT_ENVIRONMENT}>
                    {localize('com_ui_code_environment_deployment_default')}
                  </SelectItem>
                  {executionEnvironments.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.name}
                      {candidate.type === 'attached'
                        ? ` (${localize('com_ui_code_environment_attached')})`
                        : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-text-tertiary text-xs">
                {localize('com_nav_info_code_environment')}
              </p>
            </>
          )}
          <label
            className="text-text-secondary text-xs font-medium"
            htmlFor="stateful-code-environment"
          >
            {localize('com_ui_stateful_code_environment')}
          </label>
          <Select
            value={environment}
            onValueChange={(value) => {
              const nextEnvironment = value as StatefulCodeEnvironment;
              if (allowedEnvironments.includes(nextEnvironment)) {
                setValue('stateful_code_environment', nextEnvironment, { shouldDirty: true });
              }
            }}
          >
            <SelectTrigger id="stateful-code-environment" data-testid="stateful-code-environment">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATEFUL_CODE_ENVIRONMENTS.filter(
                (candidate) => allowedEnvironments.includes(candidate) || candidate === environment,
              ).map((candidate) => (
                <SelectItem
                  key={candidate}
                  value={candidate}
                  disabled={!allowedEnvironments.includes(candidate)}
                >
                  {localize(ENVIRONMENT_LABELS[candidate])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-text-tertiary text-xs">
            {localize('com_nav_info_stateful_code_environment')}
          </p>
          {showGitIdentity && (
            <div className="space-y-2">
              <label
                htmlFor="code-workspace-default"
                className="text-text-secondary text-xs font-medium"
              >
                {localize('com_ui_code_workspace_default')}
              </label>
              <Select
                value={workspaceId || '__automatic__'}
                onValueChange={(value) => {
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
              >
                <SelectTrigger id="code-workspace-default">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__automatic__">
                    {localize('com_ui_code_workspace_last_used')}
                  </SelectItem>
                  {workspaceId &&
                    (workspaceDiscoveryState !== 'ready' ||
                      !workspaces.some(({ id }) => id === workspaceId)) && (
                      <SelectItem value={workspaceId} disabled>
                        {workspaceId} —{' '}
                        {localize(
                          workspaceDiscoveryState === 'ready'
                            ? 'com_ui_code_workspace_missing'
                            : WORKSPACE_STATUS_LABELS[workspaceDiscoveryState],
                        )}
                      </SelectItem>
                    )}
                  {workspaces.map(({ id, name }) => (
                    <SelectItem key={id} value={id}>
                      {name ?? id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              <label
                htmlFor="repository-instructions"
                className="text-text-secondary text-xs font-medium"
              >
                {localize('com_ui_repository_instructions')}
              </label>
              <Select
                value={watch('repositoryInstructions') ?? 'prefer'}
                onValueChange={(value) => {
                  if (value === 'prefer' || value === 'defer' || value === 'off')
                    setValue('repositoryInstructions', value, { shouldDirty: true });
                }}
              >
                <SelectTrigger id="repository-instructions">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="prefer">
                    {localize('com_ui_repository_instructions_prefer')}
                  </SelectItem>
                  <SelectItem value="defer">
                    {localize('com_ui_repository_instructions_defer')}
                  </SelectItem>
                  <SelectItem value="off">
                    {localize('com_ui_repository_instructions_off')}
                  </SelectItem>
                </SelectContent>
              </Select>
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
