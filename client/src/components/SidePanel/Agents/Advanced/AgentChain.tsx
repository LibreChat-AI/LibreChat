import { ListOrdered } from 'lucide-react';
import { Button } from '@librechat/client';
import type { ControllerRenderProps } from 'react-hook-form';
import type { AgentForm } from '~/common';
import OrchestrationPattern from './OrchestrationPattern';
import { useSelectableAgents } from './AgentList';
import { useLocalize } from '~/hooks';
import { CountPill } from './ui';

interface AgentChainProps {
  field: ControllerRenderProps<AgentForm, 'agent_ids'>;
  currentAgentId: string;
}

export default function AgentChain({ field, currentAgentId }: AgentChainProps) {
  const localize = useLocalize();
  const agentIds = field.value ?? [];
  const { getAgent } = useSelectableAgents({ currentAgentId });

  if (agentIds.length === 0) {
    return null;
  }

  return (
    <OrchestrationPattern
      icon={<ListOrdered className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />}
      title={localize('com_ui_agent_chain')}
      subtitle={localize('com_ui_agent_chain_deprecated')}
      info={<p className="text-text-secondary text-sm">{localize('com_ui_agent_chain_info')}</p>}
      trailing={<CountPill>{agentIds.length}</CountPill>}
    >
      <ol className="flex flex-col gap-1" aria-label={localize('com_ui_agent_chain')}>
        {agentIds.map((agentId, index) => (
          <li key={`${agentId}-${index}`} className="text-text-secondary text-sm">
            {index + 1}. {getAgent(agentId)?.name ?? agentId}
          </li>
        ))}
      </ol>
      <p className="text-text-secondary text-sm">{localize('com_ui_agent_chain_migrate')}</p>
      <Button type="button" variant="outline" onClick={() => field.onChange([])}>
        {localize('com_ui_agent_chain_remove')}
      </Button>
    </OrchestrationPattern>
  );
}
