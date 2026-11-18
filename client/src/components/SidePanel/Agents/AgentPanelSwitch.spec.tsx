import React from 'react';
import { Provider } from 'jotai';
import { Bot } from 'lucide-react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import { resolveNavigation } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import { FeaturePresentationProvider, FeatureSlot } from '~/components/FeaturePresentation/Context';
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

import AgentPanelSwitch, { AgentEditor } from './AgentPanelSwitch';

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

it('enables visible standalone builder observers without a hydrated conversation', async () => {
  render(
    <Provider>
      <RecoilRoot>
        <MemoryRouter initialEntries={['/agent-builder']}>
          <FeaturePresentationProvider
            features={{ agentBuilder: AgentEditor }}
            links={[{ id: 'agents', icon: Bot, title: 'com_sidepanel_agent_builder' }]}
            navigation={resolveNavigation({ pages: { agentBuilder: { enabled: true } } })}
            onPanelOpen={jest.fn()}
          >
            <FeatureSlot page="agentBuilder" view="page" visible />
          </FeaturePresentationProvider>
        </MemoryRouter>
      </RecoilRoot>
    </Provider>,
  );
  await screen.findByRole('button', { name: 'Minimize' });
  expect(mockObserveToolAuthorization).toHaveBeenLastCalledWith(true);
});
