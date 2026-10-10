import userEvent from '@testing-library/user-event';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import LangfuseConnection from '../LangfuseConnection';

const mockGet = jest.fn();
const mockUpdate = jest.fn();
const mockTest = jest.fn();
const mockRefetch = jest.fn();
const destinationLabels = {
  eu: 'eu - https://cloud.langfuse.com',
  us: 'us - https://us.cloud.langfuse.com',
};

async function selectDestination(destination: keyof typeof destinationLabels) {
  await userEvent.click(screen.getByTestId('langfuse-destination'));
  await userEvent.click(screen.getByRole('option', { name: destinationLabels[destination] }));
}

jest.mock('~/data-provider', () => ({
  useGetLangfuseConnectionQuery: () => mockGet(),
  useUpdateLangfuseConnectionMutation: () => ({ mutate: mockUpdate, isLoading: false }),
  useTestLangfuseConnectionMutation: () => ({ mutate: mockTest, isLoading: false }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: jest.fn() }),
}));

beforeEach(() => {
  global.ResizeObserver = class MockedResizeObserver {
    observe = jest.fn();
    unobserve = jest.fn();
    disconnect = jest.fn();
  };
  mockGet.mockReset();
  mockUpdate.mockReset();
  mockTest.mockReset();
  mockRefetch.mockReset();
  mockTest.mockImplementation((_payload, options) => {
    options?.onSuccess?.({ success: true });
  });
  mockGet.mockReturnValue({
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: mockRefetch,
    data: {
      configured: false,
      enabled: false,
      destinations: [
        { key: 'eu', baseUrl: 'https://cloud.langfuse.com' },
        { key: 'us', baseUrl: 'https://us.cloud.langfuse.com' },
      ],
    },
  });
});

describe('LangfuseConnection', () => {
  it('renders the connection form fields', () => {
    render(<LangfuseConnection />);
    expect(screen.getByTestId('langfuse-destination')).toHaveTextContent('com_ui_select');
    expect(screen.getByLabelText('com_ui_langfuse_public_key')).toHaveAttribute(
      'data-lpignore',
      'true',
    );
    expect(screen.getByLabelText('com_ui_langfuse_public_key')).toHaveAttribute(
      'data-1p-ignore',
      'true',
    );
    expect(screen.getByLabelText('com_ui_langfuse_public_key')).toHaveAttribute(
      'data-form-type',
      'other',
    );
    expect(screen.getByLabelText('com_ui_langfuse_public_key')).toHaveAttribute(
      'data-bwignore',
      'true',
    );
    expect(screen.getByLabelText(/com_ui_langfuse_secret_key/)).toHaveAttribute(
      'data-lpignore',
      'true',
    );
    expect(screen.getByLabelText(/com_ui_langfuse_secret_key/)).toHaveAttribute(
      'data-1p-ignore',
      'true',
    );
    expect(screen.getByLabelText(/com_ui_langfuse_secret_key/)).toHaveAttribute(
      'data-form-type',
      'other',
    );
    expect(screen.getByLabelText(/com_ui_langfuse_secret_key/)).toHaveAttribute(
      'data-bwignore',
      'true',
    );
    expect(screen.getByLabelText(/com_ui_langfuse_secret_key/)).toHaveAttribute(
      'autocomplete',
      'off',
    );
    expect(screen.getByLabelText(/com_ui_langfuse_secret_key/)).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Show secret' })).toBeInTheDocument();
    expect(screen.queryByText('com_ui_langfuse_test')).not.toBeInTheDocument();
    expect(screen.getByText('com_ui_langfuse_status_not_configured')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_cancel' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_save' })).toHaveClass('bg-surface-submit');
    expect(screen.getByTestId('langfuse-connection-status')).toHaveTextContent(
      'com_ui_langfuse_status_not_configured',
    );
    expect(screen.queryByText('com_ui_langfuse_description')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_ui_langfuse_enable' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_ui_langfuse_disable' }),
    ).not.toBeInTheDocument();
    expect(mockTest).not.toHaveBeenCalled();
  });

  it('renders a loading state while the stored connection is loading', () => {
    mockGet.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      isFetching: true,
      refetch: mockRefetch,
    });

    render(<LangfuseConnection />);

    expect(screen.getByTestId('langfuse-connection-loading')).toBeVisible();
    expect(screen.getByText('com_ui_loading')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_langfuse_status_not_configured')).not.toBeInTheDocument();
  });

  it('opens the connection explanation when the help button is clicked', async () => {
    render(<LangfuseConnection />);

    expect(screen.queryByText('com_ui_langfuse_description')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_langfuse_beta_info' }));

    expect(await screen.findByText('com_ui_langfuse_beta_info')).toBeVisible();
  });

  it('renders a retryable error when the stored connection cannot be loaded', async () => {
    mockGet.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch: mockRefetch,
    });

    render(<LangfuseConnection />);

    expect(screen.getByText('com_ui_langfuse_load_error')).toBeVisible();
    expect(screen.queryByText('com_ui_langfuse_status_not_configured')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      credential: 'public key',
      editButton: 'com_ui_edit com_ui_langfuse_public_key',
      inputLabel: 'com_ui_langfuse_public_key',
      value: 'pk-lf-updated',
    },
    {
      credential: 'secret key',
      editButton: 'com_ui_edit com_ui_langfuse_secret_key',
      inputLabel: 'com_ui_langfuse_secret_key',
      value: 'sk-lf-updated',
    },
  ])(
    'keeps edited $credential unverified when an earlier automatic test completes',
    async ({ editButton, inputLabel, value }) => {
      let completeTest: ((result: { success: boolean }) => void) | undefined;
      mockTest.mockImplementation((_payload, options) => {
        completeTest = options?.onSuccess;
      });
      mockGet.mockReturnValue({
        data: {
          configured: true,
          enabled: true,
          destinations: [{ key: 'eu', baseUrl: 'https://cloud.langfuse.com' }],
          destination: 'eu',
          publicKey: 'pk-lf-original',
          secretKeyPreview: 'sk-lf-...inal',
        },
      });

      render(<LangfuseConnection />);
      await waitFor(() => expect(mockTest).toHaveBeenCalledTimes(1));
      await userEvent.click(screen.getByRole('button', { name: editButton }));
      fireEvent.change(screen.getByLabelText(inputLabel), { target: { value } });

      expect(screen.getByText('com_ui_langfuse_status_not_verified')).toBeVisible();
      act(() => completeTest?.({ success: true }));
      expect(screen.getByText('com_ui_langfuse_status_not_verified')).toBeVisible();
      expect(screen.queryByText('com_ui_langfuse_status_connected')).not.toBeInTheDocument();
    },
  );

  it('prefills stored values, tests on load, and keeps destination editable', async () => {
    mockGet.mockReturnValue({
      data: {
        configured: true,
        enabled: true,
        destinations: [
          { key: 'eu', baseUrl: 'https://cloud.langfuse.com' },
          { key: 'us', baseUrl: 'https://us.cloud.langfuse.com' },
        ],
        destination: 'us',
        publicKey: 'pk-lf-12345678-515f',
        secretKeyPreview: 'sk-lf-...515f',
      },
    });
    render(<LangfuseConnection />);

    expect(screen.getByTestId('langfuse-destination')).toHaveTextContent(destinationLabels.us);
    expect(screen.queryByLabelText('com_ui_langfuse_public_key')).not.toBeInTheDocument();
    expect(screen.getByText('pk-lf-...515f')).toBeInTheDocument();
    expect(screen.queryByLabelText('com_ui_langfuse_secret_key')).not.toBeInTheDocument();
    expect(screen.getByText('sk-lf-...515f')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_save')).not.toBeInTheDocument();
    expect(screen.getByTestId('langfuse-destination')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'com_ui_langfuse_disable' })).toBeEnabled();
    await waitFor(() => expect(mockTest).toHaveBeenCalledTimes(1));
    expect(mockTest.mock.calls[0][0]).toEqual({
      destination: 'us',
      publicKey: 'pk-lf-12345678-515f',
    });
    expect(screen.getByText('com_ui_langfuse_status_connected')).toBeInTheDocument();
  });

  it('shows a failed saved-connection status when the load-time test fails', async () => {
    mockTest.mockImplementation((_payload, options) => {
      options?.onSuccess?.({ success: false, errorCode: 'invalid_credentials' });
    });
    mockGet.mockReturnValue({
      data: {
        configured: true,
        enabled: true,
        destinations: [{ key: 'eu', baseUrl: 'https://cloud.langfuse.com' }],
        destination: 'eu',
        publicKey: 'pk-lf-1',
        secretKeyPreview: 'sk-lf-...515f',
      },
    });

    render(<LangfuseConnection />);

    await waitFor(() =>
      expect(screen.getByText('com_ui_langfuse_test_invalid_credentials')).toBeInTheDocument(),
    );
    expect(
      screen.getByText('com_ui_langfuse_test_invalid_credentials').closest('div'),
    ).toHaveAttribute('title', 'com_ui_langfuse_status_failed_hover');
  });

  it('saves the typed secret key without a duplicate preflight test', async () => {
    render(<LangfuseConnection />);
    await selectDestination('us');
    fireEvent.change(screen.getByLabelText('com_ui_langfuse_public_key'), {
      target: { value: 'pk-lf-1' },
    });
    fireEvent.change(screen.getByLabelText(/com_ui_langfuse_secret_key/), {
      target: { value: 'sk-lf-secret' },
    });

    await userEvent.click(screen.getByText('com_ui_save'));

    expect(mockTest).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0]).toEqual({
      enabled: true,
      destination: 'us',
      publicKey: 'pk-lf-1',
      secretKey: 'sk-lf-secret',
    });
  });

  it('shows the display secret key immediately after saving a new connection', async () => {
    mockUpdate.mockImplementation((_payload, options) => {
      options?.onSuccess?.({
        configured: true,
        enabled: true,
        destinations: [
          { key: 'eu', baseUrl: 'https://cloud.langfuse.com' },
          { key: 'us', baseUrl: 'https://us.cloud.langfuse.com' },
        ],
        destination: 'us',
        publicKey: 'pk-lf-1',
        secretKeyPreview: 'sk-lf-...cret',
      });
    });

    render(<LangfuseConnection />);
    await selectDestination('us');
    fireEvent.change(screen.getByLabelText('com_ui_langfuse_public_key'), {
      target: { value: 'pk-lf-1' },
    });
    fireEvent.change(screen.getByLabelText(/com_ui_langfuse_secret_key/), {
      target: { value: 'sk-lf-secret' },
    });

    await userEvent.click(screen.getByText('com_ui_save'));

    expect(mockTest).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('com_ui_langfuse_secret_key')).not.toBeInTheDocument();
    expect(screen.getByText('sk-lf-...cret')).toBeInTheDocument();
  });

  it('requires secret re-entry before saving a destination change', async () => {
    mockGet.mockReturnValue({
      data: {
        configured: true,
        enabled: true,
        destinations: [
          { key: 'eu', baseUrl: 'https://cloud.langfuse.com' },
          { key: 'us', baseUrl: 'https://us.cloud.langfuse.com' },
        ],
        destination: 'eu',
        publicKey: 'pk-lf-1',
        secretKeyPreview: 'sk-lf-...515f',
      },
    });
    render(<LangfuseConnection />);
    await waitFor(() => expect(mockTest).toHaveBeenCalledTimes(1));
    mockTest.mockClear();

    await selectDestination('us');

    expect(mockTest).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/com_ui_langfuse_secret_key/)).toBeVisible();
    expect(screen.getByText('com_ui_langfuse_status_not_verified')).toBeInTheDocument();
    expect(screen.getByText('com_ui_save')).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/com_ui_langfuse_secret_key/), {
      target: { value: 'sk-lf-replacement' },
    });
    await userEvent.click(screen.getByText('com_ui_save'));

    expect(mockTest).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0]).toMatchObject({
      destination: 'us',
      publicKey: 'pk-lf-1',
      secretKey: 'sk-lf-replacement',
    });
  });

  it('opens each configured key independently when its masked value is clicked', async () => {
    mockGet.mockReturnValue({
      data: {
        configured: true,
        enabled: true,
        destinations: [{ key: 'eu', baseUrl: 'https://cloud.langfuse.com' }],
        destination: 'eu',
        publicKey: 'pk-lf-1',
        secretKeyPreview: 'sk-lf-...515f',
      },
    });
    render(<LangfuseConnection />);
    await waitFor(() => expect(mockTest).toHaveBeenCalledTimes(1));
    mockTest.mockClear();

    expect(screen.queryByLabelText('com_ui_langfuse_secret_key')).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', {
        name: 'com_ui_edit com_ui_langfuse_public_key',
      }),
    );

    expect(screen.queryByRole('button', { name: 'com_ui_cancel' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_save' })).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'com_ui_langfuse_disable' }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('com_ui_langfuse_public_key')).toHaveValue('pk-lf-1');
    expect(screen.getByLabelText('com_ui_langfuse_public_key')).toHaveFocus();
    expect(
      screen.queryByLabelText(/com_ui_langfuse_secret_key/, { selector: 'input' }),
    ).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', {
        name: 'com_ui_edit com_ui_langfuse_secret_key',
      }),
    );

    const secretKeyInput = screen.getByLabelText(/com_ui_langfuse_secret_key/);
    expect(secretKeyInput).toHaveValue('');
    expect(secretKeyInput).toHaveClass('w-full');
    expect(secretKeyInput).toHaveFocus();
    fireEvent.change(secretKeyInput, {
      target: { value: 'sk-lf-replacement' },
    });
    await userEvent.click(screen.getByText('com_ui_save'));

    expect(mockTest).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0]).toMatchObject({
      destination: 'eu',
      publicKey: 'pk-lf-1',
      secretKey: 'sk-lf-replacement',
    });
  });

  it('preserves a disabled connection when saving edited credentials', async () => {
    mockGet.mockReturnValue({
      data: {
        configured: true,
        enabled: false,
        destinations: [{ key: 'eu', baseUrl: 'https://cloud.langfuse.com' }],
        destination: 'eu',
        publicKey: 'pk-lf-1',
        secretKeyPreview: 'sk-lf-...515f',
      },
    });
    render(<LangfuseConnection />);
    await waitFor(() => expect(mockTest).toHaveBeenCalledTimes(1));

    await userEvent.click(
      screen.getByRole('button', {
        name: 'com_ui_edit com_ui_langfuse_public_key',
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));

    expect(mockUpdate).toHaveBeenCalledWith(
      {
        enabled: false,
        destination: 'eu',
        publicKey: 'pk-lf-1',
      },
      expect.any(Object),
    );
  });

  it('shows a save failure when mandatory server verification rejects the connection', async () => {
    mockUpdate.mockImplementation((_payload, options) => {
      options?.onError?.();
    });
    render(<LangfuseConnection />);
    await selectDestination('us');
    fireEvent.change(screen.getByLabelText('com_ui_langfuse_public_key'), {
      target: { value: 'pk-lf-1' },
    });
    fireEvent.change(screen.getByLabelText(/com_ui_langfuse_secret_key/), {
      target: { value: 'sk-lf-secret' },
    });

    await userEvent.click(screen.getByText('com_ui_save'));

    expect(mockTest).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('com_ui_langfuse_save_error')).toBeVisible();
  });

  it('replaces a connected status with a failure when an edited public key is rejected', async () => {
    mockGet.mockReturnValue({
      data: {
        configured: true,
        enabled: true,
        destinations: [{ key: 'eu', baseUrl: 'https://cloud.langfuse.com' }],
        destination: 'eu',
        publicKey: 'pk-lf-valid',
        secretKeyPreview: 'sk-lf-...515f',
      },
    });
    render(<LangfuseConnection />);
    await waitFor(() => expect(screen.getByText('com_ui_langfuse_status_connected')).toBeVisible());
    mockTest.mockClear();
    mockUpdate.mockImplementation((_payload, options) => {
      options?.onError?.();
    });

    await userEvent.click(
      screen.getByRole('button', {
        name: 'com_ui_edit com_ui_langfuse_public_key',
      }),
    );
    fireEvent.change(screen.getByLabelText('com_ui_langfuse_public_key'), {
      target: { value: 'pk-lf-mangled' },
    });
    expect(screen.getByText('com_ui_langfuse_status_not_verified')).toBeVisible();
    fireEvent.change(screen.getByLabelText(/com_ui_langfuse_secret_key/), {
      target: { value: 'sk-lf-replacement' },
    });
    await userEvent.click(screen.getByText('com_ui_save'));

    expect(mockTest).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: 'pk-lf-mangled',
        secretKey: 'sk-lf-replacement',
      }),
      expect.any(Object),
    );
    expect(screen.getByText('com_ui_langfuse_save_error')).toBeVisible();
  });

  it('saves immediately without testing when disabling a configured connection', async () => {
    mockGet.mockReturnValue({
      data: {
        configured: true,
        enabled: true,
        destinations: [{ key: 'eu', baseUrl: 'https://cloud.langfuse.com' }],
        destination: 'eu',
        publicKey: 'pk-lf-1',
        secretKeyPreview: 'sk-lf-...515f',
      },
    });
    render(<LangfuseConnection />);
    await waitFor(() => expect(mockTest).toHaveBeenCalledTimes(1));
    mockTest.mockClear();
    mockUpdate.mockImplementation((_payload, options) => {
      options?.onSuccess?.({
        configured: true,
        enabled: false,
        destinations: [{ key: 'eu', baseUrl: 'https://cloud.langfuse.com' }],
        destination: 'eu',
        publicKey: 'pk-lf-1',
        secretKeyPreview: 'sk-lf-...515f',
        updatedAt: '2026-07-10T15:30:00.000Z',
      });
    });

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_langfuse_disable' }));

    expect(mockTest).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0]).toMatchObject({
      enabled: false,
      destination: 'eu',
      publicKey: 'pk-lf-1',
    });
    expect(screen.queryByText('com_ui_save')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_langfuse_enable' })).toBeEnabled();
  });

  it('allows disabling a connection whose saved destination was removed', async () => {
    mockGet.mockReturnValue({
      data: {
        configured: true,
        enabled: true,
        destinations: [{ key: 'eu', baseUrl: 'https://cloud.langfuse.com' }],
        destination: 'removed-destination',
        publicKey: 'pk-lf-1',
        secretKeyPreview: 'sk-lf-...515f',
      },
    });

    render(<LangfuseConnection />);

    expect(screen.getByTestId('langfuse-destination')).toHaveTextContent(
      'removed-destination - com_ui_langfuse_destination_unavailable',
    );
    expect(screen.getByText('com_ui_langfuse_destination_removed')).toBeVisible();
    expect(mockTest).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_langfuse_disable' }));

    expect(mockUpdate).toHaveBeenCalledWith(
      {
        enabled: false,
        destination: 'removed-destination',
        publicKey: 'pk-lf-1',
      },
      expect.any(Object),
    );
  });

  it('saves immediately without testing when enabling a configured connection', async () => {
    mockGet.mockReturnValue({
      data: {
        configured: true,
        enabled: false,
        destinations: [{ key: 'eu', baseUrl: 'https://cloud.langfuse.com' }],
        destination: 'eu',
        publicKey: 'pk-lf-1',
        secretKeyPreview: 'sk-lf-...515f',
      },
    });
    mockUpdate.mockImplementation((_payload, options) => {
      options?.onSuccess?.({
        configured: true,
        enabled: true,
        destinations: [{ key: 'eu', baseUrl: 'https://cloud.langfuse.com' }],
        destination: 'eu',
        publicKey: 'pk-lf-1',
        secretKeyPreview: 'sk-lf-...515f',
        updatedAt: '2026-07-10T15:31:00.000Z',
      });
    });
    render(<LangfuseConnection />);
    await waitFor(() => expect(mockTest).toHaveBeenCalledTimes(1));
    mockTest.mockClear();

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_langfuse_enable' }));

    expect(mockTest).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith(
      { enabled: true, destination: 'eu', publicKey: 'pk-lf-1' },
      expect.any(Object),
    );
    expect(screen.queryByText('com_ui_save')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_langfuse_disable' })).toBeEnabled();
  });
});
