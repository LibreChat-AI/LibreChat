import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';

export type AgentCertificationSettings = {
  /** `interface.agentCertification.enabled`; off by default, which hides every badge. */
  enabled: boolean;
  /** The badge's tooltip: the configured `description`, or the default "Certified". */
  description: string;
  /** The server reported `manage:agents` for this user while certification is enabled. */
  canManage: boolean;
};

/** Reads the deployment's certification settings from the cached startup config. */
export default function useAgentCertification(): AgentCertificationSettings {
  const localize = useLocalize();
  const { data: startupConfig } = useGetStartupConfig();
  const config = startupConfig?.interface?.agentCertification;
  const enabled = config?.enabled === true;
  const description = config?.description?.trim();

  return {
    enabled,
    description: description || localize('com_ui_certified_agent'),
    canManage: enabled && startupConfig?.canManageAgentCertification === true,
  };
}
