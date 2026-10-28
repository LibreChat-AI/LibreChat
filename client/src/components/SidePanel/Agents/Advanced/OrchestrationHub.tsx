import { Controller, useFormContext } from 'react-hook-form';
import { AgentCapabilities, MAX_SUBAGENTS } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import { useAgentPanelContext } from '~/Providers';
import AgentSubagents from './AgentSubagents';
import AgentHandoffs from './AgentHandoffs';

interface OrchestrationHubProps {
  currentAgentId: string;
  tool: 'subagents' | 'handoffs';
}

/** Settings for one native collaboration tool, never the other tool's fields. */
export default function OrchestrationHub({ currentAgentId, tool }: OrchestrationHubProps) {
  const { control } = useFormContext<AgentForm>();
  const { agentsConfig } = useAgentPanelContext();

  if (tool === 'subagents') {
    if (!agentsConfig?.capabilities.includes(AgentCapabilities.subagents)) {
      return null;
    }
    return (
      <Controller
        name="subagents"
        control={control}
        render={({ field }) => (
          <AgentSubagents
            field={field}
            currentAgentId={currentAgentId}
            maxSubagents={agentsConfig.maxSubagents ?? MAX_SUBAGENTS}
            fileSharingEnabled={agentsConfig.fileSharing?.enabled === true}
          />
        )}
      />
    );
  }

  return (
    <Controller
      name="edges"
      control={control}
      defaultValue={[]}
      render={({ field }) => <AgentHandoffs field={field} currentAgentId={currentAgentId} />}
    />
  );
}
