/**
 * @jest-environment jsdom
 */
import { useState } from 'react';
import { ForkOptions } from 'librechat-data-provider';
import { fireEvent, render, screen } from '@testing-library/react';
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
    fireEvent.click(await screen.findByRole('checkbox', { name: 'com_ui_fork_exclude_files' }));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_fork_visible' }));

    expect(forkConversation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageId: 'assistant-1',
        option: ForkOptions.DIRECT_PATH,
        excludeFiles: true,
      }),
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
    fireEvent.click(await screen.findByRole('button', { name: 'com_ui_fork_visible' }));

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
    fireEvent.click(await screen.findByRole('button', { name: 'com_ui_fork_visible' }));
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
