import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import InlinePromptsView from '../InlinePromptsView';

const mockUseHasAccess = jest.fn();
let mockRoles: Record<string, unknown> | undefined;
const mockRefetch = jest.fn();
let mockRoleQuery: { isError: boolean; isFetching: boolean; refetch: jest.Mock };

jest.mock('@librechat/client', () => ({
  Spinner: () => <div data-testid="spinner" />,
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: (...args: unknown[]) => mockUseHasAccess(...args),
  useAuthContext: () => ({ user: { id: 'user-1', role: 'USER' }, roles: mockRoles }),
}));

jest.mock('~/data-provider', () => ({
  useGetRole: () => mockRoleQuery,
}));

jest.mock('../../forms/PromptForm', () => ({ promptId }: { promptId?: string }) => (
  <div data-testid="prompt-form">{promptId}</div>
));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/prompts/:promptId" element={<InlinePromptsView />} />
        <Route path="/c/new" element={<div data-testid="new-chat" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('InlinePromptsView', () => {
  beforeEach(() => {
    mockUseHasAccess.mockReset();
    mockRoles = undefined;
    mockRefetch.mockReset();
    mockRoleQuery = { isError: false, isFetching: false, refetch: mockRefetch };
  });

  it('offers Retry when the role request fails', () => {
    mockUseHasAccess.mockReturnValue(false);
    mockRoleQuery = { isError: true, isFetching: false, refetch: mockRefetch };

    renderAt('/prompts/group-1');

    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_prompt_permissions_load_error');
    expect(screen.queryByTestId('new-chat')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('waits for roles on a fresh load instead of redirecting to chat', () => {
    mockUseHasAccess.mockReturnValue(false);

    renderAt('/prompts/group-1');

    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    expect(screen.queryByTestId('new-chat')).not.toBeInTheDocument();
  });

  it('shows the prompt once roles load with access', () => {
    mockRoles = { USER: {} };
    mockUseHasAccess.mockReturnValue(true);

    renderAt('/prompts/group-1');

    expect(screen.getByTestId('prompt-form')).toHaveTextContent('group-1');
  });

  it('redirects to chat once roles load without access', () => {
    mockRoles = { USER: {} };
    mockUseHasAccess.mockReturnValue(false);

    renderAt('/prompts/group-1');

    expect(screen.getByTestId('new-chat')).toBeInTheDocument();
  });
});
