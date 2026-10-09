import type { TAgentsEndpoint } from 'librechat-data-provider';

type AgentEventRuntimeConfig = NonNullable<TAgentsEndpoint['eventDriven']>;

/** Applies the optional base-config routing choice before the event listener starts. */
export const configureAgentEventRuntime = (config?: AgentEventRuntimeConfig): void => {
  if (config?.selfUrl != null) {
    process.env.AGENT_TRIGGERS_SELF_URL = config.selfUrl;
  }
};
