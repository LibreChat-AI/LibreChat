import { useForm, FormProvider } from 'react-hook-form';
import { render, screen, fireEvent } from '@testing-library/react';
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
function Harness() {
  const methods = useForm<AgentForm>({
    defaultValues: {
      subagents: {
        enabled: false,
        graphsEnabled: true,
        allowSelf: false,
        agent_ids: ['child'],
        graphs: [team],
      },
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
