import { fireEvent, render, screen } from '@testing-library/react';
import DeletePrompt from '../DeletePrompt';

const mockShowToast = jest.fn();
const mockMutate = jest.fn();
let capturedOnError: ((error: unknown) => void) | undefined;

jest.mock('~/data-provider', () => ({
  useDeletePrompt: (options?: { onError?: (error: unknown) => void }) => {
    capturedOnError = options?.onError;
    return { mutate: mockMutate, isLoading: false };
  },
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => {
  const React = jest.requireActual('react');
  return {
    Button: ({ children, ...rest }: any) => React.createElement('button', rest, children),
    TooltipAnchor: ({ render }: { render: React.ReactNode }) => render,
    OGDialog: ({ children }: any) => React.createElement(React.Fragment, null, children),
    OGDialogTrigger: ({ children }: any) => children,
    OGDialogTemplate: ({ selection }: any) =>
      React.createElement(
        'button',
        { 'data-testid': 'delete-confirm-button', onClick: selection?.selectHandler },
        selection?.selectText ?? 'Confirm',
      ),
    useToastContext: () => ({ showToast: mockShowToast }),
  };
});

describe('DeletePrompt', () => {
  beforeEach(() => {
    mockShowToast.mockClear();
    mockMutate.mockClear();
    capturedOnError = undefined;
  });

  it('deletes the revision on confirm', () => {
    render(
      <DeletePrompt
        promptId="prompt-1"
        groupId="group-1"
        promptName="My Prompt"
        disabled={false}
      />,
    );

    fireEvent.click(screen.getByTestId('delete-confirm-button'));

    expect(mockMutate).toHaveBeenCalledWith({ _id: 'prompt-1', groupId: 'group-1' });
  });

  it('shows the externally-managed message when the server rejects a read-only revision delete', () => {
    render(
      <DeletePrompt
        promptId="prompt-1"
        groupId="group-1"
        promptName="My Prompt"
        disabled={false}
      />,
    );

    expect(capturedOnError).toBeDefined();
    capturedOnError?.({
      isAxiosError: true,
      response: { status: 403, data: { code: 'read_only' } },
    });

    expect(mockShowToast).toHaveBeenCalledWith({
      status: 'error',
      message: 'com_ui_prompt_read_only_error',
    });
  });

  it('falls back to the generic delete-error message for a non-read-only failure', () => {
    render(
      <DeletePrompt
        promptId="prompt-1"
        groupId="group-1"
        promptName="My Prompt"
        disabled={false}
      />,
    );

    capturedOnError?.({ isAxiosError: true, response: { status: 500, data: {} } });

    expect(mockShowToast).toHaveBeenCalledWith({
      status: 'error',
      message: 'com_ui_prompt_delete_error',
    });
  });
});
