import { useState } from 'react';
import { dataService } from 'librechat-data-provider';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMediaTestEnvironment } from 'test/media';
import { MediaDeleteDialog } from '../Delete';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: { ...jest.requireActual('librechat-data-provider').dataService },
}));

afterEach(() => jest.restoreAllMocks());

test('keeps failed selections retryable and clears only successful selections', async () => {
  const remove = jest
    .spyOn(dataService, 'deleteMediaThreads')
    .mockResolvedValueOnce({
      retired: 1,
      failures: [{ threadId: 'failed', error: { code: 'internal_error' } }],
    })
    .mockResolvedValueOnce({ retired: 1, failures: [] });
  const env = createMediaTestEnvironment();
  function Harness() {
    const [ids, setIds] = useState(['ok', 'failed']);
    const [open, setOpen] = useState(true);
    return (
      <MediaDeleteDialog
        host={env.host}
        request={{ mode: 'selected', threadIds: ids }}
        open={open}
        onOpenChange={setOpen}
        onDeleted={setIds}
      />
    );
  }
  const view = render(<Harness />, { wrapper: env.wrapper });
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_delete' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('com_media_delete_partial');
  expect(remove).toHaveBeenLastCalledWith({ mode: 'selected', threadIds: ['ok', 'failed'] });
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_delete' }));
  await waitFor(() =>
    expect(remove).toHaveBeenLastCalledWith({ mode: 'selected', threadIds: ['failed'] }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  view.unmount();
  env.client.clear();
});

test('a failed clear-all request remains open for explicit retry', async () => {
  const remove = jest
    .spyOn(dataService, 'deleteMediaThreads')
    .mockRejectedValue(new Error('offline'));
  const env = createMediaTestEnvironment();
  const close = jest.fn();
  const view = render(
    <MediaDeleteDialog host={env.host} request={{ mode: 'all' }} open onOpenChange={close} />,
    { wrapper: env.wrapper },
  );
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_delete' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('com_media_error_internal_error');
  expect(remove).toHaveBeenCalledWith({ mode: 'all' });
  expect(close).not.toHaveBeenCalled();
  view.unmount();
  env.client.clear();
});
