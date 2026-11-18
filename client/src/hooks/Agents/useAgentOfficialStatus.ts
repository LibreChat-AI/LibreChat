import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';

export type AgentOfficialStatusSettings = {
  /** `interface.agentOfficialStatus.enabled`; off by default, which hides every badge. */
  enabled: boolean;
  /** The badge's tooltip: the configured `description`, or the default "Official agent". */
  description: string;
  /** The server reported `manage:agents` for this user while official status is enabled. */
  canManage: boolean;
};

/** Reads the deployment's official status settings from the cached startup config. */
export default function useAgentOfficialStatus(): AgentOfficialStatusSettings {
  const localize = useLocalize();
  const { data: startupConfig } = useGetStartupConfig();
  const config = startupConfig?.interface?.agentOfficialStatus;
  const enabled = config?.enabled === true;
  const description = config?.description?.trim();

  return {
    enabled,
    description: description || localize('com_ui_official_agent'),
    canManage: enabled && startupConfig?.canManageAgentOfficialStatus === true,
  };
}
