import { useForm, FormProvider } from 'react-hook-form';
import { fireEvent, render, screen } from '@testing-library/react';
import type { UseFormReturn } from 'react-hook-form';
import type { AgentForm } from '~/common';
import OrchestrationHub from '../OrchestrationHub';

let mockCapabilities = ['subagents'];
let mockGetValues: UseFormReturn<AgentForm>['getValues'];
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/Providers', () => ({
  useAgentPanelContext: () => ({
    agentsConfig: {
      capabilities: mockCapabilities,
      maxSubagents: 3,
      fileSharing: { enabled: true },
    },
  }),
  useAgentsMapContext: () => ({}),
}));

function Harness({ tool }: { tool: 'subagents' | 'handoffs' }) {
  const methods = useForm<AgentForm>({
    defaultValues: {
      subagents: { enabled: true, allowSelf: false, agent_ids: [], shareFiles: true },
      edges: [{ from: 'parent', to: 'child' }],
    },
  });
  mockGetValues = methods.getValues;
  return (
    <FormProvider {...methods}>
      <OrchestrationHub tool={tool} currentAgentId="parent" />
    </FormProvider>
  );
}

beforeEach(() => {
  mockCapabilities = ['subagents'];
});

test('the subagent dialog exposes only subagent settings and preserves handoffs', () => {
  render(<Harness tool="subagents" />);
  expect(screen.getByRole('region', { name: 'com_ui_agent_subagents' })).toBeVisible();
  expect(screen.queryByRole('region', { name: 'com_ui_agent_handoffs' })).not.toBeInTheDocument();
  expect(screen.getByText('0 / 3')).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'com_ui_agent_subagents_share_files' })).toBeChecked();
  const edges = mockGetValues('edges');
  fireEvent.click(screen.getByRole('switch', { name: 'com_ui_agent_subagents_enable' }));
  expect(mockGetValues('subagents.enabled')).toBe(false);
  expect(mockGetValues('edges')).toEqual(edges);
});

test('the handoff dialog exposes only destination settings and preserves subagents', () => {
  render(<Harness tool="handoffs" />);
  expect(screen.getByRole('region', { name: 'com_ui_agent_handoffs' })).toBeVisible();
  expect(screen.queryByRole('region', { name: 'com_ui_agent_subagents' })).not.toBeInTheDocument();
  const subagents = mockGetValues('subagents');
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_agent_handoff_remove' }));
  expect(mockGetValues('edges')).toEqual([]);
  expect(mockGetValues('subagents')).toEqual(subagents);
});

test('the capability gate suppresses subagents but not handoffs', () => {
  mockCapabilities = [];
  const { unmount } = render(<Harness tool="subagents" />);
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
  unmount();
  render(<Harness tool="handoffs" />);
  expect(screen.getByRole('region', { name: 'com_ui_agent_handoffs' })).toBeVisible();
});
