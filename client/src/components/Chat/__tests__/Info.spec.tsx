import { useRef, useState } from 'react';
import copy from 'copy-to-clipboard';
import { Button } from '@librechat/client';
import { Provider, createStore } from 'jotai';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { EMPTY_USAGE, EMPTY_USAGE_TOTALS } from '@librechat/chat';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within, waitFor } from '@testing-library/react';
import { Constants, EModelEndpoint, QueryKeys } from 'librechat-data-provider';
import { totalUsageFamily, pendingUsageFamily, subagentUsageFamily } from '@librechat/chat/react';
import type { TConversation, TMessage } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import Info from '../Info';
import '~/locales/i18n';

jest.mock('copy-to-clipboard', () => jest.fn(() => true));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useCopyToClipboard: jest.requireActual('~/hooks/Messages/useCopyToClipboard').default,
}));

const conversation: TConversation = {
  conversationId: 'info-conversation',
  title: 'A branching conversation',
  endpoint: EModelEndpoint.openAI,
  model: 'test-model',
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-05T15:00:00Z',
  maxContextTokens: 128000,
  temperature: 0,
};
const id = conversation.conversationId!;
const message: TMessage = {
  messageId: 'reply-1',
  conversationId: id,
  parentMessageId: 'user-1',
  text: 'First branch',
  sender: 'Assistant',
  isCreatedByUser: false,
  metadata: { usage: { input: 100, output: 20, cacheRead: 400, cost: 0.01 } },
};
const messages: TMessage[] = [
  { ...message, messageId: 'user-1', isCreatedByUser: true, metadata: undefined },
  message,
  { ...message, messageId: 'reply-2', text: 'Second branch' },
];

type InfoProps = Omit<React.ComponentProps<typeof Info>, 'open' | 'onOpenChange' | 'triggerRef'>;

function InfoHarness(props: InfoProps) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={triggerRef} onClick={() => setOpen(true)} data-testid="info-test-trigger">
        {localize('com_ui_conversation_info')}
      </Button>
      <Info {...props} open={open} onOpenChange={setOpen} triggerRef={triggerRef} />
    </>
  );
}

function setup(props: Partial<InfoProps> = {}, cached = messages) {
  const store = createStore();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: Infinity } },
  });
  client.setQueryData([QueryKeys.messages, id], cached);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Provider store={store}>
          <InfoHarness conversation={conversation} showUsage showCost {...props} />
        </Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { store, client };
}

async function openInfo() {
  await userEvent.click(screen.getByTestId('info-test-trigger'));
  return screen.findByRole('dialog', { name: 'com_ui_conversation_info' });
}

beforeEach(() => jest.mocked(copy).mockReturnValue(true));

it('mounts cache observers only while open, shows metadata, and restores focus on Escape', async () => {
  const { client } = setup();
  const query = client.getQueryCache().find([QueryKeys.messages, id])!;
  expect(query.getObserversCount()).toBe(0);
  expect(screen.queryByTestId('conversation-info-details')).not.toBeInTheDocument();
  const dialog = await openInfo();
  expect(query.getObserversCount()).toBe(1);
  expect(client.isFetching()).toBe(0);
  for (const text of [
    id,
    'test-model',
    'openAI',
    'com_ui_created',
    'com_ui_conversation_updated',
  ]) {
    expect(within(dialog).getByText(text)).toBeVisible();
  }
  expect(
    within(dialog).getByText('com_ui_conversation_messages').nextElementSibling,
  ).toHaveTextContent('3');
  expect(within(dialog).getByText('com_endpoint_temperature').nextElementSibling).toHaveTextContent(
    '0',
  );
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(query.getObserversCount()).toBe(0));
  await waitFor(() => expect(screen.getByTestId('info-test-trigger')).toHaveFocus());
});

it('uses cached usage from every response when a read-only thread has no composer rollup', async () => {
  setup();
  await openInfo();
  const totals = within(screen.getByTestId('conversation-total-usage'));
  expect(totals.getByText('Input (uncached)').nextElementSibling).toHaveTextContent('200');
  expect(totals.getByText('Cache read').nextElementSibling).toHaveTextContent('800');
  expect(totals.getByTestId('usage-cost')).toHaveTextContent('$0.02');
});

it('uses the live authoritative rollup, adds pending once, and includes cached subagent work', async () => {
  const { store } = setup();
  store.set(totalUsageFamily(id), { ...EMPTY_USAGE, input: 300, cost: 0.1 });
  store.set(pendingUsageFamily(id), {
    ...EMPTY_USAGE_TOTALS,
    input: 7,
    output: 2,
    eventCount: 1,
    costUSD: 0.01,
  });
  store.set(subagentUsageFamily(id), { ...EMPTY_USAGE, cacheRead: 900, cacheWrite: 100 });
  await openInfo();
  const totals = within(screen.getByTestId('conversation-total-usage'));
  expect(totals.getByText('Input (uncached)').nextElementSibling).toHaveTextContent('307');
  expect(totals.getByTestId('usage-cost')).toHaveTextContent('$0.11');
  expect(totals.getByText('Subagents (all branches)').nextElementSibling).toHaveTextContent('1K');
  act(() => store.set(pendingUsageFamily(id), { ...EMPTY_USAGE_TOTALS, input: 9, eventCount: 2 }));
  expect(totals.getByText('Input (uncached)').nextElementSibling).toHaveTextContent('309');
});

it('never replaces an authoritative zero with stale cached usage', async () => {
  const { store } = setup();
  store.set(totalUsageFamily(id), { ...EMPTY_USAGE });
  await openInfo();
  expect(
    within(screen.getByTestId('conversation-total-usage')).getByText('Input (uncached)')
      .nextElementSibling,
  ).toHaveTextContent('0');
});

it.each([false, true])(
  'preserves the cost gate, currency, and missing cost coverage, showCost=%s',
  async (showCost) => {
    const { store } = setup({ showCost, currency: { code: 'EUR', rate: 2 } });
    await openInfo();
    if (showCost) {
      expect(screen.getByTestId('usage-cost')).toHaveTextContent('€0.04');
    } else {
      expect(screen.queryByTestId('usage-cost')).not.toBeInTheDocument();
    }
    act(() =>
      store.set(totalUsageFamily(id), { ...EMPTY_USAGE, input: 20, cost: 0.01, costKnown: false }),
    );
    expect(screen.queryByTestId('usage-cost')).not.toBeInTheDocument();
  },
);

it('keeps metadata accessible with token display disabled', async () => {
  setup({ showUsage: false });
  const dialog = await openInfo();
  expect(within(dialog).getByText(id)).toBeVisible();
  expect(screen.queryByTestId('conversation-total-usage')).not.toBeInTheDocument();
});

it('distinguishes absent usage from a recorded zero', async () => {
  const { client } = setup({}, [{ ...message, metadata: undefined }]);
  await openInfo();
  expect(screen.getByText('com_ui_conversation_usage_unavailable')).toBeVisible();
  expect(screen.queryByTestId('usage-cost')).not.toBeInTheDocument();
  act(() =>
    client.setQueryData(
      [QueryKeys.messages, id],
      [{ ...message, metadata: { usage: { input: 0, output: 0, cost: 0 } } }],
    ),
  );
  await waitFor(() => expect(screen.getByTestId('usage-cost')).toHaveTextContent('$0.00'));
});

it('copies only the conversation ID and reports clipboard failures', async () => {
  setup();
  await openInfo();
  jest.mocked(copy).mockReturnValueOnce(false);
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_conversation_copy_id' }));
  expect(screen.getByRole('status')).toHaveTextContent('com_ui_copy_failed');
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_conversation_copy_id' }));
  expect(copy).toHaveBeenLastCalledWith(id, expect.any(Object));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it.each([null, Constants.NEW_CONVO, Constants.PENDING_CONVO] as const)(
  'does not open a saved-conversation dialog for %s',
  async (conversationId) => {
    setup({ conversation: { ...conversation, conversationId } });
    await userEvent.click(screen.getByTestId('info-test-trigger'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  },
);
