import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ClearChats } from '../ClearChats';

const mockMutate = jest.fn();
const mockShowToast = jest.fn();
const mockNewConversation = jest.fn();
const mockClearStorage = jest.fn();
type Callbacks = { onError?: (error: unknown) => void; onSuccess?: () => void };

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));
jest.mock('librechat-data-provider/react-query', () => ({
  useClearConversationsMutation: () => ({ mutate: mockMutate, isLoading: false }),
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useNewConvo: () => ({ newConversation: mockNewConversation }),
}));
jest.mock('~/utils', () => ({
  clearAllConversationStorage: () => mockClearStorage(),
  getErasureErrorKey: jest.requireActual('~/utils/errors').getErasureErrorKey,
}));

function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'com_nav_clear_all_chats' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'com_ui_delete' }).at(-1)!);
  return mockMutate.mock.calls.at(-1)![1] as Callbacks;
}

it('shows pending cleanup guidance without clearing history and permits another attempt', () => {
  render(<ClearChats />);
  const callbacks = submit();
  act(() =>
    callbacks.onError?.({
      isAxiosError: true,
      response: { status: 503, data: { code: 'response_erasure_pending', message: 'private' } },
    }),
  );
  expect(mockShowToast).toHaveBeenCalledWith({
    message: 'com_ui_deletion_pending',
    status: 'error',
  });
  expect(mockClearStorage).not.toHaveBeenCalled();
  expect(mockNewConversation).not.toHaveBeenCalled();
  submit();
  expect(mockMutate).toHaveBeenCalledTimes(2);
});

it('clears local history and starts a new chat only after successful deletion', () => {
  render(<ClearChats />);
  const callbacks = submit();
  expect(mockClearStorage).not.toHaveBeenCalled();
  act(() => callbacks.onSuccess?.());
  expect(mockClearStorage).toHaveBeenCalledTimes(1);
  expect(mockNewConversation).toHaveBeenCalledTimes(1);
});
