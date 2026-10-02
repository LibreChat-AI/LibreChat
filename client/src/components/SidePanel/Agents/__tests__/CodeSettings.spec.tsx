/** @jest-environment jsdom */
/* eslint-disable i18next/no-literal-string -- Test harness controls are not product UI. */
import { useState } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { AgentCapabilities } from 'librechat-data-provider';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AgentForm } from '~/common';
import CodeSettings from '../Code/Settings';
const mockWorkspaceStatusQueries = jest.fn();
jest.mock('~/data-provider', () => ({
  useCodeEnvironmentStatusQueries: () => mockWorkspaceStatusQueries(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ user: {} }),
  useGetAgentsConfig: () => ({
    agentsConfig: {
      capabilities: ['stateful_code_sessions'],
      statefulCodeSessions: {
        environments: [{ id: 'byom', name: 'My machine', type: 'attached', default: true }],
      },
    },
  }),
}));

beforeEach(() => {
  mockWorkspaceStatusQueries.mockReturnValue([
    {
      data: {
        status: 'ready',
        environmentId: 'byom',
        workspaces: [{ id: 'project-a', name: 'Project A' }],
      },
      isLoading: false,
      isError: false,
    },
  ]);
});

function IdentityForm({
  savedIdentity,
  savedWorkspace,
}: {
  savedIdentity?: AgentForm['git_identity'];
  savedWorkspace?: string;
}) {
  const [dialogOpen, setDialogOpen] = useState(true);
  const methods = useForm<AgentForm>({
    mode: 'onChange',
    defaultValues: {
      execute_code: true,
      stateful_code_sessions: true,
      git_identity: savedIdentity,
      code_workspace_id: savedWorkspace,
    },
  });
  return (
    <FormProvider {...methods}>
      {dialogOpen && <CodeSettings />}
      <button onClick={() => setDialogOpen(!dialogOpen)}>Toggle Dialog</button>
      <button onClick={() => methods.setValue(AgentCapabilities.execute_code, false)}>
        Disable code
      </button>
      <button onClick={() => methods.setValue('code_environment_id', 'managed')}>
        Use managed
      </button>
      <button onClick={() => methods.setValue(AgentCapabilities.stateful_code_sessions, false)}>
        Disable sessions
      </button>
      <output data-testid="identity">{JSON.stringify(methods.watch('git_identity'))}</output>
      <output data-testid="workspace-default">{methods.watch('code_workspace_id')}</output>
      <output data-testid="machine-default">{methods.watch('code_environment_id')}</output>
      <output data-testid="repository-mode">{methods.watch('repositoryInstructions')}</output>
    </FormProvider>
  );
}

test('repository instruction mode defaults to prefer and retains an explicit off choice', async () => {
  HTMLElement.prototype.scrollIntoView = jest.fn();
  render(<IdentityForm />);
  expect(
    screen.getByRole('combobox', { name: 'com_ui_repository_instructions' }),
  ).toHaveTextContent('com_ui_repository_instructions_prefer');
  fireEvent.click(screen.getByRole('combobox', { name: 'com_ui_repository_instructions' }));
  fireEvent.click(
    await screen.findByRole('option', { name: 'com_ui_repository_instructions_off' }),
  );
  expect(screen.getByTestId('repository-mode')).toHaveTextContent('off');
  fireEvent.click(screen.getByText('Toggle Dialog'));
  fireEvent.click(screen.getByText('Toggle Dialog'));
  expect(
    screen.getByRole('combobox', { name: 'com_ui_repository_instructions' }),
  ).toHaveTextContent('com_ui_repository_instructions_off');
});

test('saves a workspace default bound to the selected machine and permits clearing it', async () => {
  HTMLElement.prototype.scrollIntoView = jest.fn();
  render(<IdentityForm />);
  fireEvent.click(screen.getByRole('combobox', { name: 'com_ui_code_workspace_default' }));
  fireEvent.click(await screen.findByRole('option', { name: 'Project A' }));
  expect(screen.getByTestId('workspace-default')).toHaveTextContent('project-a');
  expect(screen.getByTestId('machine-default')).toHaveTextContent('byom');
  fireEvent.click(screen.getByRole('combobox', { name: 'com_ui_code_workspace_default' }));
  fireEvent.click(await screen.findByRole('option', { name: 'com_ui_code_workspace_last_used' }));
  expect(screen.getByTestId('workspace-default')).toBeEmptyDOMElement();
});

test.each([
  [{ isLoading: true, isError: false }, 'com_ui_code_workspace_loading'],
  [{ isLoading: false, isError: true }, 'com_ui_code_workspace_unavailable'],
  [
    {
      isLoading: false,
      isError: false,
      data: { status: 'ready', environmentId: 'byom', workspaces: undefined },
    },
    'com_ui_code_workspace_unsupported',
  ],
])('preserves a saved workspace while discovery reports %s', (query, expectedLabel) => {
  mockWorkspaceStatusQueries.mockReturnValue([query]);
  render(<IdentityForm savedWorkspace="project-a" />);

  expect(screen.getByText(expectedLabel, { selector: 'p[role="status"]' })).toBeInTheDocument();
  expect(screen.getByTestId('workspace-default')).toHaveTextContent('project-a');
  expect(screen.queryByText(/com_ui_code_workspace_missing/)).not.toBeInTheDocument();
});

test('permits clearing a saved workspace while discovery is unavailable', async () => {
  HTMLElement.prototype.scrollIntoView = jest.fn();
  mockWorkspaceStatusQueries.mockReturnValue([{ isLoading: false, isError: true }]);
  render(<IdentityForm savedWorkspace="project-a" />);

  fireEvent.click(screen.getByRole('combobox', { name: 'com_ui_code_workspace_default' }));
  fireEvent.click(await screen.findByRole('option', { name: 'com_ui_code_workspace_last_used' }));

  expect(screen.getByTestId('workspace-default')).toBeEmptyDOMElement();
});

test.each(['', 'not-an-email'])(
  'restores the saved identity when reopening an invalid draft: %s',
  async (email) => {
    render(<IdentityForm savedIdentity={{ name: 'Saved Agent', email: 'saved@example.com' }} />);
    fireEvent.change(screen.getByLabelText('com_ui_agent_git_email'), {
      target: { value: email },
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Toggle Dialog'));
    fireEvent.click(screen.getByText('Toggle Dialog'));
    expect(screen.getByLabelText('com_ui_agent_git_name')).toHaveValue('Saved Agent');
    expect(screen.getByLabelText('com_ui_agent_git_email')).toHaveValue('saved@example.com');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  },
);

test('clears cross-field errors when completing or clearing a Git identity', async () => {
  render(<IdentityForm />);
  const name = screen.getByLabelText('com_ui_agent_git_name');
  const email = screen.getByLabelText('com_ui_agent_git_email');
  fireEvent.change(name, { target: { value: 'Coding Agent' } });
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  fireEvent.change(email, { target: { value: 'agent@example.com' } });
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  fireEvent.change(name, { target: { value: '' } });
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  fireEvent.change(email, { target: { value: '' } });
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});

test.each(['Disable code', 'Use managed', 'Disable sessions', 'Toggle Dialog'])(
  'discards a partial identity when its controls disappear: %s',
  async (action) => {
    render(<IdentityForm />);
    fireEvent.change(screen.getByLabelText('com_ui_agent_git_name'), {
      target: { value: 'Partial Agent' },
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByText(action));
    await waitFor(() => expect(screen.getByTestId('identity')).toBeEmptyDOMElement());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  },
);

test.each(['Disable code', 'Use managed', 'Disable sessions', 'Toggle Dialog'])(
  'discards an invalid email when its controls disappear: %s',
  async (action) => {
    render(<IdentityForm />);
    fireEvent.change(screen.getByLabelText('com_ui_agent_git_name'), {
      target: { value: 'Coding Agent' },
    });
    fireEvent.change(screen.getByLabelText('com_ui_agent_git_email'), {
      target: { value: 'not-an-email' },
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByText(action));
    await waitFor(() => expect(screen.getByTestId('identity')).toBeEmptyDOMElement());
  },
);

test.each([
  { name: 'Coding Agent', email: 'agent@example.com' },
  {
    name: 'Lia',
    email: '328778573+lia-by-librechat[bot]@users.noreply.github.com',
  },
  { name: '', email: '' },
])('retains a valid identity or explicit clear through panel navigation: %j', async (identity) => {
  render(<IdentityForm />);
  fireEvent.change(screen.getByLabelText('com_ui_agent_git_name'), {
    target: { value: identity.name },
  });
  fireEvent.change(screen.getByLabelText('com_ui_agent_git_email'), {
    target: { value: identity.email },
  });
  expect(screen.getByLabelText('com_ui_agent_git_email')).toHaveAttribute('type', 'text');
  fireEvent.click(screen.getByText('Toggle Dialog'));
  expect(screen.getByTestId('identity')).toHaveTextContent(JSON.stringify(identity));
  fireEvent.click(screen.getByText('Toggle Dialog'));
  expect(screen.getByLabelText('com_ui_agent_git_name')).toHaveValue(identity.name);
  expect(screen.getByLabelText('com_ui_agent_git_email')).toHaveValue(identity.email);
  fireEvent.change(screen.getByLabelText('com_ui_agent_git_email'), {
    target: { value: 'invalid' },
  });
  expect(await screen.findByRole('alert')).toBeInTheDocument();
});

test('preserves a complete identity when switching away from the attached environment', async () => {
  render(<IdentityForm />);
  fireEvent.change(screen.getByLabelText('com_ui_agent_git_name'), {
    target: { value: 'Coding Agent' },
  });
  fireEvent.change(screen.getByLabelText('com_ui_agent_git_email'), {
    target: { value: 'agent@example.com' },
  });
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  fireEvent.click(screen.getByText('Use managed'));
  expect(screen.getByTestId('identity')).toHaveTextContent('Coding Agent');
  expect(screen.getByTestId('identity')).toHaveTextContent('agent@example.com');
});
