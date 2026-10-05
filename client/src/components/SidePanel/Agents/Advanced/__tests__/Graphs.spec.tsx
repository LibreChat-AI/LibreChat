import { useForm, FormProvider } from 'react-hook-form';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { EModelEndpoint, AgentCapabilities, Tools } from 'librechat-data-provider';
import type {
  AgentSubagentsConfig,
  TAgentsEndpoint,
  TAgentsMap,
  Agent,
} from 'librechat-data-provider';
import type { UseFormReturn } from 'react-hook-form';
import type { AgentForm } from '~/common';
import Graphs from '../Graphs';

let mockAgentsConfig: Partial<TAgentsEndpoint> = {
  maxSubagents: 2,
  capabilities: [
    AgentCapabilities.subagents,
    AgentCapabilities.subagent_graphs,
    AgentCapabilities.execute_code,
  ],
};
let mockAgentsMap: TAgentsMap = {};
let mockSetValue: UseFormReturn<AgentForm>['setValue'];
let mockGetValues: UseFormReturn<AgentForm>['getValues'];
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/Providers', () => ({
  useAgentPanelContext: () => ({ agentsConfig: mockAgentsConfig }),
  useAgentsMapContext: () => mockAgentsMap,
}));
const team = {
  type: 'review',
  name: 'Review',
  description: 'Review work',
  agent_ids: ['parent'],
  edges: [],
  entry_agent_id: 'parent',
  result_agent_id: 'parent',
};
const initialSubagents: AgentSubagentsConfig = {
  enabled: false,
  graphsEnabled: true,
  allowSelf: false,
  agent_ids: ['child'],
  graphs: [team],
};
function Harness({
  subagents = initialSubagents,
  defaults = {},
}: {
  subagents?: AgentSubagentsConfig;
  defaults?: Partial<AgentForm>;
}) {
  const methods = useForm<AgentForm>({
    defaultValues: {
      ...defaults,
      subagents,
      edges: defaults.edges ?? [{ from: 'parent', to: 'handoff', edgeType: 'handoff' }],
    },
  });
  mockGetValues = methods.getValues;
  mockSetValue = methods.setValue;
  return (
    <FormProvider {...methods}>
      <Graphs currentAgentId="parent" />
    </FormProvider>
  );
}

test('disabling graph teams retains definitions and leaves ordinary subagents and handoffs alone', () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('switch', { name: 'com_ui_agent_graphs_enable' }));
  expect(mockGetValues('subagents')).toEqual({
    enabled: false,
    graphsEnabled: false,
    allowSelf: false,
    agent_ids: ['child'],
    graphs: [team],
  });
  expect(mockGetValues('edges')).toEqual([{ from: 'parent', to: 'handoff', edgeType: 'handoff' }]);
});

test('cancelled graph edits never change the saved form and invalid graphs cannot be applied', () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_agent_graphs_edit' }));
  fireEvent.change(screen.getByLabelText('com_ui_agent_graphs_name'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_agent_graphs_save' }));
  expect(screen.getByRole('alert')).toBeVisible();
  expect(mockGetValues('subagents.graphs')).toEqual([team]);
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
  expect(mockGetValues('subagents.graphs')).toEqual([team]);
});

test.each([false, true])(
  'editing one saved team preserves graph enablement=%s and every other team',
  (graphsEnabled) => {
    const otherTeam = { ...team, type: 'other_review', name: 'Other Review' };
    const subagents = {
      ...initialSubagents,
      enabled: true,
      shareFiles: true,
      graphsEnabled,
      graphs: [team, otherTeam],
    };
    render(<Harness subagents={subagents} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'com_ui_agent_graphs_edit' })[0]);
    fireEvent.change(screen.getByLabelText('com_ui_agent_graphs_name'), {
      target: { value: 'Renamed Review' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_agent_graphs_save' }));
    expect(mockGetValues('subagents')).toEqual({
      ...subagents,
      graphs: [{ ...team, name: 'Renamed Review' }, otherTeam],
    });
    expect(screen.getByRole('switch', { name: 'com_ui_agent_graphs_enable' })).toHaveAttribute(
      'aria-checked',
      String(graphsEnabled),
    );
    expect(mockGetValues('edges')).toEqual([
      { from: 'parent', to: 'handoff', edgeType: 'handoff' },
    ]);
  },
);

test('a disable choice made while editing is retained when the draft is applied', () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_agent_graphs_edit' }));
  fireEvent.change(screen.getByLabelText('com_ui_agent_graphs_description'), {
    target: { value: 'Updated review work' },
  });
  fireEvent.click(screen.getByRole('switch', { name: 'com_ui_agent_graphs_enable' }));
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_agent_graphs_save' }));
  expect(mockGetValues('subagents')).toEqual({
    ...initialSubagents,
    graphsEnabled: false,
    graphs: [{ ...team, description: 'Updated review work' }],
  });
});

test('removing one disabled team does not activate any remaining definitions', () => {
  const otherTeam = { ...team, type: 'other_review', name: 'Other Review' };
  const subagents = { ...initialSubagents, graphsEnabled: false, graphs: [team, otherTeam] };
  render(<Harness subagents={subagents} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'com_ui_agent_graphs_remove' })[0]);
  expect(mockGetValues('subagents')).toEqual({ ...subagents, graphs: [otherTeam] });
});

beforeEach(() => {
  mockAgentsMap = {};
  mockAgentsConfig = {
    maxSubagents: 2,
    capabilities: [
      AgentCapabilities.subagents,
      AgentCapabilities.subagent_graphs,
      AgentCapabilities.execute_code,
    ],
  };
});

test.each([
  { capabilities: [AgentCapabilities.subagent_graphs] },
  { capabilities: [AgentCapabilities.subagents] },
  { capabilities: [] },
])('legacy edits retain the stored capability choice: %j', ({ capabilities }) => {
  mockAgentsConfig.capabilities = capabilities;
  const subagents = { enabled: true, allowSelf: false, graphs: [team] };
  render(<Harness subagents={subagents} />);
  expect(screen.getByRole('switch')).toHaveAttribute(
    'aria-checked',
    String(capabilities.includes(AgentCapabilities.subagents)),
  );
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_agent_graphs_edit' }));
  fireEvent.change(screen.getByLabelText('com_ui_agent_graphs_name'), {
    target: { value: 'Renamed' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_agent_graphs_save' }));
  expect(mockGetValues('subagents.graphsEnabled')).toBeUndefined();
});

const chain = (type: string, start: number, count: number) => {
  const agent_ids = Array.from({ length: count }, (_, index) => `member-${start + index}`);
  return {
    type,
    name: type,
    description: 'Work',
    agent_ids,
    entry_agent_id: agent_ids[0],
    result_agent_id: agent_ids[count - 1],
    edges: agent_ids
      .slice(1)
      .map((id, index) => ({ from: agent_ids[index], to: id, edgeType: 'direct' as const })),
  };
};
test.each([49, 50])('validates unique graph members including ordinary targets at %s', (count) => {
  const first = chain('first', 0, 25);
  const second = chain('second', 25, count - 25);
  const subagents = { ...initialSubagents, agent_ids: ['ordinary'], graphs: [first, second] };
  render(<Harness subagents={subagents} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'com_ui_agent_graphs_edit' })[1]);
  fireEvent.change(screen.getByLabelText('com_ui_agent_graphs_name'), {
    target: { value: 'Changed second' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_agent_graphs_save' }));
  if (count === 50) {
    expect(screen.getByRole('alert')).toBeVisible();
    expect(mockGetValues('subagents')).toEqual(subagents);
  } else expect(mockGetValues('subagents.graphs.1.name')).toBe('Changed second');
});

test.each([undefined, false, true])(
  'attached code warning respects effective endpoint enabled=%s',
  (enabled) => {
    mockAgentsConfig = {
      ...mockAgentsConfig,
      capabilities: [
        ...(mockAgentsConfig.capabilities ?? []),
        AgentCapabilities.stateful_code_sessions,
      ],
      toolApproval: enabled == null ? undefined : { enabled },
      statefulCodeSessions: {
        allowedEnvironments: ['user', 'agent-user', 'conversation'],
        environments: [
          {
            id: 'attached',
            type: 'attached',
            name: 'Machine',
            owner: 'principal',
            baseURL: 'https://example.invalid',
            default: true,
          },
        ],
      },
    };
    render(<Harness defaults={{ execute_code: true, stateful_code_sessions: true }} />);
    expect(screen.queryByRole('note') != null).toBe(enabled !== false);
  },
);

test('removing a legacy team never promotes remaining definitions to the new capability', () => {
  mockAgentsConfig.capabilities = [AgentCapabilities.subagent_graphs];
  const other = { ...team, type: 'other' };
  const subagents = { enabled: true, graphs: [team, other] };
  render(<Harness subagents={subagents} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'com_ui_agent_graphs_remove' })[0]);
  expect(mockGetValues('subagents.graphsEnabled')).toBeUndefined();
  expect(mockGetValues('subagents.graphs')).toEqual([other]);
});

test('managed code does not show an implicit attached approval warning', () => {
  mockAgentsConfig = {
    ...mockAgentsConfig,
    capabilities: [
      ...(mockAgentsConfig.capabilities ?? []),
      AgentCapabilities.stateful_code_sessions,
    ],
    statefulCodeSessions: {
      allowedEnvironments: ['user', 'agent-user', 'conversation'],
      environments: [
        {
          id: 'managed',
          type: 'managed',
          name: 'Managed',
          owner: 'deployment',
          baseURL: 'https://example.invalid',
          default: true,
        },
        {
          id: 'attached',
          type: 'attached',
          name: 'Machine',
          owner: 'principal',
          baseURL: 'https://example.invalid',
        },
      ],
    },
  };
  render(<Harness defaults={{ execute_code: true, stateful_code_sessions: true }} />);
  expect(screen.queryByRole('note')).toBeNull();
});

const reachableAgent = (id: string, fields: Partial<Agent> = {}): Agent => ({
  id,
  name: id,
  description: null,
  created_at: 0,
  avatar: null,
  provider: EModelEndpoint.openAI,
  model: null,
  model_parameters: {
    temperature: null,
    maxContextTokens: null,
    max_context_tokens: null,
    max_output_tokens: null,
    top_p: null,
    frequency_penalty: null,
    presence_penalty: null,
  },
  ...fields,
});
const useAttachedWarnings = (enabled?: boolean) => {
  mockAgentsConfig = {
    ...mockAgentsConfig,
    capabilities: [
      ...(mockAgentsConfig.capabilities ?? []),
      AgentCapabilities.stateful_code_sessions,
    ],
    toolApproval: enabled == null ? undefined : { enabled },
    statefulCodeSessions: {
      allowedEnvironments: ['user', 'agent-user', 'conversation'],
      environments: [
        {
          id: 'attached',
          type: 'attached',
          name: 'Machine',
          owner: 'principal',
          baseURL: 'https://example.invalid',
          default: true,
        },
      ],
    },
  };
  mockAgentsMap.attached = reachableAgent('attached', {
    tools: [Tools.execute_code],
    stateful_code_sessions: true,
  });
};

test.each(['ordinary', 'handoff', 'ordinary-handoff', 'handoff-ordinary'])(
  'warns for attached descendants reached through %s',
  (path) => {
    useAttachedWarnings();
    const nested = path.includes('-');
    const target = nested ? 'intermediate' : 'attached';
    const rootHandoff = path.startsWith('handoff');
    if (nested)
      mockAgentsMap.intermediate = reachableAgent(
        'intermediate',
        path.endsWith('handoff')
          ? { edges: [{ from: 'intermediate', to: 'attached', edgeType: 'handoff' }] }
          : { subagents: { enabled: true, agent_ids: ['attached'] } },
      );
    render(
      <Harness
        subagents={{ ...initialSubagents, enabled: !rootHandoff, agent_ids: [target] }}
        defaults={{
          edges: rootHandoff ? [{ from: 'parent', to: target, edgeType: 'handoff' }] : [],
        }}
      />,
    );
    expect(screen.getByRole('note')).toHaveTextContent('com_ui_agent_graphs_approvals');
  },
);

test.each(['disabled', 'capability-off', 'endpoint-off', 'unrelated'])(
  'does not warn for an unavailable ordinary path: %s',
  (reason) => {
    useAttachedWarnings(reason === 'endpoint-off' ? false : undefined);
    if (reason === 'capability-off')
      mockAgentsConfig.capabilities = mockAgentsConfig.capabilities?.filter(
        (capability) => capability !== AgentCapabilities.subagents,
      );
    render(
      <Harness
        subagents={{
          ...initialSubagents,
          enabled: reason !== 'disabled',
          agent_ids: [reason === 'unrelated' ? 'other' : 'attached'],
        }}
        defaults={{ edges: [] }}
      />,
    );
    expect(screen.queryByRole('note')).toBeNull();
  },
);

test('draft handoff edits update the warning and cycles do not recurse forever', () => {
  useAttachedWarnings();
  mockAgentsMap.attached = {
    ...reachableAgent('attached'),
    ...mockAgentsMap.attached,
    edges: [{ from: 'attached', to: 'parent', edgeType: 'handoff' }],
  };
  render(<Harness defaults={{ edges: [] }} />);
  expect(screen.queryByRole('note')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_agent_graphs_edit' }));
  act(() => mockSetValue('edges', [{ from: 'parent', to: 'attached', edgeType: 'handoff' }]));
  expect(screen.getByRole('note')).toBeVisible();
  act(() => mockSetValue('edges', []));
  expect(screen.queryByRole('note')).toBeNull();
});

test.each([false, true])(
  'only capability-projected graph members contribute to the warning, enabled=%s',
  (graphsEnabled) => {
    useAttachedWarnings();
    const attachedTeam = {
      ...team,
      agent_ids: ['attached'],
      entry_agent_id: 'attached',
      result_agent_id: 'attached',
    };
    render(
      <Harness
        subagents={{ ...initialSubagents, graphsEnabled, graphs: [attachedTeam] }}
        defaults={{ edges: [] }}
      />,
    );
    expect(screen.queryByRole('note') != null).toBe(graphsEnabled);
  },
);

test('saved but capability-disabled graph members do not enable the warning', () => {
  useAttachedWarnings();
  mockAgentsConfig.capabilities = mockAgentsConfig.capabilities?.filter(
    (capability) => capability !== AgentCapabilities.subagent_graphs,
  );
  const attachedTeam = {
    ...team,
    agent_ids: ['attached'],
    entry_agent_id: 'attached',
    result_agent_id: 'attached',
  };
  render(
    <Harness
      subagents={{ ...initialSubagents, graphs: [attachedTeam] }}
      defaults={{ edges: [] }}
    />,
  );
  expect(screen.queryByRole('note')).toBeNull();
});

test.each(
  ['parent', 'descendant'].flatMap((source) =>
    [false, true].flatMap((executeCode) =>
      [undefined, false, true].map((endpointEnabled) => ({ source, executeCode, endpointEnabled })),
    ),
  ),
)('gates implicit approval on executable code: %j', ({ source, executeCode, endpointEnabled }) => {
  useAttachedWarnings(endpointEnabled);
  if (!executeCode) {
    mockAgentsConfig.capabilities = mockAgentsConfig.capabilities?.filter(
      (capability) => capability !== AgentCapabilities.execute_code,
    );
  }
  render(
    <Harness
      subagents={{ ...initialSubagents, enabled: source === 'descendant', agent_ids: ['attached'] }}
      defaults={{
        edges: [],
        execute_code: source === 'parent',
        stateful_code_sessions: source === 'parent',
      }}
    />,
  );
  expect(screen.queryByRole('note') != null).toBe(
    endpointEnabled === true || (endpointEnabled !== false && executeCode),
  );
});
