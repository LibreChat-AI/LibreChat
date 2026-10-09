import React, { useEffect, useState } from 'react';
import userEvent from '@testing-library/user-event';
import { QueryKeys, dataService } from 'librechat-data-provider';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TStartupConfig, TTraceViewerConfig } from 'librechat-data-provider';
import { IsolatedAtomStore } from 'test/harness';
import useTraceControl from '../useTraceControl';
import TraceSurface from '../Surface';
import TraceButton from '../Button';

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

type MockStartupConfig = Omit<Partial<TStartupConfig>, 'interface'> & {
  interface?: Partial<NonNullable<TStartupConfig['interface']>>;
};

let mockStartupConfig: MockStartupConfig = {};

jest.mock('~/data-provider/Endpoints/queries', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => {
  const actual = jest.requireActual('@librechat/client');
  return {
    ...actual,
    TooltipAnchor: ({ render: node }: { render: React.ReactNode }) => node,
  };
});

const mounts = { count: 0 };

function Chat() {
  const [draft, setDraft] = useState('');
  useEffect(() => {
    mounts.count++;
  }, []);
  return <input aria-label="composer" value={draft} onChange={(e) => setDraft(e.target.value)} />;
}

function Host({
  conversationId,
  traceViewer = { enabled: true },
  isSubmitting = false,
  enabled = true,
}: {
  conversationId: string;
  traceViewer?: TTraceViewerConfig;
  isSubmitting?: boolean;
  enabled?: boolean;
}) {
  const trace = useTraceControl({ conversationId, traceViewer, isSubmitting, enabled });
  return (
    <TraceSurface conversationId={conversationId}>
      <div data-testid="chat-pane">
        {trace.show && <TraceButton onClick={trace.open} />}
        <Chat />
      </div>
    </TraceSurface>
  );
}

function renderHost(props: React.ComponentProps<typeof Host>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const wrap = (next: React.ComponentProps<typeof Host>) => (
    <QueryClientProvider client={client}>
      <IsolatedAtomStore>
        <Host {...next} />
      </IsolatedAtomStore>
    </QueryClientProvider>
  );
  const utils = render(wrap(props));
  return {
    ...utils,
    client,
    rerenderHost: (next: React.ComponentProps<typeof Host>) => utils.rerender(wrap(next)),
  };
}

const traceButton = () => screen.queryByTestId('header-trace-button');
const chatPane = () => screen.getByTestId('chat-pane').parentElement as HTMLElement;

describe('trace entry point and surface', () => {
  let availability: jest.SpiedFunction<typeof dataService.getConversationTraceAvailability>;

  beforeEach(() => {
    mounts.count = 0;
    mockStartupConfig = { interface: { traceViewer: { enabled: true } } };
    availability = jest
      .spyOn(dataService, 'getConversationTraceAvailability')
      .mockResolvedValue({ available: true });
    jest.spyOn(dataService, 'getConversationTraceRecords').mockResolvedValue({ records: [] });
  });

  it('shows the control only for an available trace on an enabled deployment', async () => {
    renderHost({ conversationId: 'convo-1' });

    expect(await screen.findByTestId('header-trace-button')).toBeInTheDocument();
    expect(availability).toHaveBeenCalledWith('convo-1');
  });

  it.each([
    ['the viewer is disabled', { conversationId: 'convo-1', traceViewer: { enabled: false } }],
    ['the chat is new', { conversationId: 'new' }],
    ['the host opts out', { conversationId: 'convo-1', enabled: false }],
  ])('never asks for availability when %s', async (_label, props) => {
    renderHost(props);

    await waitFor(() => expect(traceButton()).not.toBeInTheDocument());
    expect(availability).not.toHaveBeenCalled();
  });

  it('hides the control for a conversation with no sampled trace', async () => {
    availability.mockResolvedValue({ available: false });
    renderHost({ conversationId: 'convo-1' });

    await waitFor(() => expect(availability).toHaveBeenCalled());
    expect(traceButton()).not.toBeInTheDocument();
  });

  it('re-reads availability once a running response settles', async () => {
    availability.mockResolvedValue({ available: false });
    const { rerenderHost } = renderHost({ conversationId: 'convo-1' });
    await waitFor(() => expect(availability).toHaveBeenCalledTimes(1));

    rerenderHost({ conversationId: 'convo-1', isSubmitting: true });
    availability.mockResolvedValue({ available: true });
    expect(availability).toHaveBeenCalledTimes(1);

    rerenderHost({ conversationId: 'convo-1', isSubmitting: false });

    expect(await screen.findByTestId('header-trace-button')).toBeInTheDocument();
    expect(availability).toHaveBeenCalledTimes(2);
  });

  it('reads the trace again after a response settles instead of reusing cached pages', async () => {
    const list = jest
      .spyOn(dataService, 'getConversationTraceRecords')
      .mockResolvedValue({ records: [] });
    const { rerenderHost } = renderHost({ conversationId: 'convo-1' });
    const close = () => userEvent.click(screen.getByRole('button', { name: 'com_ui_trace_close' }));

    await userEvent.click(await screen.findByTestId('header-trace-button'));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await close();
    await userEvent.click(screen.getByTestId('header-trace-button'));
    await close();
    expect(list).toHaveBeenCalledTimes(1);

    rerenderHost({ conversationId: 'convo-1', isSubmitting: true });
    rerenderHost({ conversationId: 'convo-1', isSubmitting: false });
    await userEvent.click(await screen.findByTestId('header-trace-button'));

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('marks cached record details stale too when a response settles', async () => {
    const { rerenderHost, client } = renderHost({ conversationId: 'convo-1' });
    const detailKey = [QueryKeys.conversationTraceRecord, 'convo-1', 'obs-1', null];
    client.setQueryData(detailKey, { record: {}, contentAvailable: true });

    rerenderHost({ conversationId: 'convo-1', isSubmitting: true });
    rerenderHost({ conversationId: 'convo-1', isSubmitting: false });

    await waitFor(() => expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true));
  });

  it('retries a transient availability failure instead of hiding the control for good', async () => {
    availability
      .mockRejectedValueOnce(
        Object.assign(new Error('unavailable'), {
          isAxiosError: true,
          response: { status: 503 },
        }),
      )
      .mockResolvedValue({ available: true });
    const client = new QueryClient({
      defaultOptions: { queries: { retryDelay: 1 } },
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    });
    render(
      <QueryClientProvider client={client}>
        <IsolatedAtomStore>
          <Host conversationId="convo-1" />
        </IsolatedAtomStore>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('header-trace-button')).toBeInTheDocument();
    expect(availability).toHaveBeenCalledTimes(2);
  });

  it('checks availability again when the server cannot decide yet', async () => {
    availability
      .mockResolvedValueOnce({ available: false, retryAfterMs: 20 })
      .mockResolvedValue({ available: true });
    renderHost({ conversationId: 'convo-1' });

    expect(await screen.findByTestId('header-trace-button')).toBeInTheDocument();
    expect(availability).toHaveBeenCalledTimes(2);
  });

  it('covers the chat without unmounting it and restores it with focus on close', async () => {
    renderHost({ conversationId: 'convo-1' });
    await userEvent.type(screen.getByLabelText('composer'), 'unsent draft');
    const button = await screen.findByTestId('header-trace-button');

    await userEvent.click(button);

    expect(await screen.findByTestId('trace-viewer')).toBeInTheDocument();
    expect(chatPane()).toHaveAttribute('inert');
    expect(chatPane()).toHaveClass('isolate');
    expect(screen.getByRole('button', { name: 'com_ui_trace_close' })).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_trace_close' }));

    expect(screen.queryByTestId('trace-viewer')).not.toBeInTheDocument();
    expect(chatPane()).not.toHaveAttribute('inert');
    expect(screen.getByLabelText('composer')).toHaveValue('unsent draft');
    expect(mounts.count).toBe(1);
    expect(screen.getByTestId('header-trace-button')).toHaveFocus();
  });

  it('leaves focus where a navigation put it when that navigation closes the trace', async () => {
    const outside = document.createElement('button');
    outside.textContent = 'sidebar link';
    document.body.appendChild(outside);
    const { rerenderHost, client } = renderHost({ conversationId: 'convo-1' });
    /** The next chat also has a trace, so the opener stays mounted and could steal focus back. */
    client.setQueryData([QueryKeys.conversationTraceAvailability, 'convo-2'], { available: true });
    await userEvent.click(await screen.findByTestId('header-trace-button'));
    expect(await screen.findByTestId('trace-viewer')).toBeInTheDocument();

    outside.focus();
    rerenderHost({ conversationId: 'convo-2' });

    expect(screen.queryByTestId('trace-viewer')).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it('does not carry an open trace into another conversation', async () => {
    const { rerenderHost } = renderHost({ conversationId: 'convo-1' });
    await userEvent.click(await screen.findByTestId('header-trace-button'));
    expect(await screen.findByTestId('trace-viewer')).toBeInTheDocument();

    rerenderHost({ conversationId: 'convo-2' });
    expect(screen.queryByTestId('trace-viewer')).not.toBeInTheDocument();

    rerenderHost({ conversationId: 'convo-1' });
    expect(screen.queryByTestId('trace-viewer')).not.toBeInTheDocument();
  });
});
