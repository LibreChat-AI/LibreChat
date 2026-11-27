import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import StatefulWorkspaceDefault from '../StatefulWorkspaceDefault';

const mockMutate = jest.fn();
const mockShowToast = jest.fn();
let mockAllowedEnvironments: Array<'user' | 'agent-user' | 'conversation'> | undefined;

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useGetAgentsConfig: () => ({
    agentsConfig: {
      capabilities: ['stateful_code_sessions'],
      statefulCodeSessions:
        mockAllowedEnvironments == null
          ? undefined
          : { allowedEnvironments: mockAllowedEnvironments },
    },
  }),
}));

jest.mock('~/data-provider', () => ({
  useGetUserQuery: () => ({
    data: { personalization: { statefulCodeEnvironment: 'agent-user' } },
  }),
  useUpdateUserPreferencesMutation: () => ({
    mutate: mockMutate,
    isLoading: false,
  }),
}));

describe('StatefulWorkspaceDefault', () => {
  beforeEach(() => {
    mockMutate.mockClear();
    mockAllowedEnvironments = undefined;
  });

  it('shows the saved user preference', () => {
    render(<StatefulWorkspaceDefault />);

    expect(screen.getByTestId('default-stateful-workspace')).toHaveTextContent(
      'com_ui_stateful_code_environment_agent_user',
    );
  });

  it('describes the trigger with the workspace explanation', () => {
    render(<StatefulWorkspaceDefault />);

    expect(screen.getByTestId('default-stateful-workspace')).toHaveAccessibleDescription(
      'com_ui_default_stateful_workspace_description',
    );
  });

  it('persists a new default for future agents', async () => {
    render(<StatefulWorkspaceDefault />);

    await userEvent.click(screen.getByTestId('default-stateful-workspace'));
    await userEvent.click(
      await screen.findByRole('option', { name: 'com_ui_stateful_code_environment_conversation' }),
    );

    expect(mockMutate).toHaveBeenCalledWith({ statefulCodeEnvironment: 'conversation' });
  });

  it('lists the saved disallowed scope as disabled', async () => {
    mockAllowedEnvironments = ['user'];

    render(<StatefulWorkspaceDefault />);
    await userEvent.click(screen.getByTestId('default-stateful-workspace'));

    expect(
      await screen.findByRole('option', { name: 'com_ui_stateful_code_environment_user' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'com_ui_stateful_code_environment_agent_user' }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.queryByRole('option', { name: 'com_ui_stateful_code_environment_conversation' }),
    ).not.toBeInTheDocument();
  });
});
