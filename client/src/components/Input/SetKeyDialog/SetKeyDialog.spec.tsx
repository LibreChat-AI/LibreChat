import React from 'react';
import userEvent from '@testing-library/user-event';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SetKeyDialog from './SetKeyDialog';
import { useUserKey } from '~/hooks';

const save = jest.fn();
const mockToast = jest.fn();
const mockRevoke = jest.fn();
const refetch = jest.fn();
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    values?.name ? `${key} ${values.name}` : key,
  useClockFormat: () => false,
  useUserKey: jest.fn(),
}));
jest.mock('librechat-data-provider/react-query', () => ({
  useRevokeUserKeyMutation: () => ({ mutate: mockRevoke, isLoading: false }),
  useRevokeAllUserKeysMutation: () => ({ isLoading: false }),
}));
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockToast }),
}));
jest.mock('./GoogleConfig', () => () => <div>{'Service account upload'}</div>);
jest.mock('./BedrockConfig', () => () => null);
jest.mock('./OpenAIConfig', () => () => null);
jest.mock('./HelpText', () => () => null);
jest.mock('~/utils', () => ({ cn: (...classes: string[]) => classes.filter(Boolean).join(' ') }));
jest.mock('~/utils/', () => ({ cn: (...classes: string[]) => classes.filter(Boolean).join(' ') }));

const keyConfiguration = {
  keyName: 'SharedNative',
  label: 'Google images',
  encoding: 'google' as const,
  userProvideURL: false,
};
beforeEach(() => {
  save.mockReset();
  mockToast.mockReset();
  mockRevoke.mockReset();
  jest.mocked(useUserKey).mockReturnValue({
    keyName: 'SharedNative',
    getExpiry: () => undefined,
    checkExpiry: () => false,
    saveUserKey: save,
    isSaving: false,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch,
  } as ReturnType<typeof useUserKey>);
});
test('awaits Enter submission and keeps key input after a rejected save', async () => {
  let reject!: (error: Error) => void;
  save.mockReturnValueOnce(
    new Promise((_resolve, failure) => {
      reject = failure;
    }),
  );
  const close = jest.fn();
  const before = window.location.href;
  render(
    <SetKeyDialog
      open
      endpoint="SharedNative"
      keyConfiguration={{ ...keyConfiguration, keyName: 'google' }}
      onOpenChange={close}
    />,
  );
  expect(screen.queryByText('Service account upload')).not.toBeInTheDocument();
  const input = screen.getByTestId('input-apiKey');
  await userEvent.type(input, 'test-api-value');
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0]).toBe(JSON.stringify({ GOOGLE_API_KEY: 'test-api-value' }));
  expect(save.mock.calls[0]).toHaveLength(2);
  expect(close).not.toHaveBeenCalled();
  expect(mockToast).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'com_ui_submit' })).toBeDisabled();
  await act(async () => {
    reject(new Error('Rejected'));
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_save_key_error');
  expect(input).toHaveValue('test-api-value');
  expect(window.location.href).toBe(before);
  save.mockResolvedValueOnce({});
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_submit' }));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
});
test('validates required API URLs and saves their exact envelope', async () => {
  save.mockResolvedValue({});
  render(
    <SetKeyDialog
      open
      endpoint="SharedNative"
      keyConfiguration={{ ...keyConfiguration, encoding: 'apiKey', userProvideURL: true }}
      onOpenChange={() => {}}
    />,
  );
  fireEvent.change(screen.getByTestId('input-apiKey'), { target: { value: 'test-key' } });
  fireEvent.change(screen.getByTestId('input-baseURL'), {
    target: { value: 'https://example.com/chat/completions' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_submit' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('com_endpoint_config_url_invalid');
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByTestId('input-baseURL'), {
    target: { value: 'https://example.com/v1' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_submit' }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      JSON.stringify({ apiKey: 'test-key', baseURL: 'https://example.com/v1' }),
      expect.any(Number),
    ),
  );
});
test('shows status failures, supports retry, and disables revoke for a missing key', async () => {
  jest.mocked(useUserKey).mockReturnValue({
    ...jest.mocked(useUserKey)('SharedNative'),
    keyName: 'SharedNative',
    getExpiry: () => undefined,
    saveUserKey: save,
    isError: true,
    refetch,
  } as ReturnType<typeof useUserKey>);
  render(
    <SetKeyDialog
      open
      endpoint="SharedNative"
      keyConfiguration={keyConfiguration}
      onOpenChange={() => {}}
    />,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('com_endpoint_config_status_error');
  expect(screen.getByRole('button', { name: 'com_ui_revoke' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
  expect(refetch).toHaveBeenCalled();
});

test('keeps revoke confirmation open after failure and closes only on successful removal', async () => {
  jest.mocked(useUserKey).mockReturnValue({
    ...jest.mocked(useUserKey)('SharedNative'),
    getExpiry: () => 'never',
  } as ReturnType<typeof useUserKey>);
  const close = jest.fn();
  render(
    <SetKeyDialog
      open
      endpoint="SharedNative"
      keyConfiguration={keyConfiguration}
      onOpenChange={close}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_revoke' }));
  const buttons = screen.getAllByRole('button', { name: 'com_ui_revoke' });
  await userEvent.click(buttons[buttons.length - 1]);
  expect(mockRevoke).toHaveBeenCalledTimes(1);
  act(() => {
    mockRevoke.mock.calls[0][1].onError();
  });
  expect(close).not.toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'com_ui_revoke_key_error' }),
  );
  await userEvent.click(buttons[buttons.length - 1]);
  act(() => {
    mockRevoke.mock.calls[1][1].onSuccess();
  });
  expect(close).toHaveBeenCalledWith(false);
});
