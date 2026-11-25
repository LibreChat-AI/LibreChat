import '@testing-library/jest-dom/extend-expect';
import { useForm, FormProvider, useWatch } from 'react-hook-form';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AgentForm } from '~/common';
import Background from '../Background';

let mockBackgroundEnabled = true;
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useGetAgentsConfig: () => ({ agentsConfig: undefined }),
  useAgentCapabilities: () => ({ backgroundToolsEnabled: mockBackgroundEnabled }),
}));

function OptionsProbe() {
  const value = useWatch<AgentForm>({ name: 'tool_options' });
  return <span data-testid="options">{JSON.stringify(value ?? null)}</span>;
}

function renderBackground(toolIds: string[], defaultValues: Partial<AgentForm> = {}) {
  function Wrapper({ children }: { children: ReactNode }) {
    const methods = useForm<AgentForm>({ defaultValues: defaultValues as AgentForm });
    return (
      <FormProvider {...methods}>
        {children}
        <OptionsProbe />
      </FormProvider>
    );
  }

  return render(
    <Background
      toolIds={toolIds}
      switchId="bg-switch"
      labelKey="com_ui_tool_background"
      infoKey="com_nav_info_tool_background"
    />,
    { wrapper: Wrapper },
  );
}

describe('Background switch', () => {
  beforeEach(() => {
    mockBackgroundEnabled = true;
  });

  test('hidden when the background capability is off', () => {
    mockBackgroundEnabled = false;
    renderBackground(['wolfram']);
    expect(screen.queryByTestId('bg-switch')).toBeNull();
  });

  test('hidden when there are no tool ids to opt in', () => {
    renderBackground([]);
    expect(screen.queryByTestId('bg-switch')).toBeNull();
  });

  test('reflects enabled when ANY grouped id is opted in', () => {
    renderBackground(['execute_code', 'bash_tool'], {
      tool_options: { bash_tool: { run_in_background: true } },
    });
    expect(screen.getByTestId('bg-switch')).toBeChecked();
  });

  test('toggling writes every grouped id and clears entries on disable', () => {
    renderBackground(['execute_code', 'bash_tool']);
    const switchEl = screen.getByTestId('bg-switch');
    expect(switchEl).not.toBeChecked();

    fireEvent.click(switchEl);
    expect(switchEl).toBeChecked();
    const enabled = JSON.parse(screen.getByTestId('options').textContent ?? 'null');
    expect(enabled).toEqual({
      execute_code: { run_in_background: true },
      bash_tool: { run_in_background: true },
    });

    fireEvent.click(switchEl);
    expect(switchEl).not.toBeChecked();
    const disabled = JSON.parse(screen.getByTestId('options').textContent ?? 'null');
    expect(disabled).toEqual({});
  });

  test('preserves unrelated per-tool options when toggling', () => {
    renderBackground(['wolfram'], {
      tool_options: { search_mcp_docs: { defer_loading: true } },
    });
    fireEvent.click(screen.getByTestId('bg-switch'));
    const options = JSON.parse(screen.getByTestId('options').textContent ?? 'null');
    expect(options).toEqual({
      search_mcp_docs: { defer_loading: true },
      wolfram: { run_in_background: true },
    });
  });

  test('reconciles raw and normalized action aliases when enabling', () => {
    const rawToolId = 'getPerson_action_swapi---tech';
    const normalizedToolId = 'getPerson_action_swapi_tech';
    renderBackground([rawToolId], {
      tool_options: {
        [rawToolId]: { run_in_background: true },
        [normalizedToolId]: { defer_loading: true, run_in_background: false },
      },
    });

    const switchEl = screen.getByTestId('bg-switch');
    expect(switchEl).not.toBeChecked();
    fireEvent.click(switchEl);

    expect(JSON.parse(screen.getByTestId('options').textContent ?? 'null')).toEqual({
      [rawToolId]: { run_in_background: true },
      [normalizedToolId]: { defer_loading: true, run_in_background: true },
    });
  });

  test('clears both action aliases when disabling', () => {
    const rawToolId = 'getPerson_action_swapi---tech';
    const normalizedToolId = 'getPerson_action_swapi_tech';
    renderBackground([rawToolId], {
      tool_options: {
        [normalizedToolId]: { defer_loading: true, run_in_background: true },
      },
    });

    const switchEl = screen.getByTestId('bg-switch');
    expect(switchEl).toBeChecked();
    fireEvent.click(switchEl);

    expect(JSON.parse(screen.getByTestId('options').textContent ?? 'null')).toEqual({
      [normalizedToolId]: { defer_loading: true },
    });
  });
});
