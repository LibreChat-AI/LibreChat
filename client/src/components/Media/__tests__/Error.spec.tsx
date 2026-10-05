import { AxiosError, AxiosHeaders } from 'axios';
import userEvent from '@testing-library/user-event';
import { dataService } from 'librechat-data-provider';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MediaJob, MediaJobDiagnosticsResponse } from 'librechat-data-provider';
import { createMediaTestEnvironment } from 'test/media';
import { MediaJobError } from '../Error';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: { ...jest.requireActual('librechat-data-provider').dataService },
}));

const job = {
  jobId: 'job',
  version: 1,
  phase: 'failed',
  error: { code: 'provider_rejected' },
} satisfies Pick<MediaJob, 'jobId' | 'version' | 'phase' | 'error'>;
const clients: ReturnType<typeof createMediaTestEnvironment>['client'][] = [];
function setup(snapshot: Pick<MediaJob, 'jobId' | 'version' | 'phase' | 'error'> = job) {
  const env = createMediaTestEnvironment();
  clients.push(env.client);
  return { ...env, ...render(<MediaJobError job={snapshot} />, { wrapper: env.wrapper }) };
}
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  jest.restoreAllMocks();
});

test('loads provider details only when expanded and renders provider text literally', async () => {
  let resolve!: (response: MediaJobDiagnosticsResponse) => void;
  const read = jest.spyOn(dataService, 'getMediaJobDiagnostics').mockReturnValue(
    new Promise((finish) => {
      resolve = finish;
    }),
  );
  const view = setup();
  expect(screen.getByRole('alert')).toHaveTextContent('com_media_error_provider_rejected');
  expect(read).not.toHaveBeenCalled();
  const disclosure = screen.getByRole('button', { name: 'com_error_details_provider' });
  expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  disclosure.focus();
  await userEvent.keyboard('{Enter}');
  expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  expect(await screen.findByText('com_media_diagnostics_loading')).toHaveAttribute(
    'role',
    'status',
  );
  const message = '<img src=x onerror=alert(1)>\n[Provider link](https://example.com)';
  await act(async () => {
    resolve({
      diagnostic: { message, status: 400, code: 'INVALID_ARGUMENT', requestId: 'request-1' },
    });
  });
  expect(await screen.findByText(message, { normalizer: (text) => text })).toBeVisible();
  expect(view.container.querySelector('img')).toBeNull();
  expect(view.container.querySelector('a')).toBeNull();
  expect(screen.getByText('400')).toBeVisible();
  expect(screen.getByText('INVALID_ARGUMENT')).toBeVisible();
  expect(screen.getByText('request-1')).toBeVisible();
  expect(read).toHaveBeenCalledWith('job', expect.any(AbortSignal));
  await userEvent.keyboard('{Enter}');
  expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('INVALID_ARGUMENT')).not.toBeInTheDocument();
});

test.each(['missing', 'old-server'] as const)(
  'explains %s provider diagnostics without changing the failure',
  async (mode) => {
    const read = jest.spyOn(dataService, 'getMediaJobDiagnostics');
    if (mode === 'missing') read.mockResolvedValue({});
    else {
      const failure = new AxiosError('Not found');
      failure.response = {
        status: 404,
        statusText: 'Not Found',
        data: {},
        headers: {},
        config: { headers: new AxiosHeaders() },
      };
      read.mockRejectedValue(failure);
    }
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'com_error_details_provider' }));
    expect(await screen.findByText('com_media_diagnostics_unavailable')).toBeVisible();
    expect(screen.getByText('com_media_error_provider_rejected')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'com_media_diagnostics_retry' }),
    ).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(1);
  },
);

test('retries diagnostics independently and refreshes details for a new job version', async () => {
  const read = jest
    .spyOn(dataService, 'getMediaJobDiagnostics')
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce({ diagnostic: { message: 'Original rejection' } })
    .mockResolvedValueOnce({ diagnostic: { message: 'Updated rejection' } });
  const view = setup({ ...job, phase: 'requires_attention' });
  const disclosure = screen.getByRole('button', { name: 'com_error_details_provider' });
  fireEvent.click(disclosure);
  expect(await screen.findByText('com_media_diagnostics_failed')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'com_media_diagnostics_retry' }));
  expect(await screen.findByText('Original rejection')).toBeVisible();
  fireEvent.click(disclosure);
  fireEvent.click(disclosure);
  expect(read).toHaveBeenCalledTimes(2);
  view.rerender(<MediaJobError job={{ ...job, version: 2 }} />);
  expect(await screen.findByText('Updated rejection')).toBeVisible();
  expect(screen.queryByText('Original rejection')).not.toBeInTheDocument();
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
});
