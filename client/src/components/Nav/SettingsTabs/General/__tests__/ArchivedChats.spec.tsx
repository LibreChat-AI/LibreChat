import React from 'react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@librechat/client';
import { render, screen } from '@testing-library/react';
import { ArchivedChatsModal } from '../ArchivedChatsModal';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => ({
    'agent-1': { name: 'Archive agent', avatar: { filepath: '/images/agent.png' } },
  }),
  useAssistantsMapContext: () => ({}),
}));

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: {} }),
  useConversationsInfiniteQuery: () => ({
    data: {
      pages: [
        {
          conversations: [
            {
              conversationId: 'archived-1',
              title: '<think> Hmm, the user is asking for a very complicated conversation title',
              endpoint: 'agents',
              agent_id: 'agent-1',
              createdAt: '2025-08-01T00:00:00Z',
            },
          ],
        },
      ],
    },
    refetch: jest.fn(),
  }),
  useDeleteConversationMutation: () => ({ mutate: jest.fn() }),
  useArchiveConvoMutation: () => ({ mutate: jest.fn() }),
}));

jest.mock('~/store', () => {
  const { atom } = jest.requireActual('recoil');
  return {
    __esModule: true,
    default: {
      search: atom({ key: 'archived-chats-test-search', default: { enabled: false } }),
    },
  };
});

function renderArchive() {
  return render(
    <RecoilRoot>
      <MemoryRouter>
        <ToastProvider>
          <ArchivedChatsModal open onOpenChange={jest.fn()} />
        </ToastProvider>
      </MemoryRouter>
    </RecoilRoot>,
  );
}

describe('archived chats presentation', () => {
  it('uses the agent avatar from the conversation list', () => {
    renderArchive();
    expect(screen.queryByRole('img', { name: 'Archive agent' })).toHaveAttribute(
      'src',
      '/images/agent.png',
    );
  });

  it('reserves a nonshrinking icon slot beside long titles', () => {
    renderArchive();
    const link = screen.getByRole('link');
    expect(link.parentElement?.firstElementChild).toHaveClass('size-5', 'shrink-0');
  });

  it('lets the title shrink without compressing the icon', () => {
    renderArchive();
    expect(screen.getByRole('link')).toHaveClass('min-w-0');
  });

  it('provides a larger desktop dialog', () => {
    renderArchive();
    expect(screen.getByRole('dialog')).toHaveClass('max-w-5xl');
  });
});
