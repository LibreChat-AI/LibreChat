import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import ConfigReload from '../ConfigReload';

const mockMutate = jest.fn();
const mockAccess = jest.fn();
const mockMutation = jest.fn();

jest.mock('~/data-provider', () => ({
  useReloadCustomConfigMutation: () => mockMutation(),
  useConfigReloadAccessQuery: () => mockAccess(),
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ user: { id: 'u1' } }),
}));

beforeEach(() => {
  mockMutate.mockReset();
  mockAccess.mockReturnValue({ data: true });
  mockMutation.mockReturnValue({ mutate: mockMutate, isLoading: false });
});

describe('ConfigReload', () => {
  it('hides the control without config-management capability', () => {
    mockAccess.mockReturnValue({ data: false });
    render(<ConfigReload />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('disables reload and exposes progress while a request is pending', () => {
    mockMutation.mockReturnValue({ mutate: mockMutate, isLoading: true });
    render(<ConfigReload />);
    expect(screen.getByRole('button', { name: 'com_ui_config_reload_title' })).toBeDisabled();
    expect(screen.getByText('com_ui_config_reload_loading')).toBeVisible();
  });

  it('shows the cluster scope, live changes, and restart-only paths after success', async () => {
    mockMutate.mockImplementation((_variables, options) =>
      options.onSuccess({
        scope: 'cluster',
        distributed: true,
        generation: 2,
        sections: [
          { section: 'endpoints', status: 'applied_live', restartRequired: false },
          {
            section: 'mcpServers',
            status: 'restart_required',
            restartRequired: true,
            restartRequiredPaths: ['mcpServers.docs.url'],
          },
        ],
      }),
    );
    render(<ConfigReload />);
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_config_reload_title' }));
    expect(screen.getByText('com_ui_config_reload_cluster')).toBeInTheDocument();
    expect(screen.getByText('mcpServers.docs.url')).toBeInTheDocument();
    expect(screen.getByText('com_ui_config_reload_restart_required')).toBeInTheDocument();
    expect(screen.getByText('com_ui_config_reload_applied_live')).toBeInTheDocument();
  });

  it('renders validation issues without exposing an old success report on retry', async () => {
    mockMutate
      .mockImplementationOnce((_variables, options) =>
        options.onSuccess({ scope: 'local', distributed: false, sections: [] }),
      )
      .mockImplementationOnce((_variables, options) =>
        options.onError({
          isAxiosError: true,
          response: {
            status: 400,
            data: {
              error: 'Custom config validation failed',
              validationErrors: [{ path: ['endpoints', 'custom'], message: 'Unsupported model' }],
            },
          },
        }),
      );
    render(<ConfigReload />);
    const button = screen.getByRole('button', { name: 'com_ui_config_reload_title' });
    await userEvent.click(button);
    expect(screen.getByText('com_ui_config_reload_local')).toBeInTheDocument();
    await userEvent.click(button);
    expect(screen.queryByText('com_ui_config_reload_local')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('endpoints.custom: Unsupported model');
  });

  it('shows a permission error for rejected admin roles', async () => {
    mockMutate.mockImplementation((_variables, options) =>
      options.onError({ isAxiosError: true, response: { status: 403 } }),
    );
    render(<ConfigReload />);
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_config_reload_title' }));
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_config_reload_forbidden');
  });

  it('warns that failed propagation stayed local and can be retried', async () => {
    mockMutate.mockImplementation((_variables, options) =>
      options.onSuccess({
        scope: 'local',
        distributed: false,
        propagationError: 'Redis generation update failed',
        sections: [],
      }),
    );
    render(<ConfigReload />);
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_config_reload_title' }));
    expect(screen.getByText('com_ui_config_reload_local')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_config_reload_propagation_error');
  });
});
