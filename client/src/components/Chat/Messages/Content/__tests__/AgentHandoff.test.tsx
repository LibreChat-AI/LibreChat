import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import { QueryKeys, Constants } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AgentHandoff from '../AgentHandoff';
/** Registers the app's host, which resolves the target agent the card names, and the renderers
 *  that host draws the agent's icon with. */
import '~/Providers/MessagePartsHostContext';
import '../Parts/renderers';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) =>
    (
      ({ com_ui_transferred_to: 'Transferred to', com_ui_agent: 'Agent' }) as Record<string, string>
    )[key] ?? key,
}));

/** The card is the chat package's and reads the localizer from here, so it delegates to the `~/hooks` mock. */
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => jest.requireMock('~/hooks').useLocalize(),
}));

jest.mock('~/Providers/AgentsMapContext', () => ({
  useAgentsMapContext: () => ({
    'agent-123': { name: 'Test Agent' },
  }),
}));

jest.mock('~/components/Share/MessageIcon', () => ({
  __esModule: true,
  default: () => <div data-testid="message-icon" />,
}));

function renderAgentHandoff(name: string, configuredTargets: Array<{ id: string; name: string }>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData([QueryKeys.modelSpecHandoffs], configuredTargets);
  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <AgentHandoff name={name} args="" />
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

describe('AgentHandoff under the app host', () => {
  it('names a saved agent from the agents map and draws the app icon', () => {
    renderAgentHandoff(Constants.LC_TRANSFER_TO_ + 'agent-123', []);

    expect(screen.getByRole('button', { name: 'Transferred to Test Agent' })).toBeInTheDocument();
    expect(screen.getByTestId('message-icon')).toBeInTheDocument();
  });

  it('shows the configured label for a preset handoff outside the saved-agent map', () => {
    const id = Constants.MODEL_SPEC_AGENT_PREFIX + '123';
    renderAgentHandoff(Constants.LC_TRANSFER_TO_ + id, [{ id, name: 'Preset Specialist' }]);

    expect(
      screen.getByRole('button', { name: 'Transferred to Preset Specialist' }),
    ).toBeInTheDocument();
  });
});
