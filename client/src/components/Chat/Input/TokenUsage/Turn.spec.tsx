import axios from 'axios';
import { RecoilRoot } from 'recoil';
import userEvent from '@testing-library/user-event';
import { interfaceSchema } from 'librechat-data-provider';
import { clearIndex, upsertEntries } from '@librechat/chat';
import { Provider, createStore, getDefaultStore } from 'jotai';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { removeUsageAtoms, useUsageHandler } from '@librechat/chat/react';
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { TMessage, TInterfaceConfig } from 'librechat-data-provider';
import type { MessageUsageProps } from '@librechat/chat/react';
import { startupConfigKey } from '~/data-provider';
import store from '~/store';
import Turn from './Turn';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

let client: QueryClient;
const setConfig = (interfaceConfig: Partial<TInterfaceConfig>) =>
  client.setQueryData(startupConfigKey(false), {
    interface: interfaceSchema.parse(interfaceConfig),
  });

const usage = { input: 120, output: 35, cacheRead: 400, cacheWrite: 20, cost: 0.02 };
const message = {
  messageId: 'response-1',
  conversationId: 'turn-card',
  parentMessageId: 'user-1',
  isCreatedByUser: false,
  text: 'A response',
  metadata: { usage },
} as TMessage;

const renderTurn = (props: Partial<MessageUsageProps> = {}, jotaiStore = createStore()) =>
  render(<Turn message={message} {...props} />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        <RecoilRoot initializeState={({ set }) => set(store.queriesEnabled, true)}>
          <Provider store={jotaiStore}>{children}</Provider>
        </RecoilRoot>
      </QueryClientProvider>
    ),
  });

const openCard = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_context_turn_usage' }));
  return screen.findByTestId('message-turn-usage');
};

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: Infinity } } });
  setConfig({ contextUsage: true, contextCost: true });
  clearIndex('turn-card');
  removeUsageAtoms('turn-card');
});

afterEach(() => {
  cleanup();
  client.clear();
});

describe('Message turn usage', () => {
  it('opens the response accounting on hover and keeps it available while the pointer enters', async () => {
    renderTurn();
    const user = userEvent.setup();
    await user.hover(screen.getByTestId('message-usage-button'));
    const card = await screen.findByTestId('message-turn-usage');
    await user.hover(card);
    for (const value of ['120', '35', '400', '20']) {
      expect(within(card).getByText(value)).toBeVisible();
    }
    expect(within(card).getByTestId('usage-cost')).toHaveTextContent('$0.02');
    await user.unhover(card);
    await waitFor(() => expect(screen.queryByTestId('message-turn-usage')).not.toBeInTheDocument());
  });

  it('opens from the keyboard and restores focus on Escape', async () => {
    renderTurn({ isLast: true });
    const user = userEvent.setup();
    // JSDOM has no layout; Ariakit checks visibility before restoring focus.
    jest
      .spyOn(screen.getByTestId('message-usage-button'), 'offsetHeight', 'get')
      .mockReturnValue(32);
    await user.tab();
    expect(screen.getByTestId('message-usage-button')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toHaveAccessibleName('com_ui_context_turn_usage');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('message-usage-button')).toHaveFocus());
  });

  it('hides the control for imported or legacy turns instead of borrowing conversation totals', () => {
    upsertEntries('turn-card', [message]);
    renderTurn({ message: { ...message, messageId: 'older-response', metadata: undefined } });
    expect(screen.queryByTestId('message-usage-button')).not.toBeInTheDocument();
  });

  it('only shows pending usage on its owning response and settles to the authoritative FINAL', async () => {
    const store = getDefaultStore();
    const { result } = renderHook(() => useUsageHandler(), {
      wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
    });
    const liveMessage = { ...message, metadata: undefined };
    const submission = {
      conversation: { conversationId: 'turn-card' },
      userMessage: { messageId: 'user-1', conversationId: 'turn-card' },
      initialResponse: liveMessage,
    };
    act(() => result.current.bindResponse(submission));
    const { rerender } = renderTurn({ message: liveMessage }, store);
    expect(screen.queryByTestId('message-usage-button')).not.toBeInTheDocument();
    act(() =>
      result.current.usageHandler({ input_tokens: 15, output_tokens: 3, cost: 0.01 }, submission),
    );
    const card = await openCard();
    expect(card).toHaveTextContent('com_ui_context_current_turn');
    expect(within(card).getByText('15')).toBeVisible();
    rerender(<Turn message={{ ...message, messageId: 'older-response' }} />);
    expect(within(card).getByText('120')).toBeVisible();
    expect(card).not.toHaveTextContent('com_ui_context_current_turn');
    rerender(<Turn message={liveMessage} />);
    act(() => result.current.finalizeUsage({ responseMessage: message }, submission));
    expect(card).toHaveTextContent('com_ui_context_turn_usage');
    expect(within(card).getByText('120')).toBeVisible();
    expect(within(card).getByText('400')).toBeVisible();
    expect(within(card).queryByText('15')).not.toBeInTheDocument();
  });

  it('renders stopped usage even before it is persisted', async () => {
    const store = getDefaultStore();
    const { result } = renderHook(() => useUsageHandler(), {
      wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
    });
    const submission = {
      conversation: { conversationId: 'turn-card' },
      initialResponse: { ...message, metadata: undefined },
    };
    act(() => {
      result.current.bindResponse(submission);
      result.current.usageHandler({ input_tokens: 15, output_tokens: 3 }, submission);
      result.current.attributePending(message.messageId, submission);
    });
    renderTurn({ message: { ...message, metadata: undefined } }, store);
    const card = await openCard();
    expect(within(card).getByText('15')).toBeVisible();
    expect(card).not.toHaveTextContent('com_ui_context_current_turn');
    expect(within(card).queryByTestId('usage-cost')).not.toBeInTheDocument();
  });

  it('uses refreshed message metadata even if the context index has not caught up', async () => {
    upsertEntries('turn-card', [message]);
    renderTurn({ message: { ...message, metadata: { usage: { ...usage, input: 250 } } } });
    expect(within(await openCard()).getByText('250')).toBeVisible();
  });

  it('keeps a recorded zero-token turn available', async () => {
    renderTurn({ message: { ...message, metadata: { usage: { input: 0, output: 0, cost: 0 } } } });
    const card = await openCard();
    expect(within(card).getByTestId('usage-cost')).toHaveTextContent('$0.00');
  });

  it('hides stale persisted usage while its next run has no usage events', () => {
    const store = getDefaultStore();
    const { result } = renderHook(() => useUsageHandler(), {
      wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
    });
    act(() =>
      result.current.bindResponse({
        conversation: { conversationId: 'turn-card' },
        initialResponse: message,
      }),
    );
    renderTurn({}, store);
    expect(screen.queryByTestId('message-usage-button')).not.toBeInTheDocument();
  });

  it('removes the control when metadata is removed without a local usage record', () => {
    const { rerender } = renderTurn();
    expect(screen.getByTestId('message-usage-button')).toBeInTheDocument();
    rerender(<Turn message={{ ...message, metadata: undefined }} />);
    expect(screen.queryByTestId('message-usage-button')).not.toBeInTheDocument();
  });

  it.each([false, true])(
    'honors the cost gate and configured currency, showCost=%s',
    async (showCost) => {
      setConfig({ contextCost: showCost, currency: { code: 'EUR', rate: 2 } });
      renderTurn();
      const card = await openCard();
      if (showCost) {
        expect(within(card).getByTestId('usage-cost')).toHaveTextContent('€0.04');
      } else {
        expect(within(card).queryByTestId('usage-cost')).not.toBeInTheDocument();
      }
    },
  );

  it.each([undefined, Number.NaN, 0])(
    'distinguishes missing cost from known zero, cost=%s',
    async (cost) => {
      renderTurn({ message: { ...message, metadata: { usage: { ...usage, cost } } } });
      const card = await openCard();
      if (cost === 0) {
        expect(within(card).getByTestId('usage-cost')).toHaveTextContent('$0.00');
      } else {
        expect(within(card).queryByTestId('usage-cost')).not.toBeInTheDocument();
      }
    },
  );

  it('mounts no control while the real config request is pending', async () => {
    client.removeQueries(startupConfigKey(false));
    const request = jest.spyOn(axios, 'get').mockImplementation(() => new Promise(() => {}));
    renderTurn();
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(screen.queryByTestId('message-usage-button')).not.toBeInTheDocument();
  });

  it('mounts no control when context usage is disabled', () => {
    setConfig({ contextUsage: false });
    renderTurn();
    expect(screen.queryByTestId('message-usage-button')).not.toBeInTheDocument();
  });

  it('mounts no control for a user message', () => {
    renderTurn({ message: { ...message, isCreatedByUser: true } });
    expect(screen.queryByTestId('message-usage-button')).not.toBeInTheDocument();
  });
});
