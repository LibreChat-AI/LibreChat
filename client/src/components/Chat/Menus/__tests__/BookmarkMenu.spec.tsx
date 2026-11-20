import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import { RetentionMode } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversation } from 'librechat-data-provider';
import { ChatSettingsContext, defaultChatSettings } from '~/Providers/ChatSettingsContext';
import BookmarkMenu from '../BookmarkMenu';
import store from '~/store';

jest.mock('~/data-provider', () => ({
  useConversationTagsQuery: () => ({ data: [] }),
  useTagConversationMutation: () => ({ mutate: jest.fn(), isLoading: false }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useBookmarkSuccess: () => jest.fn(),
}));

jest.mock('@librechat/client', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    DropdownPopup: ({ trigger }: { trigger: React.ReactNode }) =>
      ReactActual.createElement('div', null, trigger),
    TooltipAnchor: ({ render }: { render: React.ReactNode }) => render,
    Spinner: () => null,
    useToastContext: () => ({ showToast: jest.fn() }),
  };
});

jest.mock('@ariakit/react', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    MenuButton: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
      ReactActual.createElement('button', props, props.children),
  };
});

jest.mock('~/components/Bookmarks', () => ({
  BookmarkEditDialog: () => null,
}));

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function renderMenu({
  conversation,
  retentionMode,
}: {
  conversation: Partial<TConversation>;
  retentionMode?: RetentionMode;
}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot
        initializeState={({ set }) => {
          set(store.conversationByIndex(0), conversation as TConversation);
        }}
      >
        <ChatSettingsContext.Provider
          value={{
            ...defaultChatSettings,
            config: { ...defaultChatSettings.config, retentionMode },
          }}
        >
          <BookmarkMenu />
        </ChatSettingsContext.Provider>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

describe('BookmarkMenu', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows bookmark controls for a permanent conversation', () => {
    renderMenu({
      conversation: { conversationId: 'convo-1', isTemporary: false },
      retentionMode: RetentionMode.TEMPORARY,
    });

    expect(screen.getByTestId('bookmark-menu')).toBeInTheDocument();
  });

  it('hides bookmark controls for a temporary conversation', () => {
    renderMenu({
      conversation: { conversationId: 'convo-1', isTemporary: true },
      retentionMode: RetentionMode.TEMPORARY,
    });

    expect(screen.queryByTestId('bookmark-menu')).not.toBeInTheDocument();
  });

  it('hides bookmark controls when ephemeral retention is forced on a permanent conversation', () => {
    renderMenu({
      conversation: { conversationId: 'convo-1', isTemporary: false },
      retentionMode: RetentionMode.EPHEMERAL,
    });

    expect(screen.queryByTestId('bookmark-menu')).not.toBeInTheDocument();
  });
});
