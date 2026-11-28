import React from 'react';
import userEvent from '@testing-library/user-event';
import { dataService } from 'librechat-data-provider';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ListedWatch } from 'librechat-data-provider';
import Watching from '../Watching';

const access = { allowed: true };

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${Object.values(values).join(',')}` : key,
  useHasAccess: () => access.allowed,
}));
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: {
    ...jest.requireActual('librechat-data-provider').dataService,
    getAgentEventWatches: jest.fn(),
    deleteAgentEventWatch: jest.fn(),
  },
}));

const service = dataService as jest.Mocked<typeof dataService>;

const watch = (overrides: Partial<ListedWatch> = {}): ListedWatch => ({
  id: 'watch_1',
  user: 'user-1',
  conversationId: 'convo-1',
  agentId: 'agent-1',
  subscription: 'sub_1',
  connection: 'conn_1',
  item: 'github:pr:101#7',
  label: 'acme/widgets#7',
  url: 'https://github.com/acme/widgets/pull/7',
  createdAt: '2026-11-25T12:00:00.000Z',
  expiresAt: '2026-12-09T12:00:00.000Z',
  ...overrides,
});

function renderWatching(props: { conversationId?: string | null; isSubmitting?: boolean } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const tree = (next: typeof props) => (
    <QueryClientProvider client={client}>
      <Watching
        conversationId={'conversationId' in next ? next.conversationId : 'convo-1'}
        isSubmitting={next.isSubmitting ?? false}
      />
    </QueryClientProvider>
  );
  const view = render(tree(props));
  return { ...view, rerenderWith: (next: typeof props) => view.rerender(tree(next)) };
}

const axiosError = (status: number) =>
  Object.assign(new Error('request failed'), { isAxiosError: true, response: { status } });

beforeEach(() => {
  jest.clearAllMocks();
  access.allowed = true;
});

describe('Watching', () => {
  it('shows each pull request the conversation follows, linked to its page', async () => {
    service.getAgentEventWatches.mockResolvedValue({
      watches: [watch(), watch({ id: 'watch_2', label: 'acme/widgets#8', url: undefined })],
    });
    renderWatching();
    const list = await screen.findByRole('list', { name: 'com_ui_events_watches' });
    expect(list).toBeInTheDocument();
    expect(service.getAgentEventWatches).toHaveBeenCalledWith('convo-1');
    expect(
      screen.getByRole('link', { name: 'com_ui_events_watching:acme/widgets#7' }),
    ).toHaveAttribute('href', 'https://github.com/acme/widgets/pull/7');
    expect(screen.getByText('com_ui_events_watching:acme/widgets#8')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'com_ui_events_watch_stop:acme/widgets#8' }),
    ).toBeInTheDocument();
  });

  it('names a paused watch with its reason instead of claiming it, and keeps its stop', async () => {
    service.getAgentEventWatches.mockResolvedValue({
      watches: [
        watch({ paused: 'subscription_off' }),
        watch({ id: 'watch_2', label: 'acme/widgets#8', paused: 'watching_off' }),
        watch({ id: 'watch_3', label: 'acme/widgets#9', paused: 'unbound' }),
        watch({ id: 'watch_4', label: 'acme/widgets#10' }),
      ],
    });
    renderWatching();
    expect(await screen.findByRole('link', { name: 'acme/widgets#7' })).toBeInTheDocument();
    expect(screen.getByText('com_ui_events_watch_paused_off')).toBeInTheDocument();
    expect(screen.getByText('com_ui_events_watch_paused_watching')).toBeInTheDocument();
    expect(screen.getByText('com_ui_events_watch_paused_unbound')).toBeInTheDocument();
    for (const label of ['acme/widgets#7', 'acme/widgets#8', 'acme/widgets#9']) {
      expect(
        screen.queryByRole('link', { name: `com_ui_events_watching:${label}` }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: `com_ui_events_watch_stop:${label}` }),
      ).toBeInTheDocument();
    }
    expect(
      screen.getByRole('link', { name: 'com_ui_events_watching:acme/widgets#10' }),
    ).toBeInTheDocument();
  });

  it('renders nothing while loading or when nothing is followed', async () => {
    let resolve: (value: { watches: ListedWatch[] }) => void = () => {};
    service.getAgentEventWatches.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { container } = renderWatching();
    expect(container).toBeEmptyDOMElement();
    resolve({ watches: [] });
    await waitFor(() => expect(service.getAgentEventWatches).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('says the list failed and offers a retry that shows the watches', async () => {
    service.getAgentEventWatches
      .mockRejectedValueOnce(axiosError(500))
      .mockResolvedValueOnce({ watches: [watch()] });
    renderWatching();
    expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_events_watches_error');
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(
      await screen.findByRole('button', { name: 'com_ui_events_watch_stop:acme/widgets#7' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders nothing against a server that has no watch routes', async () => {
    service.getAgentEventWatches.mockRejectedValueOnce(axiosError(404));
    const { container } = renderWatching();
    await waitFor(() => expect(service.getAgentEventWatches).toHaveBeenCalled());
    // Let the rejection settle into the query's error state before looking.
    await new Promise((done) => setTimeout(done, 50));
    expect(container).toBeEmptyDOMElement();
  });

  it('asks for nothing without access or outside a saved conversation', () => {
    access.allowed = false;
    renderWatching().unmount();
    access.allowed = true;
    renderWatching({ conversationId: 'new' }).unmount();
    renderWatching({ conversationId: null }).unmount();
    expect(service.getAgentEventWatches).not.toHaveBeenCalled();
  });

  it('stops following one and reads the list again', async () => {
    service.getAgentEventWatches
      .mockResolvedValueOnce({ watches: [watch()] })
      .mockResolvedValueOnce({ watches: [] });
    service.deleteAgentEventWatch.mockResolvedValue(undefined);
    const { container } = renderWatching();
    await userEvent.click(
      await screen.findByRole('button', { name: 'com_ui_events_watch_stop:acme/widgets#7' }),
    );
    expect(service.deleteAgentEventWatch).toHaveBeenCalledWith('watch_1');
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(service.getAgentEventWatches).toHaveBeenCalledTimes(2);
  });

  it('says so when stopping fails, but not when the watch had already ended', async () => {
    service.getAgentEventWatches.mockResolvedValue({ watches: [watch()] });
    service.deleteAgentEventWatch.mockRejectedValueOnce(axiosError(500));
    renderWatching();
    const stop = await screen.findByRole('button', {
      name: 'com_ui_events_watch_stop:acme/widgets#7',
    });
    await userEvent.click(stop);
    expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_events_watch_stop_error');

    service.deleteAgentEventWatch.mockRejectedValueOnce(axiosError(404));
    await userEvent.click(stop);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('reads the list again when a turn ends, since the turn may have started a watch', async () => {
    service.getAgentEventWatches
      .mockResolvedValueOnce({ watches: [] })
      .mockResolvedValueOnce({ watches: [watch()] });
    const { rerenderWith } = renderWatching({ isSubmitting: true });
    await waitFor(() => expect(service.getAgentEventWatches).toHaveBeenCalledTimes(1));
    rerenderWith({ isSubmitting: false });
    expect(
      await screen.findByRole('link', { name: 'com_ui_events_watching:acme/widgets#7' }),
    ).toBeInTheDocument();
    expect(service.getAgentEventWatches).toHaveBeenCalledTimes(2);
  });
});
