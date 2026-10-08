import React from 'react';
import { RecoilRoot } from 'recoil';
import { render } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import store from '~/store';

const mockObserveToolAuthorization = jest.fn();
const mockSetCurrentAgentId = jest.fn();

jest.mock('~/Providers/AgentPanelContext', () => ({
  AgentPanelProvider: ({
    children,
    observeToolAuthorization,
  }: {
    children: React.ReactNode;
    observeToolAuthorization: boolean;
  }) => {
    mockObserveToolAuthorization(observeToolAuthorization);
    return children;
  },
  useAgentPanelContext: () => ({
    activePanel: 'builder',
    setCurrentAgentId: mockSetCurrentAgentId,
  }),
}));
jest.mock('./AgentPanel', () => () => null);
jest.mock('./Version/VersionPanel', () => () => null);

import AgentPanelSwitch from './AgentPanelSwitch';

function renderWithConversation(conversation?: TConversation) {
  return render(
    <RecoilRoot
      initializeState={({ set }) => {
        if (conversation != null) {
          set(store.conversationByIndex(0), conversation);
        }
      }}
    >
      <AgentPanelSwitch />
    </RecoilRoot>,
  );
}

describe('AgentPanelSwitch authorization observers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('holds observers until the conversation is hydrated', () => {
    renderWithConversation();
    expect(mockObserveToolAuthorization).toHaveBeenLastCalledWith(false);
  });

  it('enables observers for a hydrated persistent agent', () => {
    renderWithConversation({
      conversationId: 'new',
      endpoint: EModelEndpoint.agents,
      agent_id: 'agent_1',
    } as TConversation);
    expect(mockObserveToolAuthorization).toHaveBeenLastCalledWith(true);
  });

  it('keeps observers disabled for a hydrated ephemeral agent', () => {
    renderWithConversation({
      conversationId: 'new',
      endpoint: EModelEndpoint.agents,
      agent_id: 'ephemeral',
    } as TConversation);
    expect(mockObserveToolAuthorization).toHaveBeenLastCalledWith(false);
  });
});
