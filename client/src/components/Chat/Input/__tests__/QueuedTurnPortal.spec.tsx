import React from 'react';
import { RecoilRoot } from 'recoil';
import { EModelEndpoint } from 'librechat-data-provider';
import { act, render, screen } from '@testing-library/react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { revealedQueuedTurnFamily } from '@librechat/chat/react';
import { MessagePartsHostProvider } from '@librechat/chat/react';
import {
  QueuedTurnPortalProvider,
  PendingTurn,
  useQueuedTurnPortal,
} from '@librechat/chat/components';
import type { MessagePartsHost } from '@librechat/chat/react';
import type { TConversation } from 'librechat-data-provider';
import { ChatContext } from '~/Providers';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({ user: { name: 'Danny' } }) }));
jest.mock('~/components/Chat/Messages/MessageIcon', () => ({
  __esModule: true,
  default: () => <span data-testid="message-icon" />,
}));
jest.mock('@librechat/chat/components', () => ({
  ...jest.requireActual('@librechat/chat/components'),
  Container: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const partsHost = {
  useUser: () => ({ name: 'Danny' }),
  useUserTextPreferences: () => ({
    enableUserMsgMarkdown: false,
    collapseLongUserMessages: false,
    usernameDisplay: false,
  }),
  renderMarkdown: ({ content }: { content: string }) => content,
} as unknown as MessagePartsHost;

const conversationId = 'convo-queued-turn';
const conversation = {
  conversationId,
  endpoint: EModelEndpoint.agents,
  model: 'gpt-x',
} as TConversation;

function PortalTarget() {
  const target = useQueuedTurnPortal()?.target;
  return <span data-testid="portal-target">{target?.clientRequestId ?? ''}</span>;
}

it('registers the revealed user turn action target only while it is visible', () => {
  const jotai = createStore();
  const reveal = {
    clientRequestId: 'queued-request',
    parentMessageId: 'response',
    text: 'queued follow-up',
    revealedAt: '2026-09-14T00:00:00.000Z',
  };
  jotai.set(revealedQueuedTurnFamily(conversationId), reveal);
  const view = (latestMessageId: string) => (
    <RecoilRoot>
      <JotaiProvider store={jotai}>
        <ChatContext.Provider
          value={
            { conversation, latestMessageId, index: 0 } as React.ContextType<typeof ChatContext>
          }
        >
          <MessagePartsHostProvider host={partsHost}>
            <QueuedTurnPortalProvider>
              <PendingTurn />
              <PortalTarget />
            </QueuedTurnPortalProvider>
          </MessagePartsHostProvider>
        </ChatContext.Provider>
      </JotaiProvider>
    </RecoilRoot>
  );
  const { rerender } = render(view('response'));
  expect(screen.getByTestId('pending-turn')).toHaveTextContent('queued follow-up');
  expect(screen.getByTestId('portal-target')).toHaveTextContent('queued-request');

  rerender(view('different-branch'));
  expect(screen.queryByTestId('pending-turn')).toBeNull();
  expect(screen.getByTestId('portal-target')).toBeEmptyDOMElement();

  act(() => jotai.set(revealedQueuedTurnFamily(conversationId), null));
  expect(screen.getByTestId('portal-target')).toBeEmptyDOMElement();
});
