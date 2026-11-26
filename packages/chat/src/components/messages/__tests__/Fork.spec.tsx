/**
 * @jest-environment jsdom
 */
import { useState, useSyncExternalStore } from 'react';
import { ForkOptions } from 'librechat-data-provider';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ForkConversation, ForkPreferences } from '../../../react/messages/host';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { MessagesHostProvider } from '../../../react/messages/host';
import Fork from '../Fork';

const mockShowToast = jest.fn();

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
  useToastContext: () => ({ showToast: mockShowToast }),
}));

type Defaults = Pick<ForkPreferences, 'option' | 'splitAtTarget' | 'rememberOption'>;

function ForkHost({
  defaults,
  forkConversation,
  children,
}: {
  defaults?: Partial<Defaults>;
  forkConversation: ForkConversation | null;
  children: ReactNode;
}) {
  const [option, setOption] = useState(defaults?.option ?? '');
  const [splitAtTarget, setSplitAtTarget] = useState(defaults?.splitAtTarget ?? false);
  const [rememberOption, setRememberOption] = useState(defaults?.rememberOption ?? false);
  const preferences: ForkPreferences = {
    option,
    setOption,
    splitAtTarget,
    setSplitAtTarget,
    rememberOption,
    setRememberOption,
  };
  const [host] = useState(() => ({ current: preferences }));
  host.current = preferences;
  const [messagesHost] = useState(() =>
    createMessagesHost({
      useForkPreferences: () => host.current,
      useForkConversation: () => forkConversation,
    }),
  );
  return <MessagesHostProvider host={messagesHost}>{children}</MessagesHostProvider>;
}

describe('Fork', () => {
  const forkConversation = jest.fn<ReturnType<ForkConversation>, Parameters<ForkConversation>>();

  beforeEach(() => {
    forkConversation.mockReset();
    mockShowToast.mockReset();
  });

  /** The row holding this button does not re-render when the tail moves, so the
   *  split target is read when the fork starts rather than captured at render. */
  it('sends the tail current at click time as the split target', () => {
    let latestMessageId = 'assistant-2';
    render(
      <ForkHost
        forkConversation={forkConversation}
        defaults={{ rememberOption: true, option: ForkOptions.TARGET_LEVEL, splitAtTarget: true }}
      >
        <Fork
          messageId="user-1"
          conversationId="convo-1"
          forkingSupported={true}
          getLatestMessageId={() => latestMessageId}
        />
      </ForkHost>,
    );

    latestMessageId = 'assistant-3';
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_fork_open_menu' }));

    expect(forkConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'user-1',
        splitAtTarget: true,
        latestMessageId: 'assistant-3',
      }),
      expect.anything(),
    );
  });

  it('copies without files only when that box is checked for this fork', async () => {
    render(
      <ForkHost forkConversation={forkConversation}>
        <Fork messageId="assistant-1" conversationId="convo-1" forkingSupported={true} />
      </ForkHost>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_fork_open_menu' }));
    fireEvent.click(await screen.findByRole('button', { name: 'com_ui_fork_more_options' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'com_ui_fork_exclude_files' }));
    fireEvent.click(screen.getByRole('radio', { name: 'com_ui_fork_mode_visible' }));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_fork' }));

    expect(forkConversation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageId: 'assistant-1',
        option: ForkOptions.DIRECT_PATH,
        excludeFiles: true,
      }),
      expect.anything(),
    );
  });

  it('shows and sends the "From here on" scope when it is the stored preference', async () => {
    render(
      <ForkHost forkConversation={forkConversation} defaults={{ splitAtTarget: true }}>
        <Fork
          messageId="assistant-1"
          conversationId="convo-1"
          forkingSupported={true}
          getLatestMessageId={() => 'assistant-9'}
        />
      </ForkHost>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_fork_open_menu' }));
    const after = await screen.findByRole('radio', { name: 'com_ui_fork_scope_after' });
    expect(after).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_fork' }));

    expect(forkConversation).toHaveBeenLastCalledWith(
      expect.objectContaining({ splitAtTarget: true, latestMessageId: 'assistant-9' }),
      expect.anything(),
    );
  });

  it('keeps the advanced options collapsed until asked for', async () => {
    render(
      <ForkHost forkConversation={forkConversation}>
        <Fork messageId="assistant-1" conversationId="convo-1" forkingSupported={true} />
      </ForkHost>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_fork_open_menu' }));
    const toggle = await screen.findByRole('button', { name: 'com_ui_fork_more_options' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('checkbox', { name: 'com_ui_fork_exclude_files' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens the extra options on a collapsing region, turning the chevron with it', async () => {
    render(
      <ForkHost forkConversation={forkConversation}>
        <Fork messageId="assistant-1" conversationId="convo-1" forkingSupported={true} />
      </ForkHost>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_fork_open_menu' }));
    const toggle = await screen.findByRole('button', { name: 'com_ui_fork_more_options' });
    const chevron = toggle.querySelector('svg');
    const region = document.getElementById(toggle.getAttribute('aria-controls') ?? '');

    expect(region).toHaveAttribute('aria-hidden', 'true');
    expect(region).toHaveAttribute('inert');
    expect(region).toHaveClass('grid-rows-[0fr]');
    expect(chevron).not.toHaveClass('rotate-180');

    fireEvent.click(toggle);
    expect(region).not.toHaveAttribute('aria-hidden');
    expect(region).not.toHaveAttribute('inert');
    expect(region).toHaveClass('grid-rows-[1fr]');
    expect(chevron).toHaveClass('rotate-180');
  });

  /** The default mode lives in a store the Settings dialog also writes, so it can change while the
   *  message toolbar stays mounted. */
  it('follows the stored default mode when it changes while the toolbar stays mounted', async () => {
    let stored: string = ForkOptions.INCLUDE_BRANCHES;
    const listeners = new Set<() => void>();
    const setStored = (next: string) => {
      stored = next;
      listeners.forEach((listener) => listener());
    };
    const preferences = {
      setOption: setStored,
      splitAtTarget: false,
      setSplitAtTarget: () => {},
      rememberOption: false,
      setRememberOption: () => {},
    };
    const host = createMessagesHost({
      useForkPreferences: () => ({
        ...preferences,
        option: useSyncExternalStore(
          (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          () => stored,
        ),
      }),
      useForkConversation: () => forkConversation,
    });
    render(
      <MessagesHostProvider host={host}>
        <Fork messageId="assistant-1" conversationId="convo-1" forkingSupported={true} />
      </MessagesHostProvider>,
    );

    act(() => setStored(ForkOptions.DIRECT_PATH));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_fork_open_menu' }));
    fireEvent.click(await screen.findByRole('button', { name: 'com_ui_fork_more_options' }));
    expect(screen.getByRole('radio', { name: 'com_ui_fork_mode_visible' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_fork' }));

    expect(forkConversation).toHaveBeenLastCalledWith(
      expect.objectContaining({ option: ForkOptions.DIRECT_PATH }),
      expect.anything(),
    );
  });

  it('keeps files by default', async () => {
    render(
      <ForkHost forkConversation={forkConversation}>
        <Fork messageId="assistant-1" conversationId="convo-1" forkingSupported={true} />
      </ForkHost>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_fork_open_menu' }));
    fireEvent.click(await screen.findByRole('button', { name: 'com_ui_fork' }));

    const calls = forkConversation.mock.calls;
    expect(calls[calls.length - 1]?.[0]).not.toHaveProperty('excludeFiles');
  });

  it('reports progress, success and a rate-limited failure through toasts', async () => {
    render(
      <ForkHost forkConversation={forkConversation}>
        <Fork messageId="assistant-1" conversationId="convo-1" forkingSupported={true} />
      </ForkHost>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_fork_open_menu' }));
    fireEvent.click(await screen.findByRole('button', { name: 'com_ui_fork' }));
    expect(mockShowToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'com_ui_fork_processing' }),
    );

    const [, events] = forkConversation.mock.calls[0];
    events.onSuccess();
    expect(mockShowToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'com_ui_fork_success', status: 'success' }),
    );
    events.onError({ response: { status: 429 } });
    expect(mockShowToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'com_ui_fork_error_rate_limit', status: 'error' }),
    );
    events.onError(new Error('boom'));
    expect(mockShowToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'com_ui_fork_error', status: 'error' }),
    );
  });

  it('renders nothing where the host cannot fork', () => {
    const { container } = render(
      <ForkHost forkConversation={null}>
        <Fork messageId="assistant-1" conversationId="convo-1" forkingSupported={true} />
      </ForkHost>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
