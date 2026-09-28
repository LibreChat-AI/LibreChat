import { dataService } from 'librechat-data-provider';
import { render, screen, waitFor, act } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import { OwnerTextProvider, PrivateText } from './PrivateText';

let mockOwnerId = 'owner';
let mockTenantId = 'tenant-a';
jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ user: { id: mockOwnerId, tenantId: mockTenantId } }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('librechat-data-provider', () => ({ dataService: { getOwnerMessageTexts: jest.fn() } }));
jest.mock('./Content/MessageContent', () => ({
  DisplayMessage: ({ text, message }: { text: string; message: TMessage }) => (
    <div data-testid="standard-user-renderer" data-canonical={message.text} dir="auto">
      {text}
    </div>
  ),
}));

const canonical = Object.freeze({
  messageId: 'message',
  conversationId: 'conversation',
  isCreatedByUser: true,
  text: '[EMAIL_1_turn]',
  privacyRevision: 'turn',
}) as TMessage;
const load = dataService.getOwnerMessageTexts as jest.Mock;
const original = {
  canonicalText: canonical.text,
  messageId: 'message',
  revision: 'turn',
  text: 'alice@example.com',
};
function View({
  conversationId = 'conversation',
  messages = [canonical],
  displayIndex = 0,
  isSubmitting = false,
}: {
  conversationId?: string;
  messages?: TMessage[];
  displayIndex?: number;
  isSubmitting?: boolean;
}) {
  return (
    <OwnerTextProvider
      messages={messages}
      conversationId={conversationId}
      isSubmitting={isSubmitting}
    >
      <PrivateText message={messages[displayIndex]} />
      <pre data-testid="canonical">{JSON.stringify(messages)}</pre>
    </OwnerTextProvider>
  );
}
beforeEach(() => {
  mockOwnerId = 'owner';
  mockTenantId = 'tenant-a';
  load.mockReset();
});

it('renders originals without mutating canonical model/export input, and reloads from the private API', async () => {
  load.mockResolvedValue({ messages: [original] });
  const first = render(<View />);
  expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
  expect(screen.getByTestId('canonical')).not.toHaveTextContent('alice@example.com');
  expect(screen.getByTestId('standard-user-renderer')).toHaveAttribute(
    'data-canonical',
    canonical.text,
  );
  expect(canonical.text).toBe('[EMAIL_1_turn]');
  expect(screen.getByRole('status')).toHaveTextContent('com_ui_private_text_hidden');
  first.unmount();
  render(<View />);
  expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
  expect(load).toHaveBeenCalledTimes(2);
});

it('does not fetch originals for an ordinary transcript', () => {
  const plain = { ...canonical, privacyRevision: undefined };
  render(
    <OwnerTextProvider messages={[plain]} conversationId="conversation" isSubmitting={false}>
      <span data-testid="ordinary-transcript" />
    </OwnerTextProvider>,
  );
  expect(screen.getByTestId('ordinary-transcript')).toBeInTheDocument();
  expect(load).not.toHaveBeenCalled();
});

it('renders only filtered text without an owner provider, as on external viewers', () => {
  render(<PrivateText message={canonical} />);
  expect(screen.getByText(canonical.text)).toBeInTheDocument();
  expect(load).not.toHaveBeenCalled();
});

it('shows loading then safe unavailable text when decryption or authorization fails', async () => {
  let finish!: (value: { messages: [] }) => void;
  load.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<View />);
  expect(screen.getByRole('status')).toHaveTextContent('com_ui_private_text_loading');
  await act(async () => {
    finish({ messages: [] });
  });
  expect(screen.getByText(canonical.text)).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('com_ui_private_text_unavailable');
});

it('retries a provisional empty owner read once on turn completion, without repeatedly polling', async () => {
  load.mockResolvedValueOnce({ messages: [] });
  load.mockResolvedValueOnce({ messages: [original] });
  const view = render(<View isSubmitting />);
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_private_text_unavailable'),
  );
  expect(load).toHaveBeenCalledTimes(1);
  view.rerender(<View isSubmitting />);
  expect(load).toHaveBeenCalledTimes(1);
  view.rerender(<View isSubmitting={false} />);
  expect(await screen.findByText(original.text)).toBeInTheDocument();
  expect(load).toHaveBeenCalledTimes(2);
  view.rerender(<View isSubmitting={false} />);
  expect(load).toHaveBeenCalledTimes(2);
});

it('does not automatically retry an old missing owner row on unrelated submission transitions', async () => {
  load.mockResolvedValue({ messages: [] });
  const view = render(<View />);
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_private_text_unavailable'),
  );
  view.rerender(<View isSubmitting />);
  view.rerender(<View isSubmitting={false} />);
  expect(load).toHaveBeenCalledTimes(1);
});

it('offers a safe retry after a transient owner-text request failure', async () => {
  load.mockRejectedValueOnce(new Error('temporary outage'));
  load.mockResolvedValueOnce({ messages: [original] });
  render(<View />);

  const retry = await screen.findByRole('button', { name: 'com_ui_private_text_retry' });
  expect(screen.getByText(canonical.text)).toBeInTheDocument();
  expect(screen.getByTestId('canonical')).not.toHaveTextContent(original.text);
  await act(async () => {
    retry.click();
  });
  expect(await screen.findByText(original.text)).toBeInTheDocument();
  expect(load).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('button', { name: 'com_ui_private_text_retry' })).toBeNull();
});

it('does not cache a failed decryption as if it contained a usable original', async () => {
  load.mockResolvedValueOnce({ messages: [{ ...original, text: undefined }] });
  load.mockResolvedValueOnce({ messages: [original] });
  render(<View />);
  const retry = await screen.findByRole('button', { name: 'com_ui_private_text_retry' });
  expect(screen.getByText(canonical.text)).toBeInTheDocument();
  await act(async () => retry.click());
  expect(await screen.findByText(original.text)).toBeInTheDocument();
  expect(load).toHaveBeenCalledTimes(2);
});

it('rejects stale revisions instead of restoring a previous original', async () => {
  load.mockResolvedValue({ messages: [{ ...original, revision: 'old-revision' }] });
  render(<View />);
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_private_text_unavailable'),
  );
  expect(screen.queryByText(original.text)).not.toBeInTheDocument();
});

it('clears the visible original immediately on account switching, ignoring late responses', async () => {
  let finish!: (value: { messages: (typeof original)[] }) => void;
  load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  load.mockResolvedValue({ messages: [] });
  const view = render(<View />);
  mockOwnerId = 'another-owner';
  view.rerender(<View />);
  await act(async () => {
    finish({ messages: [original] });
  });
  expect(screen.queryByText(original.text)).not.toBeInTheDocument();
  expect(screen.getByText(canonical.text)).toBeInTheDocument();
});

it('batches selected private rows and never loads ordinary messages', async () => {
  load.mockResolvedValue({ messages: [] });
  const messages: TMessage[] = Array.from({ length: 51 }, (_, index) => ({
    ...canonical,
    messageId: `message-${index}`,
  }));
  messages.push({ ...canonical, messageId: 'plain', privacyRevision: undefined });
  render(<View messages={messages} />);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(load.mock.calls.map(([, ids]) => ids.length)).toEqual([50, 1]);
  expect(load.mock.calls.flatMap(([, ids]) => ids)).not.toContain('plain');
});

it('loads batches concurrently, publishes completed batches, and only fetches new revisions', async () => {
  let finishFirst!: (value: { messages: (typeof original)[] }) => void;
  load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
  );
  load.mockResolvedValue({ messages: [{ ...original, messageId: 'message-9' }] });
  const messages: TMessage[] = Array.from({ length: 51 }, (_, index) => ({
    ...canonical,
    messageId: `message-${index}`,
  }));
  const view = render(<View messages={messages} displayIndex={9} />);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(await screen.findByText(original.text)).toBeInTheDocument();
  await act(async () => {
    finishFirst({
      messages: load.mock.calls[0][1].map((id: string) => ({ ...original, messageId: id })),
    });
  });
  view.rerender(
    <View messages={[...messages, { ...canonical, messageId: 'message-51' }]} displayIndex={9} />,
  );
  await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  expect(load.mock.calls[2][1]).toEqual(['message-51']);
  expect(screen.getByText(original.text)).toBeInTheDocument();
});

it('invalidates an already rendered original when the canonical message changes', async () => {
  load.mockResolvedValue({ messages: [original] });
  const view = render(<View />);
  expect(await screen.findByText(original.text)).toBeInTheDocument();
  view.rerender(<View messages={[{ ...canonical, text: 'edited canonical' }]} />);
  expect(screen.queryByText(original.text)).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_private_text_unavailable'),
  );
});

it('clears originals when tenant identity changes even if the user ID is unchanged', async () => {
  load.mockResolvedValueOnce({ messages: [original] });
  const view = render(<View />);
  expect(await screen.findByText(original.text)).toBeInTheDocument();
  load.mockResolvedValue({ messages: [] });
  mockTenantId = 'tenant-b';
  view.rerender(<View />);
  expect(screen.queryByText(original.text)).not.toBeInTheDocument();
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});
