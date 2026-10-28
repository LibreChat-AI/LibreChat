import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from 'test/layout-test-utils';
import ApprovalOption from '../ApprovalOption';

const mockReset = jest.fn(async (_params: { agentId: string; toolName: string }) => ({
  reset: true as const,
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      resetToolApprovalGrants: (params: { agentId: string; toolName: string }) => mockReset(params),
    },
  };
});

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

test('opens the four modes and inheritance without changing tool selection', async () => {
  const onChange = jest.fn();
  render(<ApprovalOption mode="chat" onChange={onChange} />);
  fireEvent.click(screen.getByRole('button'));
  const item = await screen.findByRole('menuitemcheckbox', { name: 'com_ui_tool_approval_always' });
  fireEvent.click(item);
  expect(onChange).toHaveBeenCalledWith('always');
});

test('bulk menu reports mixed state and clears to inheritance', async () => {
  const onChange = jest.fn();
  render(<ApprovalOption bulk={true} mode="mixed" onChange={onChange} />);
  fireEvent.click(screen.getByRole('button'));
  fireEvent.click(
    await screen.findByRole('menuitemcheckbox', { name: 'com_ui_tool_approval_inherit' }),
  );
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(undefined));
});

test('administrator-required approval disables automatic modes', async () => {
  render(<ApprovalOption constraint="ask" onChange={jest.fn()} />);
  fireEvent.click(screen.getByRole('button'));
  const allow = await screen.findByRole('menuitemcheckbox', { name: 'com_ui_tool_approval_allow' });
  expect(allow).toHaveAttribute('aria-disabled', 'true');
});

test('reset failures stay actionable and retry only the current user’s tool', async () => {
  mockReset.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({ reset: true });
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  render(
    <ApprovalOption mode="chat" agentId="agent-a" toolName="query_mcp_db" onChange={jest.fn()} />,
  );
  fireEvent.click(screen.getByRole('button'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'com_ui_tool_approval_reset' }));
  fireEvent.click(
    await screen.findByRole('menuitem', { name: 'com_ui_tool_approval_reset_error' }),
  );
  await waitFor(() => expect(mockReset).toHaveBeenCalledTimes(2));
  expect(mockReset).toHaveBeenLastCalledWith({ agentId: 'agent-a', toolName: 'query_mcp_db' });
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  mockReset.mockClear();
  consoleError.mockRestore();
});
