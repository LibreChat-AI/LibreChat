/** @jest-environment jsdom */
import { FormProvider, useForm } from 'react-hook-form';
import { render, screen, waitFor } from '@testing-library/react';
import type { AgentForm } from '~/common';
import { composeAgentUpdatePayload } from '../AgentPanel';
import CodeSettings from '../Code/Settings';

let mockProfile: 'default' | 'stateful' | undefined;
let mockCapabilities: string[];
jest.mock('~/data-provider', () => ({
  useCodeEnvironmentStatusQueries: () => [],
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ user: {} }),
  useGetAgentsConfig: () => ({
    agentsConfig: { capabilities: mockCapabilities, codeDefaultProfile: mockProfile },
  }),
}));

let form: ReturnType<typeof useForm<AgentForm>>;
function Harness({ stateful = false }: { stateful?: boolean }) {
  form = useForm<AgentForm>({
    defaultValues: { execute_code: true, stateful_code_sessions: stateful, provider: 'openAI' },
  });
  return (
    <FormProvider {...form}>
      <CodeSettings />
    </FormProvider>
  );
}

beforeEach(() => {
  mockProfile = 'stateful';
  mockCapabilities = ['stateful_code_sessions'];
});

describe.each([false, true])('statefulByDeployment, saved flag %s', (saved) => {
  it('hides the switch, shows the options and forces the form value', async () => {
    render(<Harness stateful={saved} />);
    expect(screen.queryByTestId('stateful-code-sessions')).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'com_ui_stateful_sessions' })).toBeInTheDocument();
    expect(screen.getByTestId('stateful-code-environment')).toBeInTheDocument();
    await waitFor(() => expect(form.getValues('stateful_code_sessions')).toBe(true));
    expect(form.getValues('stateful_code_environment')).toBe('user');
    expect(form.formState.dirtyFields.stateful_code_sessions).toBeUndefined();
    expect(form.formState.dirtyFields.stateful_code_environment).toBeUndefined();
  });
});

it('saves stateful_code_sessions true when execute_code is on', async () => {
  render(<Harness />);
  await waitFor(() => expect(form.getValues('stateful_code_sessions')).toBe(true));
  const { payload } = composeAgentUpdatePayload(form.getValues(), 'agent_1', undefined, {
    instructionsPromptChanged: false,
  });
  expect(payload.stateful_code_sessions).toBe(true);
});

it('keeps today behaviour when the profile is unset', () => {
  mockProfile = undefined;
  render(<Harness />);
  expect(screen.getByTestId('stateful-code-sessions')).toHaveAttribute('aria-checked', 'false');
  expect(screen.queryByTestId('stateful-code-environment')).not.toBeInTheDocument();
  expect(form.getValues('stateful_code_sessions')).toBe(false);
});

it('renders nothing when the capability is off', () => {
  mockCapabilities = [];
  const { container } = render(<Harness />);
  expect(container).toBeEmptyDOMElement();
});
