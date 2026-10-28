import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom';
import ResetApprovals from '../ResetApprovals';

const mockReset = jest.fn();
const mockToast = jest.fn();
let mockEnabled = true;
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: {
    ...jest.requireActual('librechat-data-provider').dataService,
    resetToolApprovalGrants: (params: { agentId: string; toolName?: string }) => mockReset(params),
  },
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useGetAgentsConfig: () => ({ agentsConfig: { toolApproval: { agentModes: mockEnabled } } }),
}));
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockToast }),
}));
const renderReset = (disabled = false) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { mutations: { retry: false } },
          logger: { log: () => {}, warn: () => {}, error: () => {} },
        })
      }
    >
      <ResetApprovals agentId="shared-agent" disabled={disabled} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  mockReset.mockReset().mockResolvedValue({ reset: true });
  mockToast.mockReset();
  mockEnabled = true;
});

test('a viewer needs only the shared agent ID to reset personal consent', async () => {
  renderReset();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'com_ui_tool_approval_reset' }));
  await user.click(screen.getByRole('menuitem', { name: 'com_ui_tool_approval_reset' }));
  await waitFor(() => expect(mockReset).toHaveBeenCalledWith({ agentId: 'shared-agent' }));
  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith({
      message: 'com_ui_tool_approval_reset_success',
      status: 'success',
    }),
  );
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
});

test('personal reset remains actionable after failure and supports retry', async () => {
  mockReset.mockRejectedValueOnce(new Error('temporary failure'));
  renderReset();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'com_ui_tool_approval_reset' }));
  await user.click(screen.getByRole('menuitem', { name: 'com_ui_tool_approval_reset' }));
  await user.click(
    await screen.findByRole('menuitem', { name: 'com_ui_tool_approval_reset_error' }),
  );
  await waitFor(() => expect(mockReset).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
});

test('disabled access cannot mutate consent and Escape dismisses the menu', async () => {
  const view = renderReset(true);
  expect(screen.getByRole('button', { name: 'com_ui_tool_approval_reset' })).toBeDisabled();
  view.unmount();
  renderReset();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'com_ui_tool_approval_reset' }));
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  expect(mockReset).not.toHaveBeenCalled();
});

test('the existing opt-in flag hides the personal action when modes are unavailable', () => {
  mockEnabled = false;
  renderReset();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
