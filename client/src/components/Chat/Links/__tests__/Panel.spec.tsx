import React from 'react';
import { Tools } from 'librechat-data-provider';
import userEvent from '@testing-library/user-event';
import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TAttachment, TMessage } from 'librechat-data-provider';
import { messageAttachmentsMapAtom } from '~/hooks/SSE/atoms';
import { IsolatedAtomStore } from 'test/harness';
import LinksPanel from '../Panel';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, unknown>) =>
    options?.count != null ? `${key}:${options.count}` : key,
}));

let mockMessages: TMessage[] | null = null;
let mockIsLoading = false;

jest.mock('~/data-provider/Messages/queries', () => ({
  useGetMessagesByConvoId: () => ({ data: mockMessages, isLoading: mockIsLoading }),
}));

const conversationId = 'convo-1';

function webSearchMessage(links: Array<{ title: string; link: string }>): TMessage {
  const attachment = {
    messageId: 'message-1',
    toolCallId: 'call-1',
    conversationId,
    type: Tools.web_search,
    [Tools.web_search]: { organic: links },
  } as TAttachment;
  return { messageId: 'message-1', attachments: [attachment] } as TMessage;
}

/** Renders and lets Ariakit's store hydration microtasks land inside `act`. */
async function renderPanel({ onClose = jest.fn() } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <IsolatedAtomStore>
        <LinksPanel conversationId={conversationId} onClose={onClose} />
      </IsolatedAtomStore>
    </QueryClientProvider>,
  );
  await act(async () => {});
  return { onClose, ...result };
}

describe('LinksPanel', () => {
  afterEach(() => {
    mockMessages = null;
    mockIsLoading = false;
  });

  it('renders every used source as a link row grouped under the All tab', async () => {
    mockMessages = [
      webSearchMessage([{ title: 'Result A', link: 'https://a.example/page' }]),
      webSearchMessage([{ title: 'Result B', link: 'https://b.example/page' }]),
    ];
    await renderPanel();

    expect(screen.getByRole('region', { name: 'com_links_panel' })).toBeInTheDocument();
    expect(screen.getByText('com_links_count:2')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Result A/ })).toHaveAttribute(
      'href',
      'https://a.example/page',
    );
    expect(screen.getByRole('link', { name: /Result B/ })).toHaveAttribute(
      'href',
      'https://b.example/page',
    );
  });

  it('renders the empty state when the conversation used no sources', async () => {
    mockMessages = [];
    await renderPanel();

    expect(screen.getByText('com_links_empty')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders the loading state without rows while messages load', async () => {
    mockIsLoading = true;
    mockMessages = null;
    await renderPanel();

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText('com_links_empty')).not.toBeInTheDocument();
  });

  it('includes sources that are still streaming and unsaved', async () => {
    mockMessages = [];
    const live = {
      messageId: 'message-2',
      toolCallId: 'call-2',
      conversationId,
      type: Tools.web_search,
      [Tools.web_search]: { organic: [{ title: 'Live result', link: 'https://live.example/x' }] },
    } as TAttachment;

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    });
    render(
      <QueryClientProvider client={client}>
        <IsolatedAtomStore
          seed={(store) => store.set(messageAttachmentsMapAtom, { 'message-2': [live] })}
        >
          <LinksPanel conversationId={conversationId} onClose={jest.fn()} />
        </IsolatedAtomStore>
      </QueryClientProvider>,
    );
    await act(async () => {});

    expect(screen.getByRole('link', { name: /Live result/ })).toHaveAttribute(
      'href',
      'https://live.example/x',
    );
  });

  it('closes through the panel header button', async () => {
    mockMessages = [];
    const onClose = jest.fn();
    await renderPanel({ onClose });

    await userEvent.click(screen.getByTestId('links-panel-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
