import '@testing-library/jest-dom/extend-expect';
import { AuthTypeEnum } from 'librechat-data-provider';
import { useForm, FormProvider, useWatch } from 'react-hook-form';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Action, Agent } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { AgentForm } from '~/common';
import ActionBackground from '../Background';

let mockBackgroundEnabled = true;
let mockAction: Partial<Action> | undefined;
let mockAgent: Partial<Agent> | undefined;

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useGetAgentsConfig: () => ({ agentsConfig: undefined }),
  useAgentCapabilities: () => ({ backgroundToolsEnabled: mockBackgroundEnabled }),
}));
jest.mock('~/Providers', () => ({
  useAgentPanelContext: () => ({ action: mockAction }),
}));
jest.mock('~/data-provider', () => ({
  useGetExpandedAgentByIdQuery: () => ({ data: mockAgent }),
}));

function OptionsProbe() {
  const value = useWatch<AgentForm>({ name: 'tool_options' });
  return <span data-testid="options">{JSON.stringify(value ?? null)}</span>;
}

function renderActionBackground(defaultValues: Partial<AgentForm> = {}) {
  function Wrapper({ children }: { children: ReactNode }) {
    const methods = useForm<AgentForm>({ defaultValues: defaultValues as AgentForm });
    return (
      <FormProvider {...methods}>
        {children}
        <OptionsProbe />
      </FormProvider>
    );
  }

  return render(<ActionBackground agentId="agent_abc" />, { wrapper: Wrapper });
}

describe('ActionBackground', () => {
  beforeEach(() => {
    mockBackgroundEnabled = true;
    mockAction = { action_id: 'act123', metadata: {} };
    mockAgent = {
      id: 'agent_abc',
      tools: [
        'getWeather_action_weather---com',
        'getForecast_action_weather---com',
        'sendMail_action_mail---com',
        'web_search',
      ],
      actions: ['weather---com_action_act123', 'mail---com_action_act456'],
    };
  });

  test('toggling opts in every operation of this action and no other tools', () => {
    renderActionBackground();
    const switchEl = screen.getByTestId('action-background-tools');
    expect(switchEl).not.toBeChecked();

    fireEvent.click(switchEl);
    const options = JSON.parse(screen.getByTestId('options').textContent ?? 'null');
    expect(options).toEqual({
      'getWeather_action_weather---com': { run_in_background: true },
      getWeather_action_weather_com: { run_in_background: true },
      'getForecast_action_weather---com': { run_in_background: true },
      getForecast_action_weather_com: { run_in_background: true },
    });
  });

  test('reflects enabled when one operation is already opted in', () => {
    renderActionBackground({
      tool_options: { 'getForecast_action_weather---com': { run_in_background: true } },
    });
    expect(screen.getByTestId('action-background-tools')).toBeChecked();
  });

  test('opts in only the selected action when two actions share a hostname', () => {
    mockAgent = {
      id: 'agent_abc',
      tools: [
        'getWeather_action_api---example---com',
        'sendMail_action_api---example---com',
        'web_search',
      ],
      actions: ['api---example---com_action_act123', 'api---example---com_action_act456'],
    };
    mockAction = {
      action_id: 'act123',
      metadata: {
        raw_spec: JSON.stringify({
          openapi: '3.0.0',
          info: { title: 'Weather', version: '1.0.0' },
          servers: [{ url: 'https://api.example.com' }],
          paths: {
            '/weather': {
              get: { operationId: 'getWeather', responses: { '200': { description: 'ok' } } },
            },
          },
        }),
      },
    };

    renderActionBackground();
    fireEvent.click(screen.getByTestId('action-background-tools'));
    const options = JSON.parse(screen.getByTestId('options').textContent ?? 'null');
    expect(options).toEqual({
      'getWeather_action_api---example---com': { run_in_background: true },
      getWeather_action_api_example_com: { run_in_background: true },
    });
  });

  test('hides rather than guesses when a shared-hostname spec cannot be parsed', () => {
    mockAgent = {
      id: 'agent_abc',
      tools: ['getWeather_action_api---example---com', 'sendMail_action_api---example---com'],
      actions: ['api---example---com_action_act123', 'api---example---com_action_act456'],
    };
    mockAction = { action_id: 'act123', metadata: {} };

    renderActionBackground();
    expect(screen.queryByTestId('action-background-tools')).toBeNull();
  });

  test('hidden for OAuth actions', () => {
    mockAction = { action_id: 'act123', metadata: { auth: { type: AuthTypeEnum.OAuth } } };
    renderActionBackground();
    expect(screen.queryByTestId('action-background-tools')).toBeNull();
  });

  test('hidden when every operation owns the run_in_background parameter', () => {
    mockAgent = {
      id: 'agent_abc',
      tools: ['getWeather_action_weather---com'],
      actions: ['weather---com_action_act123'],
    };
    mockAction = {
      action_id: 'act123',
      metadata: {
        raw_spec: JSON.stringify({
          openapi: '3.0.0',
          info: { title: 'Weather', version: '1.0.0' },
          servers: [{ url: 'https://weather.com' }],
          paths: {
            '/weather': {
              get: {
                operationId: 'getWeather',
                parameters: [
                  {
                    name: 'run_in_background',
                    in: 'query',
                    schema: { type: 'boolean' },
                  },
                ],
                responses: { '200': { description: 'ok' } },
              },
            },
          },
        }),
      },
    };

    renderActionBackground();
    expect(screen.queryByTestId('action-background-tools')).toBeNull();
  });

  test('hidden when the action is not registered on the agent', () => {
    mockAction = { action_id: 'act999', metadata: {} };
    renderActionBackground();
    expect(screen.queryByTestId('action-background-tools')).toBeNull();
  });

  test('hidden when the background capability is off', () => {
    mockBackgroundEnabled = false;
    renderActionBackground();
    expect(screen.queryByTestId('action-background-tools')).toBeNull();
  });
});
