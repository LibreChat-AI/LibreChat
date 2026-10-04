import React, { useRef } from 'react';
import userEvent from '@testing-library/user-event';
import { dataService, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type t from 'librechat-data-provider';
import type { VirtualLayout } from './layout';
import '@testing-library/jest-dom';
import { installVirtualLayout, makeAgents } from './layout';
import AgentGrid from '../AgentGrid';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService, getMarketplaceAgents: jest.fn() } };
});
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAgentCategories: () => ({ categories: [] }),
}));
jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils/agents'),
  cn: (...classes: Array<string | false | undefined | null>) => classes.filter(Boolean).join(' '),
}));
jest.mock('../ErrorDisplay', () => ({
  __esModule: true,
  default: ({ error, onRetry }: { error: Error; onRetry: () => void }) => (
    <div role="alert">
      <span>{error.message}</span>
      <button onClick={onRetry}>{'Retry'}</button>
    </div>
  ),
}));
/* The dialog's own rendering belongs to its spec; what matters here is that the grid that
   owns it stays mounted, so this stands in for it without a router or a host context. */
jest.mock('../AgentDetailContent', () => {
  const { OGDialogContent, OGDialogTitle, OGDialogClose } = jest.requireActual('@librechat/client');
  return {
    __esModule: true,
    default: ({ agent }: { agent: t.Agent }) => (
      <OGDialogContent aria-describedby={undefined} showCloseButton={false}>
        <OGDialogTitle>{agent.name}</OGDialogTitle>
        <OGDialogClose>{'Close preview'}</OGDialogClose>
      </OGDialogContent>
    ),
  };
});

const page = (agents: t.Agent[], after?: string): t.AgentListResponse => ({
  object: 'list',
  data: agents,
  first_id: agents[0]?.id ?? '',
  last_id: agents.at(-1)?.id ?? '',
  has_more: after != null,
  after,
});
function Harness({ searchQuery = '', mine }: { searchQuery?: string; mine?: 0 | 1 }) {
  const scrollElementRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollElementRef} data-testid="viewport">
      <AgentGrid
        category="all"
        searchQuery={searchQuery}
        mine={mine}
        scrollElementRef={scrollElementRef}
      />
    </div>
  );
}

describe('AgentGrid pagination', () => {
  const marketplace = jest.mocked(dataService.getMarketplaceAgents);
  let client: QueryClient;
  let layout: VirtualLayout;
  beforeEach(() => {
    marketplace.mockReset();
    layout = installVirtualLayout();
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
      logger: { log: console.log, warn: console.warn, error: () => {} },
    });
  });
  afterEach(() => {
    client.clear();
    layout.cleanup();
  });
  const renderGrid = () =>
    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );

  it('replaces previous filter results while pending and restores fresh cached results instantly', async () => {
    const pending = Promise.withResolvers<t.AgentListResponse>();
    marketplace.mockResolvedValueOnce(page(makeAgents(1))).mockReturnValueOnce(pending.promise);
    const view = renderGrid();
    await screen.findByRole('button', { name: 'Agent 0' });
    const frame = screen.getByTestId('viewport');
    frame.scrollTop = 1000;
    view.rerender(
      <QueryClientProvider client={client}>
        <Harness mine={1} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('status', { name: 'com_agents_loading' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Agent 0' })).not.toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'true');
    expect(frame.scrollTop).toBe(0);
    expect(screen.queryByText('com_agents_mine_empty_state_heading')).not.toBeInTheDocument();
    await act(async () => pending.resolve(page([])));
    expect(await screen.findByText('com_agents_mine_empty_state_heading')).toBeInTheDocument();
    await act(async () => {
      view.rerender(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
      );
    });
    expect(screen.getByRole('button', { name: 'Agent 0' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'com_agents_loading' })).not.toBeInTheDocument();
    expect(marketplace).toHaveBeenCalledTimes(2);
  });

  it('fills the visible viewport with skeletons and refits them when it changes', async () => {
    const pending = Promise.withResolvers<t.AgentListResponse>();
    marketplace.mockReturnValueOnce(pending.promise);
    renderGrid();
    const status = await screen.findByRole('status', { name: 'com_agents_loading' });
    const skeletons = status.querySelector('[aria-hidden="true"]') as HTMLElement;
    /** 1400x600 viewport: 4 resolved columns, 2 rows of 300px reach the fold. */
    await waitFor(() => expect(skeletons.children).toHaveLength(8));
    act(() => layout.resize(700, 400));
    await waitFor(() => expect(skeletons.children).toHaveLength(4));
    act(() => layout.resize(360, 700));
    await waitFor(() => expect(skeletons.children).toHaveLength(3));
    /** 980px leaves 80px of a fourth row: too thin to read as a card, so it is dropped. */
    act(() => layout.resize(1400, 980));
    await waitFor(() => expect(skeletons.children).toHaveLength(12));
    await act(async () => pending.resolve(page(makeAgents(1))));
    expect(await screen.findByRole('button', { name: 'Agent 0' })).toBeInTheDocument();
  });

  it('fetches the next cursor page near the viewport end and keeps the DOM bounded', async () => {
    const pending = Promise.withResolvers<t.AgentListResponse>();
    marketplace
      .mockResolvedValueOnce(page(makeAgents(32), 'next-page'))
      .mockReturnValueOnce(pending.promise);
    renderGrid();
    await screen.findByRole('button', { name: 'Agent 0' });
    expect(marketplace).toHaveBeenCalledTimes(1);
    const frame = screen.getByTestId('viewport');
    act(() => {
      frame.scrollTop = frame.scrollHeight - frame.clientHeight;
      fireEvent.scroll(frame);
    });
    await screen.findByRole('status', { name: 'com_agents_loading' });
    expect(screen.getByRole('button', { name: 'Agent 31' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false');
    await act(async () => pending.resolve(page(makeAgents(32, 32))));
    await screen.findByRole('button', { name: 'Agent 32' });
    expect(marketplace).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'next-page' }));
    expect(screen.getAllByRole('listitem').length).toBeLessThan(50);
  });

  it('continues past an empty cursor page instead of reporting an empty marketplace', async () => {
    marketplace
      .mockResolvedValueOnce(page([], 'after-removed-row'))
      .mockResolvedValueOnce(page(makeAgents(1)));
    renderGrid();
    expect(await screen.findByRole('button', { name: 'Agent 0' })).toBeInTheDocument();
    expect(marketplace).toHaveBeenCalledTimes(2);
  });

  it('deduplicates agents that move across popularity page boundaries', async () => {
    const initial = makeAgents(32);
    marketplace
      .mockResolvedValueOnce(page(initial, 'next-page'))
      .mockResolvedValueOnce(page([initial[31], ...makeAgents(4, 32)]));
    renderGrid();
    await screen.findByRole('button', { name: 'Agent 0' });
    const frame = screen.getByTestId('viewport');
    act(() => {
      frame.scrollTop = frame.scrollHeight - frame.clientHeight;
      fireEvent.scroll(frame);
    });
    await screen.findByRole('button', { name: 'Agent 35' });
    expect(screen.getAllByRole('button', { name: 'Agent 31' })).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: 'Agent 35' }).closest('[role="listitem"]'),
    ).toHaveAttribute('aria-setsize', '36');
  });

  it('clears the held cursor failure after a whole-walk reset succeeds', async () => {
    const mismatch = Object.assign(new Error('Cursor ordering mismatch'), {
      response: {
        status: 409,
        data: { error: 'cursor_ordering_mismatch' },
      },
    });
    marketplace
      .mockResolvedValueOnce(page(makeAgents(32), 'foreign-order'))
      .mockRejectedValueOnce(mismatch)
      .mockResolvedValueOnce(page(makeAgents(1)));
    renderGrid();
    await screen.findByRole('button', { name: 'Agent 0' });

    const frame = screen.getByTestId('viewport');
    act(() => {
      frame.scrollTop = frame.scrollHeight - frame.clientHeight;
      fireEvent.scroll(frame);
    });

    await waitFor(() => {
      expect(marketplace).toHaveBeenCalledTimes(3);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Agent 0' })).toBeEnabled();
    });
  });

  it('shows a fetch error and recovers through the retry action', async () => {
    // A transport failure is retried inside the query (initial attempt plus two
    // retries) before the error card takes over recovery.
    marketplace
      .mockRejectedValueOnce(new Error('Agents unavailable'))
      .mockRejectedValueOnce(new Error('Agents unavailable'))
      .mockRejectedValueOnce(new Error('Agents unavailable'))
      .mockResolvedValueOnce(page(makeAgents(1)));
    renderGrid();
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent(
      'Agents unavailable',
    );
    expect(marketplace).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Agent 0' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
  it('puts recovery before loaded rows in keyboard order', async () => {
    const user = userEvent.setup();
    marketplace
      .mockResolvedValueOnce(page(makeAgents(32), 'next-page'))
      .mockRejectedValueOnce(new Error('Cursor page unavailable'))
      .mockRejectedValueOnce(new Error('Cursor page unavailable'))
      .mockRejectedValueOnce(new Error('Cursor page unavailable'));
    renderGrid();
    await screen.findByRole('button', { name: 'Agent 0' });
    const firstRow = screen.getAllByRole('listitem')[0];
    const frame = screen.getByTestId('viewport');
    act(() => {
      frame.scrollTop = frame.scrollHeight - frame.clientHeight;
      fireEvent.scroll(frame);
    });
    const rowTopBeforeFailure = firstRow.getBoundingClientRect().top;
    await screen.findByRole('alert', {}, { timeout: 5000 });
    expect(firstRow.getBoundingClientRect().top).toBe(rowTopBeforeFailure);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveFocus();
  });

  it('hides previous-scope rows when the replacement request fails', async () => {
    marketplace
      .mockResolvedValueOnce(page(makeAgents(1)))
      .mockRejectedValueOnce(new Error('My agents unavailable'))
      .mockRejectedValueOnce(new Error('My agents unavailable'))
      .mockRejectedValueOnce(new Error('My agents unavailable'));
    const view = renderGrid();
    await screen.findByRole('button', { name: 'Agent 0' });

    view.rerender(
      <QueryClientProvider client={client}>
        <Harness mine={1} />
      </QueryClientProvider>,
    );

    await screen.findByRole('alert', {}, { timeout: 5000 });
    expect(screen.queryByRole('button', { name: 'Agent 0' })).not.toBeInTheDocument();
  });

  it('keeps the error state in place while a retry is in flight', async () => {
    const pending = Promise.withResolvers<t.AgentListResponse>();
    marketplace
      .mockRejectedValueOnce(new Error('Agents unavailable'))
      .mockRejectedValueOnce(new Error('Agents unavailable'))
      .mockRejectedValueOnce(new Error('Agents unavailable'))
      .mockReturnValueOnce(pending.promise);
    renderGrid();
    await screen.findByRole('alert', {}, { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    /* Waits for the retry to actually be in flight — `aria-busy` is the only thing that
       says so from outside — because that is the state the card has to survive:
       react-query clears `error` for the duration, and neither a skeleton nor a remount
       may take the card's place. A skeleton fills the viewport above it and pushes its
       status, countdown and action below the fold; a remount resets the backoff. */
    await waitFor(() => expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'true'));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'com_agents_loading' })).not.toBeInTheDocument();
    await act(async () => {
      pending.resolve(page(makeAgents(1)));
      await pending.promise;
    });
    expect(await screen.findByRole('button', { name: 'Agent 0' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retries the cursor page that failed rather than refreshing the pages it already has', async () => {
    // Refreshing the loaded prefix succeeds without ever fetching the missing page, which
    // would clear the held failure and let the grid ask for the same cursor again with a
    // fresh backoff — an unbounded cycle while that page keeps failing.
    const pending = Promise.withResolvers<t.AgentListResponse>();
    marketplace
      .mockResolvedValueOnce(page(makeAgents(32), 'next-page'))
      .mockRejectedValueOnce(new Error('Cursor page unavailable'))
      .mockRejectedValueOnce(new Error('Cursor page unavailable'))
      .mockRejectedValueOnce(new Error('Cursor page unavailable'))
      .mockReturnValueOnce(pending.promise);
    renderGrid();
    await screen.findByRole('button', { name: 'Agent 0' });
    const frame = screen.getByTestId('viewport');
    act(() => {
      frame.scrollTop = frame.scrollHeight - frame.clientHeight;
      fireEvent.scroll(frame);
    });

    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent(
      'Cursor page unavailable',
    );
    // The rows the user was reading stay mounted behind the error card. Unmounting the
    // list collapses its scrollable height, which is what let the browser clamp the
    // scroll position and drop someone browsing deep in the marketplace back to row one.
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(marketplace).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'next-page' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await act(async () => {
      pending.resolve(page(makeAgents(32, 32)));
      await pending.promise;
    });
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    // The list was never unmounted, so the virtualizer still renders the window the user
    // was reading rather than the first row; assert the recovered length instead.
    expect(screen.getAllByRole('listitem')[0]).toHaveAttribute('aria-setsize', '64');
  });

  it('clears a failed refresh of the cached pages once a refresh succeeds', async () => {
    // A refresh failure leaves the page count unchanged, so recovery cannot be read from
    // the list getting longer: that rule belongs to a failed cursor page alone.
    marketplace
      .mockResolvedValueOnce(page(makeAgents(4)))
      .mockRejectedValueOnce(new Error('Refresh unavailable'))
      .mockRejectedValueOnce(new Error('Refresh unavailable'))
      .mockRejectedValueOnce(new Error('Refresh unavailable'))
      .mockResolvedValueOnce(page(makeAgents(4)));
    renderGrid();
    await screen.findByRole('button', { name: 'Agent 0' });

    await act(async () => {
      await client.refetchQueries({ queryKey: [QueryKeys.marketplaceAgents] });
    });
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent(
      'Refresh unavailable',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('button', { name: 'Agent 0' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('keeps an open dialog while the results it was opened from are being refreshed', async () => {
    // The refresh runs with no data of its own, so the grid renders its skeleton - which
    // used to replace the grid, and with it the dialog the reader had open and the element
    // focus has to return to.
    const pending = Promise.withResolvers<t.AgentListResponse>();
    marketplace.mockResolvedValueOnce(page(makeAgents(2))).mockReturnValueOnce(pending.promise);
    renderGrid();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Agent 0' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await act(async () => {
      void client.resetQueries({ queryKey: [QueryKeys.marketplaceAgents] });
    });
    /* Radix marks everything behind an open modal `aria-hidden`, so the grid behind it is
       only reachable with `hidden`. */
    expect(
      await screen.findByRole('status', { name: 'com_agents_loading', hidden: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => pending.resolve(page(makeAgents(2))));
    expect(
      await screen.findByRole('button', { name: 'Agent 0', hidden: true }),
    ).toBeInTheDocument();
  });
  it('leaves focus on document body on the initial marketplace mount', async () => {
    const pending = Promise.withResolvers<t.AgentListResponse>();
    marketplace.mockReturnValueOnce(pending.promise);

    document.body.focus();

    renderGrid();

    expect(document.activeElement).toBe(document.body);
    await act(async () => pending.resolve(page(makeAgents(1))));
  });

  it('returns focus to the results panel when recovery removes the focused retry', async () => {
    // The reader activated Retry from the keyboard, so the control they were on is inside
    // the card the success removes. The browser drops focus on the document in that
    // commit, which would start their next Tab at the top of the page rather than at the
    // results that just arrived.
    marketplace
      .mockRejectedValueOnce(new Error('Agents unavailable'))
      .mockRejectedValueOnce(new Error('Agents unavailable'))
      .mockRejectedValueOnce(new Error('Agents unavailable'))
      .mockResolvedValueOnce(page(makeAgents(1)));

    renderGrid();
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent(
      'Agents unavailable',
    );

    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    expect(retry).toHaveFocus();
    fireEvent.click(retry);

    expect(await screen.findByRole('button', { name: 'Agent 0' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveFocus();
  });

  it('leaves the retry focused when the attempt fails again', async () => {
    // Recovery moves focus because a removal took it, not because a request went out: the
    // card is still there and the reader is still on its button, so taking focus away
    // would cost them the control they are using.
    marketplace.mockRejectedValue(new Error('Agents unavailable'));

    renderGrid();
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent(
      'Agents unavailable',
    );

    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    await act(async () => {
      fireEvent.click(retry);
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveFocus();
  });
  it('takes focus back when a scope change remounts the rows under an open dialog', async () => {
    // A debounced search or a restored history entry commits while a card is open. The new
    // scope's grid is a different list, so the dialog goes with the rows it belonged to -
    // but the focus it held must not be left on the document, which starts the next Tab at
    // the top of the page instead of at the marketplace.
    const pending = Promise.withResolvers<t.AgentListResponse>();
    marketplace.mockResolvedValueOnce(page(makeAgents(2))).mockReturnValueOnce(pending.promise);
    const view = renderGrid();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Agent 0' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    view.rerender(
      <QueryClientProvider client={client}>
        <Harness mine={1} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('status', { name: 'com_agents_loading' })).toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole('tabpanel')).toContainElement(document.activeElement as HTMLElement);
    await act(async () => pending.resolve(page(makeAgents(1, 8))));
    expect(await screen.findByRole('button', { name: 'Agent 8' })).toBeInTheDocument();
  });
});
