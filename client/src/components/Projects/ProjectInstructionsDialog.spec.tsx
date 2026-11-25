import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TChatProject } from 'librechat-data-provider';
import type * as ReactModule from 'react';
import type { ReactNode } from 'react';
import ProjectInstructionsDialog from './ProjectInstructionsDialog';

const mockMutate = jest.fn();
const mockInvalidateQueries = jest.fn();
const mockShowToast = jest.fn();

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

jest.mock('@librechat/client', () => {
  const React = jest.requireActual<typeof ReactModule>('react');
  return {
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
      React.createElement('button', props, children),
    Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) =>
      React.createElement('label', props, children),
    Textarea: React.forwardRef<
      HTMLTextAreaElement,
      React.TextareaHTMLAttributes<HTMLTextAreaElement>
    >((props, ref) => React.createElement('textarea', { ...props, ref })),
    Spinner: () => React.createElement('span', { 'data-testid': 'spinner' }),
    TooltipAnchor: ({ render }: { render: ReactNode }) => render,
    OGDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? React.createElement(React.Fragment, null, children) : null,
    OGDialogTemplate: ({
      title,
      main,
      buttons,
      showCancelButton = true,
      cancelDisabled = false,
    }: {
      title: ReactNode;
      main: ReactNode;
      buttons: ReactNode;
      showCancelButton?: boolean;
      cancelDisabled?: boolean;
    }) =>
      React.createElement('section', { role: 'dialog' }, [
        React.createElement('h2', { key: 'title' }, title),
        React.createElement('div', { key: 'main' }, main),
        showCancelButton
          ? React.createElement(
              'button',
              { key: 'cancel', type: 'button', disabled: cancelDisabled },
              'Cancel',
            )
          : null,
        React.createElement('div', { key: 'buttons' }, buttons),
      ]),
    useToastContext: () => ({ showToast: mockShowToast }),
  };
});

jest.mock('~/data-provider', () => {
  const React = jest.requireActual<typeof ReactModule>('react');
  return {
    useUpdateProjectMutation: () => {
      const [isLoading, setIsLoading] = React.useState(false);
      const mutate = (
        payload: unknown,
        callbacks: {
          onSuccess?: (...args: unknown[]) => void;
          onError?: (...args: unknown[]) => void;
        },
      ) => {
        setIsLoading(true);
        mockMutate(payload, {
          onSuccess: (...args: unknown[]) => {
            setIsLoading(false);
            callbacks.onSuccess?.(...args);
          },
          onError: (...args: unknown[]) => {
            setIsLoading(false);
            callbacks.onError?.(...args);
          },
        });
      };
      return { mutate, isLoading };
    },
    useGetStartupConfig: () => ({ data: undefined }),
  };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: { name?: string | number }) => {
    const translations: Record<string, string> = {
      com_ui_project_instructions: 'Instructions',
      com_ui_project_instructions_label: 'Workspace instructions',
      com_ui_project_instructions_help: 'Additional context',
      com_ui_project_instructions_error: 'Could not save project instructions',
      com_ui_project_conflict_error: 'Project changed elsewhere',
      com_ui_save: 'Save',
      com_ui_saving: 'Saving',
      com_ui_cancel: 'Cancel',
    };
    return (translations[key] ?? key).replace('{{name}}', String(options?.name ?? ''));
  },
}));

const project = {
  _id: 'project-1',
  name: 'Writing project',
  instructions: 'Use a concise tone.',
  contextRevision: 3,
  conversationCount: 0,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
} as TChatProject;

describe('ProjectInstructionsDialog', () => {
  beforeEach(() => jest.clearAllMocks());

  it('keeps the edited draft after a failed save and closes only after success', async () => {
    function Editor() {
      const [open, setOpen] = useState(true);
      return <ProjectInstructionsDialog open={open} onOpenChange={setOpen} project={project} />;
    }
    mockMutate.mockImplementationOnce((_payload, callbacks) =>
      callbacks.onError(new Error('Save unavailable')),
    );
    render(<Editor />);
    const textarea = screen.getByRole('textbox', { name: 'Workspace instructions' });
    fireEvent.change(textarea, { target: { value: 'Keep this unsaved draft.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(textarea).toHaveValue('Keep this unsaved draft.');

    mockMutate.mockImplementationOnce((_payload, callbacks) => callbacks.onSuccess(project));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('sends the project revision and keeps the draft when the save conflicts', async () => {
    const onOpenChange = jest.fn();
    mockMutate.mockImplementationOnce((_payload, callbacks) =>
      callbacks.onError({ response: { status: 409, data: { code: 'CHAT_PROJECT_CONFLICT' } } }),
    );
    render(<ProjectInstructionsDialog open onOpenChange={onOpenChange} project={project} />);
    const textarea = screen.getByRole('textbox', { name: 'Workspace instructions' });
    fireEvent.change(textarea, { target: { value: 'Keep this unsaved draft.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledTimes(1));
    expect(mockMutate.mock.calls[0][0]).toMatchObject({ contextRevision: 3 });
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Project changed elsewhere' }),
    );
    expect(mockInvalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['project', 'project-1'] }),
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('Keep this unsaved draft.');
  });

  it('protects the draft and dismissal controls while a save is pending', async () => {
    let pendingCallbacks: { onSuccess: () => void; onError: (error: unknown) => void } | undefined;
    mockMutate.mockImplementationOnce((_payload, callbacks) => {
      pendingCallbacks = callbacks;
    });

    render(<ProjectInstructionsDialog open onOpenChange={jest.fn()} project={project} />);
    const textarea = screen.getByRole('textbox', { name: 'Workspace instructions' });
    fireEvent.change(textarea, { target: { value: 'Draft A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(1));
    expect(textarea).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => pendingCallbacks?.onError(new Error('Save unavailable')));
    await waitFor(() => expect(textarea).not.toHaveAttribute('readonly'));
    expect(screen.getByRole('button', { name: 'Cancel' })).not.toBeDisabled();
    expect(textarea).toHaveValue('Draft A');
  });

  it('does not close a newer editing session when an old save completes', async () => {
    let pendingCallbacks: { onSuccess: () => void; onError: (error: unknown) => void } | undefined;
    mockMutate.mockImplementationOnce((_payload, callbacks) => {
      pendingCallbacks = callbacks;
    });

    const onOpenChange = jest.fn();
    const dialog = (open: boolean) => (
      <ProjectInstructionsDialog open={open} onOpenChange={onOpenChange} project={project} />
    );
    const { rerender } = render(dialog(true));
    fireEvent.change(screen.getByRole('textbox', { name: 'Workspace instructions' }), {
      target: { value: 'Draft A' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(1));

    rerender(dialog(false));
    rerender(dialog(true));
    await act(async () => pendingCallbacks?.onSuccess());

    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
