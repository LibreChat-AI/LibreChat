/**
 * @jest-environment jsdom
 */
import { Controller, useForm } from 'react-hook-form';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { UseFormReturn } from 'react-hook-form';
import type { ReactNode } from 'react';
import type { AgentForm } from '~/common';
import AgentSubagents from '../AgentSubagents';

let mockSelectAgent: ((agentId: string) => void) | undefined;
let mockGetValues: UseFormReturn<AgentForm>['getValues'] | undefined;
const mockSubmit = jest.fn();

jest.mock('@librechat/client', () => ({
  Switch: () => null,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('../AgentList', () => ({
  AddAgentSelect: ({ onSelect }: { onSelect: (agentId: string) => void }) => {
    mockSelectAgent = onSelect;
    return null;
  },
  ListMeta: () => null,
  StaticAgentRow: () => null,
  useSelectableAgents: () => ({ options: [], getAgent: () => undefined }),
}));

jest.mock('../OrchestrationPattern', () => ({
  __esModule: true,
  default: ({ children, trailing }: { children: ReactNode; trailing: ReactNode }) => (
    <>
      {trailing}
      {children}
    </>
  ),
}));

jest.mock('../ui', () => ({
  ToggleSetting: ({
    label,
    checked,
    onCheckedChange,
  }: {
    label: string;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));

describe('AgentSubagents', () => {
  beforeEach(() => {
    mockSelectAgent = undefined;
    mockGetValues = undefined;
    mockSubmit.mockReset();
  });

  function Harness({
    fileSharingEnabled = false,
    initialSubagents,
  }: {
    fileSharingEnabled?: boolean;
    initialSubagents?: AgentForm['subagents'];
  }) {
    const methods = useForm<AgentForm>({
      defaultValues: {
        subagents: initialSubagents ?? {
          enabled: true,
          allowSelf: false,
          agent_ids: [],
        },
      },
    });
    mockGetValues = methods.getValues;

    return (
      <form aria-label="agent form" onSubmit={methods.handleSubmit(mockSubmit)}>
        <Controller
          name="subagents"
          control={methods.control}
          render={({ field }) => (
            <AgentSubagents
              field={field}
              currentAgentId="parent"
              maxSubagents={10}
              fileSharingEnabled={fileSharingEnabled}
            />
          )}
        />
      </form>
    );
  }

  it('commits a selected agent before an immediate form submit', async () => {
    render(<Harness />);

    act(() => {
      mockSelectAgent?.('child');
      fireEvent.submit(screen.getByRole('form', { name: 'agent form' }));
    });

    expect(mockGetValues?.('subagents')).toEqual({
      enabled: true,
      allowSelf: false,
      agent_ids: ['child'],
    });
    await waitFor(() =>
      expect(mockSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          subagents: {
            enabled: true,
            allowSelf: false,
            agent_ids: ['child'],
          },
        }),
        expect.anything(),
      ),
    );
  });

  it('uses the semantic warning role for an empty configuration', () => {
    render(<Harness />);

    expect(screen.getByText('com_ui_agent_subagents_empty')).toHaveClass('text-text-warning');
  });

  it('keeps file sharing unavailable until the deployment enables it', () => {
    const initialSubagents = { enabled: true, shareFiles: true, agent_ids: ['child'] };
    render(<Harness initialSubagents={initialSubagents} />);

    expect(
      screen.queryByRole('switch', { name: 'com_ui_agent_subagents_share_files' }),
    ).not.toBeInTheDocument();
    expect(mockGetValues?.('subagents')).toEqual(initialSubagents);
  });

  it('saves the opt-in immediately while preserving the configured roster', async () => {
    render(
      <Harness
        fileSharingEnabled
        initialSubagents={{ enabled: true, allowSelf: false, agent_ids: ['child'] }}
      />,
    );
    const sharing = screen.getByRole('switch', { name: 'com_ui_agent_subagents_share_files' });
    expect(sharing).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(sharing);
    fireEvent.submit(screen.getByRole('form', { name: 'agent form' }));

    await waitFor(() =>
      expect(mockSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          subagents: {
            enabled: true,
            allowSelf: false,
            shareFiles: true,
            agent_ids: ['child'],
          },
        }),
        expect.anything(),
      ),
    );

    fireEvent.click(sharing);
    expect(mockGetValues?.('subagents.shareFiles')).toBe(false);
  });
});
