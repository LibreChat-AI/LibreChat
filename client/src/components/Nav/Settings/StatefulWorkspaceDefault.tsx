import { useEffect, useState } from 'react';
import {
  Select,
  SelectItem,
  SelectValue,
  SelectContent,
  SelectTrigger,
  useToastContext,
} from '@librechat/client';
import {
  STATEFUL_CODE_ENVIRONMENTS,
  resolveAllowedStatefulCodeEnvironments,
  resolveStatefulCodeEnvironment,
} from 'librechat-data-provider';
import type { StatefulCodeEnvironment } from 'librechat-data-provider';
import { useGetUserQuery, useUpdateUserPreferencesMutation } from '~/data-provider';
import { useGetAgentsConfig, useLocalize } from '~/hooks';

const FALLBACK_ENVIRONMENT: StatefulCodeEnvironment = 'user';
const ENVIRONMENT_LABELS = {
  user: 'com_ui_stateful_code_environment_user',
  'agent-user': 'com_ui_stateful_code_environment_agent_user',
  conversation: 'com_ui_stateful_code_environment_conversation',
} as const;

export default function StatefulWorkspaceDefault() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data: user } = useGetUserQuery();
  const { agentsConfig } = useGetAgentsConfig();
  const configuredEnvironments = agentsConfig?.statefulCodeSessions?.allowedEnvironments;
  const allowedEnvironments = resolveAllowedStatefulCodeEnvironments(configuredEnvironments);
  const savedPreference = user?.personalization?.statefulCodeEnvironment;
  const savedEnvironment =
    savedPreference ??
    resolveStatefulCodeEnvironment(FALLBACK_ENVIRONMENT, configuredEnvironments) ??
    FALLBACK_ENVIRONMENT;
  const [environment, setEnvironment] = useState<StatefulCodeEnvironment>(savedEnvironment);

  useEffect(() => {
    setEnvironment(savedEnvironment);
  }, [savedEnvironment]);

  const mutation = useUpdateUserPreferencesMutation({
    onSuccess: () =>
      showToast({ message: localize('com_ui_preferences_updated'), status: 'success' }),
    onError: () => {
      setEnvironment(savedEnvironment);
      showToast({ message: localize('com_ui_error_updating_preferences'), status: 'error' });
    },
  });

  const handleChange = (value: string) => {
    const statefulCodeEnvironment = value as StatefulCodeEnvironment;
    if (!allowedEnvironments.includes(statefulCodeEnvironment)) {
      return;
    }
    setEnvironment(statefulCodeEnvironment);
    mutation.mutate({ statefulCodeEnvironment });
  };

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div>
        <label id="default-stateful-workspace-label" htmlFor="default-stateful-workspace">
          {localize('com_ui_default_stateful_workspace')}
        </label>
        <p id="default-stateful-workspace-description" className="text-text-secondary mt-1 text-xs">
          {localize('com_ui_default_stateful_workspace_description')}
        </p>
      </div>
      <Select value={environment} onValueChange={handleChange} disabled={mutation.isLoading}>
        <SelectTrigger
          id="default-stateful-workspace"
          className="w-full shrink-0 sm:w-[13.75rem]"
          aria-labelledby="default-stateful-workspace-label"
          aria-describedby="default-stateful-workspace-description"
          data-testid="default-stateful-workspace"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATEFUL_CODE_ENVIRONMENTS.filter(
            (candidate) =>
              allowedEnvironments.includes(candidate) || candidate === savedEnvironment,
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
    </div>
  );
}
