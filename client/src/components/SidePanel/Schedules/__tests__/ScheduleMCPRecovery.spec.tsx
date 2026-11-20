import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import ScheduleMCPRecovery from '../ScheduleMCPRecovery';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

it('opens the exact descendant that owns an immediate MCP failure', async () => {
  const onOpenAgent = jest.fn();
  render(
    <ScheduleMCPRecovery
      outcomes={[
        {
          server: 'Notion',
          agentId: 'research-agent',
          status: 'mcp_configuration_missing',
        },
      ]}
      fallbackAgentId="root-agent"
      agentNames={{ 'research-agent': 'Research Agent' }}
      onOpenAgent={onOpenAgent}
    />,
  );

  await userEvent.click(
    screen.getByRole('button', {
      name: 'Notion, Research Agent: com_ui_schedule_mcp_open_agent',
    }),
  );
  expect(onOpenAgent).toHaveBeenCalledWith('research-agent');
});

it('explains missing unattended credentials without suggesting interactive reconnection', () => {
  const onOpenAgent = jest.fn();
  render(
    <ScheduleMCPRecovery
      outcomes={[
        {
          server: 'Company Graph',
          status: 'mcp_configuration_missing',
          detail: 'unattended_auth_required',
        },
      ]}
      fallbackAgentId="root-agent"
      onOpenAgent={onOpenAgent}
    />,
  );

  expect(screen.getByRole('alert')).toHaveTextContent(
    'Company Graph (root-agent): com_ui_schedule_mcp_unattended_auth',
  );
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(onOpenAgent).not.toHaveBeenCalled();
});

it('says a run went without a server as a note, and still offers the way to fix it', async () => {
  const onOpenAgent = jest.fn();
  render(
    <ScheduleMCPRecovery
      outcomes={[{ server: 'Notion', status: 'mcp_reauth_required', skipped: true }]}
      fallbackAgentId="root-agent"
      onOpenAgent={onOpenAgent}
    />,
  );
  expect(screen.getByRole('status')).toHaveTextContent('com_ui_schedule_mcp_skipped');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole('button', { name: 'Notion, root-agent: com_ui_schedule_mcp_open_agent' }),
  );
  expect(onOpenAgent).toHaveBeenCalledWith('root-agent');
});

it('announces a failure that stopped the schedule as an alert, with no such note', () => {
  render(
    <ScheduleMCPRecovery
      outcomes={[{ server: 'Notion', status: 'mcp_reauth_required' }]}
      fallbackAgentId="root-agent"
      onOpenAgent={jest.fn()}
    />,
  );
  expect(screen.getByRole('alert')).not.toHaveTextContent('com_ui_schedule_mcp_skipped');
});
