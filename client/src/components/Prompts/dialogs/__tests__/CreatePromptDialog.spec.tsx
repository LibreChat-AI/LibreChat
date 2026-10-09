import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import CreatePromptDialog from '../CreatePromptDialog';

const mockNavigate = jest.fn();
const mockOnOpenChange = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('@librechat/client', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    OGDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? React.createElement(React.Fragment, null, children) : null,
    OGDialogContent: ({ children }: { children: ReactNode }) =>
      React.createElement('div', { role: 'dialog' }, children),
    OGDialogHeader: ({ children }: { children: ReactNode }) =>
      React.createElement('div', null, children),
    OGDialogTitle: ({ children }: { children: ReactNode }) =>
      React.createElement('h2', null, children),
  };
});

/** The form is exercised by its own specs; this isolates the dialog's contract */
jest.mock('../../forms/CreatePromptForm', () => ({
  __esModule: true,
  default: ({ onSuccess }: { onSuccess?: (groupId: string) => void }) => (
    <button type="button" data-testid="submit" onClick={() => onSuccess?.('group-123')} />
  ),
}));

describe('CreatePromptDialog', () => {
  test('renders the create form in a dialog when open', () => {
    render(<CreatePromptDialog open={true} onOpenChange={mockOnOpenChange} />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Create Prompt' })).toBeInTheDocument();
    expect(screen.getByTestId('submit')).toBeInTheDocument();
  });

  test('renders nothing while closed', () => {
    render(<CreatePromptDialog open={false} onOpenChange={mockOnOpenChange} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('closes and opens the new group once created, rather than a "new" page', () => {
    render(<CreatePromptDialog open={true} onOpenChange={mockOnOpenChange} />);

    fireEvent.click(screen.getByTestId('submit'));

    expect(mockOnOpenChange).toHaveBeenCalledWith(false);
    expect(mockNavigate).toHaveBeenCalledWith('/prompts/group-123');
  });

  test('renders the trigger passed as children alongside the dialog', () => {
    render(
      <CreatePromptDialog open={true} onOpenChange={mockOnOpenChange}>
        <button type="button" data-testid="trigger" />
      </CreatePromptDialog>,
    );

    expect(screen.getByTestId('trigger')).toBeInTheDocument();
  });
});
