import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TChatProject } from 'librechat-data-provider';
import type * as ReactModule from 'react';
import ProjectEditor from './ProjectEditor';

const mockMutate = jest.fn();
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
    Textarea: React.forwardRef<
      HTMLTextAreaElement,
      React.TextareaHTMLAttributes<HTMLTextAreaElement>
    >((props, ref) => React.createElement('textarea', { ...props, ref })),
    Spinner: () => React.createElement('span'),
    useToastContext: () => ({ showToast: jest.fn() }),
  };
});

jest.mock('~/data-provider', () => ({
  useUpdateProjectMutation: () => ({ mutate: mockMutate, isLoading: false }),
  useGetStartupConfig: () => ({ data: { projects: mockConfig.current } }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const project = {
  _id: 'p1',
  name: 'Alpha',
  description: 'A description saved before descriptions were turned off.',
  conversationCount: 0,
} as TChatProject;

describe('ProjectEditor', () => {
  beforeEach(() => {
    mockConfig.current = {};
    mockMutate.mockReset();
  });

  it('renames a project with a stored description while descriptions are off', async () => {
    mockConfig.current = { maxDescriptionLength: 0 };
    render(<ProjectEditor project={project} onDone={jest.fn()} />);

    expect(screen.queryByRole('textbox', { name: /com_ui_description/ })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: /com_ui_project_name/ }), {
      target: { value: 'Beta' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));

    await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(1));
    expect(mockMutate.mock.calls[0][0]).toEqual({ projectId: 'p1', name: 'Beta' });
  });

  it('saves the description with the name while descriptions are on', async () => {
    render(<ProjectEditor project={project} onDone={jest.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: /com_ui_project_name/ }), {
      target: { value: 'Beta' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));

    await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(1));
    expect(mockMutate.mock.calls[0][0]).toEqual({
      projectId: 'p1',
      name: 'Beta',
      description: project.description,
    });
  });
});
