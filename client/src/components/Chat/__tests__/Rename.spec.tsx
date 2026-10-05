import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import Rename from '../Rename';

const mockMutateAsync = jest.fn();
const mockShowToast = jest.fn();

jest.mock('@librechat/client', () => ({
  Label: (props: React.LabelHTMLAttributes<HTMLLabelElement>) => <label {...props} />,
  Input: jest
    .requireActual('react')
    .forwardRef(
      (
        props: React.InputHTMLAttributes<HTMLInputElement>,
        ref: React.ForwardedRef<HTMLInputElement>,
      ) => <input ref={ref} {...props} />,
    ),
  Button: ({
    variant: _variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => <button {...props} />,
  Spinner: () => <span role="status" />,
  OGDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  OGDialogClose: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  OGDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  OGDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  OGDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useToastContext: () => ({ showToast: mockShowToast }),
}));
jest.mock('~/data-provider', () => ({
  useUpdateConversationMutation: () => ({ mutateAsync: mockMutateAsync, isLoading: false }),
}));
jest.mock('~/common', () => ({ NotificationSeverity: { ERROR: 'error' } }));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/utils', () => ({ logger: { error: jest.fn() } }));

const setup = (titleSetByUser = true, title = 'Old title') => {
  const onOpenChange = jest.fn();
  const trigger = document.createElement('button');
  document.body.appendChild(trigger);
  const { unmount } = render(
    <Rename
      conversationId="convo-1"
      title={title}
      titleSetByUser={titleSetByUser}
      open={true}
      onOpenChange={onOpenChange}
      triggerRef={{ current: trigger }}
    />,
  );
  return {
    onOpenChange,
    trigger,
    unmount,
    input: screen.getByLabelText('com_ui_new_conversation_title'),
  };
};

describe('Rename', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMutateAsync.mockResolvedValue({});
  });

  it('starts with the current title selected', () => {
    const { input } = setup();

    expect(input).toHaveValue('Old title');
    expect(input).toHaveFocus();
  });

  it('saves the trimmed title and closes', async () => {
    const { input, onOpenChange } = setup();

    fireEvent.change(input, { target: { value: '  New title  ' } });
    fireEvent.click(screen.getByText('com_ui_save'));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mockMutateAsync).toHaveBeenCalledWith({
      conversationId: 'convo-1',
      title: 'New title',
    });
  });

  it('saves an unchanged title to claim ownership while it is still automatic', async () => {
    const { onOpenChange } = setup(false);

    fireEvent.click(screen.getByText('com_ui_save'));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mockMutateAsync).toHaveBeenCalledWith({
      conversationId: 'convo-1',
      title: 'Old title',
    });
  });

  it('closes without a request when the title did not change', () => {
    const { onOpenChange } = setup();

    fireEvent.click(screen.getByText('com_ui_save'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });
  it('returns focus to the menu item after a successful save', async () => {
    const { input, trigger } = setup();

    fireEvent.change(input, { target: { value: 'New title' } });
    fireEvent.click(screen.getByText('com_ui_save'));

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('returns focus to the menu item when an unchanged title closes the dialog', async () => {
    const { trigger } = setup();

    fireEvent.click(screen.getByText('com_ui_save'));

    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it('does not steal focus when a rename settles after the dialog was unmounted', async () => {
    let settle: (value: unknown) => void = () => {};
    mockMutateAsync.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    const { input, trigger, unmount, onOpenChange } = setup();

    fireEvent.change(input, { target: { value: 'New title' } });
    fireEvent.click(screen.getByText('com_ui_save'));
    unmount();
    await act(async () => {
      settle({});
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(trigger).not.toHaveFocus();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('stays open and reports a failed rename', async () => {
    mockMutateAsync.mockRejectedValue(new Error('nope'));
    const { input, onOpenChange } = setup();

    fireEvent.change(input, { target: { value: 'Other' } });
    fireEvent.click(screen.getByText('com_ui_save'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'com_ui_rename_failed' }),
      ),
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
