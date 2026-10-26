import React from 'react';
import { useLocalize } from '@librechat/client';
import { useMessagePartsHost } from '../react/host';

interface AgentUpdateProps {
  currentAgentId: string;
}

const AgentUpdate: React.FC<AgentUpdateProps> = ({ currentAgentId }) => {
  const localize = useLocalize();
  const { useAgent, renderAgentIcon } = useMessagePartsHost();
  const currentAgent = useAgent(currentAgentId);
  if (!currentAgentId) {
    return null;
  }
  return (
    <div className="relative">
      <div className="absolute -left-6 flex h-full w-4 items-center justify-center">
        <div className="relative h-full w-4">
          <div className="border-border-medium absolute top-0 left-0 h-1/2 w-px border"></div>
          <div className="border-border-medium absolute top-1/2 left-0 h-px w-3 border"></div>
        </div>
      </div>
      <div className="my-4 flex items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full">
          {renderAgentIcon(currentAgent)}
        </div>
        <div className="text-text-primary text-base font-medium">
          {currentAgent?.name || localize('com_ui_agent')}
        </div>
      </div>
    </div>
  );
};

export default AgentUpdate;
