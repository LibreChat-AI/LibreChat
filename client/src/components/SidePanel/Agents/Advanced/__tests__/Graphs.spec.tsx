import { useForm, FormProvider } from 'react-hook-form';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AgentSubagentsConfig } from 'librechat-data-provider';
import type { UseFormReturn } from 'react-hook-form';
import type { AgentForm } from '~/common';
import Graphs from '../Graphs';

let mockGetValues: UseFormReturn<AgentForm>['getValues'];
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/Providers', () => ({
  useAgentPanelContext: () => ({ agentsConfig: { maxSubagents: 2 } }),
  useAgentsMapContext: () => ({}),
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
function Harness({ subagents = initialSubagents }: { subagents?: AgentSubagentsConfig }) {
  const methods = useForm<AgentForm>({
    defaultValues: {
      subagents,
      edges: [{ from: 'parent', to: 'handoff', edgeType: 'handoff' }],
    },
  });
  mockGetValues = methods.getValues;
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
