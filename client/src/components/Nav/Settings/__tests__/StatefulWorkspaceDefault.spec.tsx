import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import StatefulWorkspaceDefault from '../StatefulWorkspaceDefault';

const mockMutate = jest.fn();
const mockShowToast = jest.fn();
let mockAllowedEnvironments: Array<'user' | 'agent-user' | 'conversation'> | undefined;

jest.mock('@librechat/client', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
    children: ReactNode;
  }) => (
    <select
      aria-label="workspace-default"
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => children,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({
    value,
    children,
    disabled,
  }: {
    value: string;
    children: ReactNode;
    disabled?: boolean;
  }) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  ),
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

    expect(screen.getByRole('combobox', { name: 'workspace-default' })).toHaveValue('agent-user');
  });

  it('persists a new default for future agents', async () => {
    render(<StatefulWorkspaceDefault />);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'workspace-default' }),
      'conversation',
    );

    expect(mockMutate).toHaveBeenCalledWith({ statefulCodeEnvironment: 'conversation' });
  });

  it('only enables deployment-allowed scopes while preserving the saved value', () => {
    mockAllowedEnvironments = ['user'];

    render(<StatefulWorkspaceDefault />);

    expect(
      screen.getByRole('option', { name: 'com_ui_stateful_code_environment_user' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('option', { name: 'com_ui_stateful_code_environment_agent_user' }),
    ).toBeDisabled();
    expect(
      screen.queryByRole('option', { name: 'com_ui_stateful_code_environment_conversation' }),
    ).not.toBeInTheDocument();
  });
});
