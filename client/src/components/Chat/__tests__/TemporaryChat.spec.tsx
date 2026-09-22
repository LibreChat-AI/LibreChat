import React from 'react';
import { RecoilRoot } from 'recoil';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { TConversation } from 'librechat-data-provider';
import { TemporaryChat, TemporaryChatIndicator } from '../TemporaryChat';
import store from '~/store';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  TooltipAnchor: ({ render: renderProp }: { render: React.ReactNode }) => <>{renderProp}</>,
}));

jest.mock('~/hooks/useKeyboardShortcuts', () => ({
  useShortcutHint: (_id: string, label: string) => label,
  useShortcutAriaKey: () => undefined,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => (key === 'com_ui_temporary' ? 'Temporary Chat' : key),
}));

let mockRetentionMode: string | undefined;

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { interface: { retentionMode: mockRetentionMode } } }),
}));

beforeEach(() => {
  mockRetentionMode = undefined;
});

function renderChat(
  ui: React.ReactElement,
  { isTemporary, conversation }: { isTemporary: boolean; conversation?: Partial<TConversation> },
) {
  return render(
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.isTemporary, isTemporary);
        if (conversation) {
          set(store.conversationByIndex(0), conversation as TConversation);
        }
      }}
    >
      {ui}
    </RecoilRoot>,
  );
}

describe('TemporaryChat', () => {
  it('offers the toggle on a chat that has not started', () => {
    renderChat(<TemporaryChat />, { isTemporary: false });

    const toggle = screen.getByRole('button', { name: 'Temporary Chat' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('marks the toggle pressed while temporary mode is on', () => {
    renderChat(<TemporaryChat />, { isTemporary: true });

    expect(screen.getByRole('button', { name: 'Temporary Chat' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('locks the toggle on when the administrator enforces temporary chats', () => {
    mockRetentionMode = 'ephemeral';
    renderChat(<TemporaryChat />, { isTemporary: false });

    const toggle = screen.getByRole('button', { name: 'com_ui_temporary_enforced' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    expect(toggle).not.toHaveAttribute('aria-keyshortcuts');
  });

  it('keeps the toggle on after a click under enforced temporary chats', async () => {
    mockRetentionMode = 'ephemeral';
    renderChat(<TemporaryChat />, { isTemporary: false });

    const toggle = screen.getByRole('button', { name: 'com_ui_temporary_enforced' });
    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('retires the toggle once the conversation has started', () => {
    renderChat(<TemporaryChat />, {
      isTemporary: true,
      conversation: { conversationId: 'convo-1' },
    });

    expect(screen.queryByRole('button', { name: 'Temporary Chat' })).not.toBeInTheDocument();
  });
});

describe('TemporaryChatIndicator', () => {
  it('stays hidden while the toggle is still offered', () => {
    renderChat(<TemporaryChatIndicator />, { isTemporary: true });

    expect(screen.queryByText('Temporary Chat')).not.toBeInTheDocument();
  });

  it('labels a started temporary conversation', () => {
    renderChat(<TemporaryChatIndicator />, {
      isTemporary: true,
      conversation: { conversationId: 'convo-1' },
    });

    expect(screen.getByText('Temporary Chat')).toBeInTheDocument();
  });

  it('exposes the cue as a status so the mode change reaches assistive tech', () => {
    renderChat(<TemporaryChatIndicator />, {
      isTemporary: true,
      conversation: { conversationId: 'convo-1' },
    });

    expect(screen.getByRole('status')).toHaveTextContent('Temporary Chat');
  });

  it('keeps the label in the accessible name when it is visually hidden', () => {
    renderChat(<TemporaryChatIndicator />, {
      isTemporary: true,
      conversation: { conversationId: 'convo-1' },
    });

    expect(screen.getByText('Temporary Chat')).toHaveClass('max-md:sr-only');
  });

  it('stays hidden on a started conversation that is not temporary', () => {
    renderChat(<TemporaryChatIndicator />, {
      isTemporary: false,
      conversation: { conversationId: 'convo-1' },
    });

    expect(screen.queryByText('Temporary Chat')).not.toBeInTheDocument();
  });
});
