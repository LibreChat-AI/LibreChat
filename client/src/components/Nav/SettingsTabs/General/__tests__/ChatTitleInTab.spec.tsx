import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryKeys, LocalStorageKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversation } from 'librechat-data-provider';
import { CHAT_TITLE_IN_TAB_KEY } from '~/utils';
import ChatTitleInTab from '../ChatTitleInTab';
import store from '~/store';

const createConversation = (conversationId: string, title: string): TConversation =>
  ({ conversationId, title }) as TConversation;

const getToggle = () => screen.getByRole('switch', { name: 'Display chat title in tab' });

function renderToggle({
  route,
  recoilConversation,
  cachedConversation,
}: {
  route: string;
  recoilConversation?: TConversation;
  cachedConversation?: TConversation;
}) {
  const queryClient = new QueryClient();
  if (cachedConversation) {
    queryClient.setQueryData(
      [QueryKeys.conversation, cachedConversation.conversationId],
      cachedConversation,
    );
  }

  return render(
    <MemoryRouter initialEntries={[route]}>
      <QueryClientProvider client={queryClient}>
        <RecoilRoot
          initializeState={({ set }) => {
            if (recoilConversation) {
              set(store.conversationByIndex(0), recoilConversation);
            }
          }}
        >
          <ChatTitleInTab />
        </RecoilRoot>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('ChatTitleInTab', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(LocalStorageKeys.APP_TITLE, 'LibreChat');
    localStorage.setItem(CHAT_TITLE_IN_TAB_KEY, JSON.stringify(false));
    document.title = '';
  });

  it('restores the active conversation title from the query cache', () => {
    renderToggle({
      route: '/c/conversation-1',
      recoilConversation: createConversation('conversation-1', 'New Chat'),
      cachedConversation: createConversation('conversation-1', 'Generated title'),
    });

    const toggle = getToggle();
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    expect(toggle).toBeChecked();
    expect(localStorage.getItem(CHAT_TITLE_IN_TAB_KEY)).toBe('true');
    expect(document.title).toBe('Generated title');
  });

  it('falls back to the matching Recoil conversation when the query cache is empty', () => {
    renderToggle({
      route: '/c/conversation-1',
      recoilConversation: createConversation('conversation-1', 'Cached sidebar title'),
    });

    const toggle = getToggle();
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    expect(toggle).toBeChecked();
    expect(localStorage.getItem(CHAT_TITLE_IN_TAB_KEY)).toBe('true');
    expect(document.title).toBe('Cached sidebar title');
  });

  it('shows an existing conversation deliberately titled New Chat', () => {
    renderToggle({
      route: '/c/conversation-1',
      recoilConversation: createConversation('conversation-1', 'New Chat'),
    });

    const toggle = getToggle();
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    expect(toggle).toBeChecked();
    expect(localStorage.getItem(CHAT_TITLE_IN_TAB_KEY)).toBe('true');
    expect(document.title).toBe('New Chat');
  });

  it('keeps the app title when enabling titles for a new chat', () => {
    localStorage.setItem(LocalStorageKeys.APP_TITLE, 'Custom LibreChat');
    document.title = 'Custom LibreChat';
    renderToggle({
      route: '/c/new',
      recoilConversation: createConversation('new', 'New Chat'),
    });

    const toggle = getToggle();
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    expect(toggle).toBeChecked();
    expect(localStorage.getItem(CHAT_TITLE_IN_TAB_KEY)).toBe('true');
    expect(document.title).toBe('Custom LibreChat');
  });

  it('preserves page-specific titles outside chat routes', () => {
    localStorage.setItem(CHAT_TITLE_IN_TAB_KEY, JSON.stringify(true));
    document.title = 'Agent Marketplace | LibreChat';
    renderToggle({
      route: '/agents',
      recoilConversation: createConversation('conversation-1', 'Previous chat'),
    });

    const toggle = getToggle();
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    expect(toggle).not.toBeChecked();
    expect(localStorage.getItem(CHAT_TITLE_IN_TAB_KEY)).toBe('false');
    expect(document.title).toBe('Agent Marketplace | LibreChat');
  });
});
