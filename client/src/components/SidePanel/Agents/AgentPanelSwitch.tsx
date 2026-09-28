import { useEffect } from 'react';
import { useRecoilValue } from 'recoil';
import { AgentPanelProvider, useAgentPanelContext } from '~/Providers/AgentPanelContext';
import { Panel, isEphemeralAgent } from '~/common';
import VersionPanel from './Version/VersionPanel';
import AgentPanel from './AgentPanel';
import store from '~/store';

export default function AgentPanelSwitch() {
  const conversation = useRecoilValue(store.conversationByIndex(0));
  const agentId = conversation?.agent_id ?? null;
  return (
    <AgentPanelProvider
      observeToolAuthorization={conversation != null && !isEphemeralAgent(agentId)}
    >
      <AgentPanelSwitchWithContext agentId={agentId} />
    </AgentPanelProvider>
  );
}

function AgentPanelSwitchWithContext({ agentId }: { agentId?: string | null }) {
  const { activePanel, setCurrentAgentId } = useAgentPanelContext();

  useEffect(() => {
    const agent_id = agentId ?? '';
    if (!isEphemeralAgent(agent_id)) {
      setCurrentAgentId(agent_id);
    }
  }, [setCurrentAgentId, agentId]);

  if (activePanel === Panel.version) {
    return <VersionPanel />;
  }
  return <AgentPanel />;
}
