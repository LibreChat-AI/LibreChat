import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FormEvent, ReactNode } from 'react';
import CreateSkillDialog from '../CreateSkillDialog';

const mockMutate = jest.fn();
const mockNavigate = jest.fn();
const mockSetIsOpen = jest.fn();
const mockShowToast = jest.fn();
let mockOnError: ((error: unknown) => void) | undefined;

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('@librechat/client', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const ReactDOM = jest.requireActual<typeof import('react-dom')>('react-dom');
  return {
    Button: ({
      children,
      variant: _variant,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) =>
      React.createElement('button', props, children),
    Input: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
      (props, ref) => React.createElement('input', { ...props, ref }),
    ),
    Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) =>
      React.createElement('label', props, children),
    OGDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? React.createElement(React.Fragment, null, children) : null,
    OGDialogContent: ({ children }: { children: ReactNode }) =>
      ReactDOM.createPortal(React.createElement('div', null, children), globalThis.document.body),
    TextareaAutosize: React.forwardRef<
      HTMLTextAreaElement,
      React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
        minRows?: number;
        maxRows?: number;
      }
    >(({ minRows: _minRows, maxRows: _maxRows, ...props }, ref) =>
      React.createElement('textarea', { ...props, ref }),
    ),
    useToastContext: () => ({
      showToast: mockShowToast,
    }),
  };
});

jest.mock('~/data-provider', () => ({
  useCreateSkillMutation: (options: { onError: (error: unknown) => void }) => {
    mockOnError = options.onError;
    return {
      mutate: mockMutate,
      isLoading: false,
    };
  },
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => {
    const translations: Record<string, string> = {
      com_ui_name: 'Name',
      com_ui_description: 'Description',
      com_ui_skill_instructions: 'Instructions',
      com_ui_cancel: 'Cancel',
      com_ui_create: 'Create',
      com_ui_skill_create_error: 'Failed to create skill',
      com_ui_skill_name_exists: 'A skill with this name already exists',
      com_ui_skill_name_reserved: 'This skill name is reserved',
    };
    return translations[key] ?? key;
  },
}));

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}));

describe('CreateSkillDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOnError = undefined;
  });

  it('localizes structured validation errors', () => {
    render(<CreateSkillDialog isOpen={true} setIsOpen={mockSetIsOpen} />);

    mockOnError?.({
      response: {
        status: 400,
        data: {
          issues: [{ field: 'name', code: 'RESERVED_WORD', message: 'settings is reserved' }],
        },
      },
    });

    expect(mockShowToast).toHaveBeenCalledWith({
      status: 'error',
      message: 'This skill name is reserved',
    });
  });

  it('preserves middleware messages and localizes duplicate names', () => {
    render(<CreateSkillDialog isOpen={true} setIsOpen={mockSetIsOpen} />);

    mockOnError?.({ response: { status: 403, data: { message: 'Permission denied' } } });
    expect(mockShowToast).toHaveBeenLastCalledWith({
      status: 'error',
      message: 'Permission denied',
    });

    mockOnError?.({ response: { status: 409, data: { error: 'server prose' } } });
    expect(mockShowToast).toHaveBeenLastCalledWith({
      status: 'error',
      message: 'A skill with this name already exists',
    });
  });

  it('does not submit an ancestor form when rendered through a portal', async () => {
    const handleAgentSubmit = jest.fn((event: FormEvent<HTMLFormElement>) =>
      event.preventDefault(),
    );

    render(
      <form onSubmit={handleAgentSubmit}>
        <CreateSkillDialog isOpen={true} setIsOpen={mockSetIsOpen} />
      </form>,
    );

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'portal-skill' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'A skill created from Agent Builder' },
    });
    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Apply the portal skill.' },
    });

    const createButton = screen.getByRole('button', { name: 'Create' });
    await waitFor(() => expect(createButton).toBeEnabled());
    fireEvent.click(createButton);

    await waitFor(() =>
      expect(mockMutate).toHaveBeenCalledWith({
        name: 'portal-skill',
        description: 'A skill created from Agent Builder',
        body: 'Apply the portal skill.',
      }),
    );
    expect(handleAgentSubmit).not.toHaveBeenCalled();
  });
});
