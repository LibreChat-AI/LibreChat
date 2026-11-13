import { useContext } from 'react';
import { useRecoilValue } from 'recoil';
import {
  FeatureSlot,
  FeatureVisibility,
  useFeaturePresentation,
} from '~/components/FeaturePresentation/Context';
import { AgentPanelProvider, useAgentPanelContext } from '~/Providers/AgentPanelContext';
import PresentationActions from '~/components/FeaturePresentation/Actions';
import { Panel, isEphemeralAgent } from '~/common';
import VersionPanel from './Version/VersionPanel';
import AgentPanel from './AgentPanel';
import store from '~/store';

/** The sidebar is only a placement slot. The authenticated host owns the editor lifetime. */
export default function AgentPanelSwitch() {
  const presentation = useFeaturePresentation();
  const visible = useContext(FeatureVisibility);
  return presentation ? (
    <FeatureSlot page="agentBuilder" view="panel" visible={visible} />
  ) : (
    <AgentEditor visible={visible} />
  );
}

export function AgentEditor({ visible }: { visible: boolean }) {
  const conversation = useRecoilValue(store.conversationByIndex(0));
  const agentId = conversation?.agent_id ?? null;
  return (
    <AgentPanelProvider
      visible={visible}
      conversationReady={conversation != null}
      initialAgentId={agentId}
      observeToolAuthorization={conversation != null && !isEphemeralAgent(agentId)}
    >
      <PresentationActions page="agentBuilder" />
      <AgentPanelSwitchWithContext />
    </AgentPanelProvider>
  );
}

function AgentPanelSwitchWithContext() {
  const { activePanel } = useAgentPanelContext();
  return activePanel === Panel.version ? <VersionPanel /> : <AgentPanel />;
}
