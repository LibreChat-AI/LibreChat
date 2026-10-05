import { useMemo } from 'react';
import { useFormContext, Controller } from 'react-hook-form';
import { AgentCapabilities, MAX_SUBAGENTS } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import { useAgentPanelContext } from '~/Providers';
import AgentSubagents from './AgentSubagents';
import AgentHandoffs from './AgentHandoffs';
import { groupHeadingClass } from './ui';
import { useLocalize } from '~/hooks';

interface OrchestrationHubProps {
  currentAgentId: string;
}

/**
 * Settings for the native orchestration tool. Handoffs are always available.
 */
export default function OrchestrationHub({ currentAgentId }: OrchestrationHubProps) {
  const localize = useLocalize();
  const { control } = useFormContext<AgentForm>();
  const { agentsConfig } = useAgentPanelContext();

  const subagentsEnabled = useMemo(
    () => agentsConfig?.capabilities.includes(AgentCapabilities.subagents) ?? false,
    [agentsConfig],
  );
  const maxSubagents = agentsConfig?.maxSubagents ?? MAX_SUBAGENTS;

  return (
    <section className="flex flex-col gap-1">
      <div className="flex flex-col gap-0.5">
        <span className={groupHeadingClass}>{localize('com_ui_agent_orchestration')}</span>
        <p className="text-text-secondary text-xs">{localize('com_ui_agent_orchestration_hint')}</p>
      </div>
      <div className="divide-border-light divide-y">
        {subagentsEnabled && (
          <Controller
            name="subagents"
            control={control}
            render={({ field }) => (
              <AgentSubagents
                field={field}
                currentAgentId={currentAgentId}
                maxSubagents={maxSubagents}
                fileSharingEnabled={agentsConfig?.fileSharing?.enabled === true}
              />
            )}
          />
        )}
        <Controller
          name="edges"
          control={control}
          defaultValue={[]}
          render={({ field }) => <AgentHandoffs field={field} currentAgentId={currentAgentId} />}
        />
      </div>
    </section>
  );
}
