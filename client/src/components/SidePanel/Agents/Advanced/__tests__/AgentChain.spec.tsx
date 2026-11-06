import { Controller, useForm } from 'react-hook-form';
import { fireEvent, render, screen } from '@testing-library/react';
import type { UseFormReturn } from 'react-hook-form';
import type { ReactNode } from 'react';
import type { AgentForm } from '~/common';
import AgentChain from '../AgentChain';

let mockGetValues: UseFormReturn<AgentForm>['getValues'];
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('../AgentList', () => ({
  useSelectableAgents: () => ({ getAgent: (id: string) => ({ name: id }) }),
}));
jest.mock('../OrchestrationPattern', () => ({
  __esModule: true,
  default: ({ children, subtitle }: { children: ReactNode; subtitle: string }) => (
    <section>
      {subtitle}
      {children}
    </section>
  ),
}));

function Harness({ ids }: { ids: string[] }) {
  const methods = useForm<AgentForm>({
    defaultValues: { agent_ids: ids, subagents: { enabled: true, agent_ids: ['reviewer'] } },
  });
  mockGetValues = methods.getValues;
  return (
    <Controller
      name="agent_ids"
      control={methods.control}
      render={({ field }) => <AgentChain field={field} currentAgentId="parent" />}
    />
  );
}

test('offers no chain authoring for a new or unchained agent', () => {
  const { container } = render(<Harness ids={[]} />);
  expect(container).toBeEmptyDOMElement();
});

test('preserves legacy order and exposes only explicit removal', () => {
  render(<Harness ids={['first', 'second']} />);
  expect(screen.getByText('com_ui_agent_chain_deprecated')).toBeInTheDocument();
  expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
    '1. first',
    '2. second',
  ]);
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(mockGetValues('agent_ids')).toEqual(['first', 'second']);
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_agent_chain_remove' }));
  expect(mockGetValues('agent_ids')).toEqual([]);
  expect(mockGetValues('subagents')).toEqual({ enabled: true, agent_ids: ['reviewer'] });
});
