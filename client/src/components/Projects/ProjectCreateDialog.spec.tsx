import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type * as ReactModule from 'react';
import type { ReactNode } from 'react';
import ProjectCreateDialog from './ProjectCreateDialog';

const mockMutateAsync = jest.fn();
const mockShowToast = jest.fn();
const mockConfig = { current: {} as Record<string, number> };

jest.mock('@librechat/client', () => {
  const React = jest.requireActual<typeof ReactModule>('react');
  return {
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
      React.createElement('button', props, children),
    Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) =>
      React.createElement('label', props, children),
    Input: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
      (props, ref) => React.createElement('input', { ...props, ref }),
    ),
    Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) =>
      React.createElement('textarea', props),
    Spinner: () => React.createElement('span'),
    OGDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? React.createElement(React.Fragment, null, children) : null,
    OGDialogTemplate: ({ main, buttons }: { main: ReactNode; buttons: ReactNode }) =>
      React.createElement('section', { role: 'dialog' }, main, buttons),
    useToastContext: () => ({ showToast: mockShowToast }),
  };
});

jest.mock('~/data-provider', () => ({
  useCreateProjectMutation: () => ({ mutateAsync: mockMutateAsync, isLoading: false }),
  useGetStartupConfig: () => ({ data: { projects: mockConfig.current } }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const renderDialog = () =>
  render(<ProjectCreateDialog open={true} onOpenChange={jest.fn()} onCreated={jest.fn()} />);

const submit = (name: string) => {
  fireEvent.change(screen.getByLabelText('com_ui_project_name'), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_create_project' }));
};

describe('ProjectCreateDialog', () => {
  beforeEach(() => {
    mockConfig.current = {};
    mockMutateAsync.mockReset();
    mockShowToast.mockReset();
  });

  it('offers a description by default', () => {
    renderDialog();
    expect(screen.getByRole('textbox', { name: /com_ui_description/ })).toBeVisible();
  });

  it('hides the description and sends none when descriptions are turned off', async () => {
    mockConfig.current = { maxDescriptionLength: 0 };
    mockMutateAsync.mockResolvedValue({ _id: 'p1', name: 'Alpha' });
    renderDialog();

    expect(screen.queryByRole('textbox', { name: /com_ui_description/ })).toBeNull();
    submit('Alpha');

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledWith({ name: 'Alpha' }));
  });

  it('says the user is at the project cap instead of a generic failure', async () => {
    mockMutateAsync.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: 'Project limit reached', code: 'CHAT_PROJECT_LIMIT' },
      },
    });
    renderDialog();
    submit('One too many');

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'com_ui_project_limit_reached', status: 'error' }),
      ),
    );
  });

  it('keeps the generic failure for other errors', async () => {
    mockMutateAsync.mockRejectedValue(new Error('network'));
    renderDialog();
    submit('Beta');

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'com_ui_project_create_error' }),
      ),
    );
  });
});
