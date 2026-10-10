import React from 'react';
import { RecoilRoot } from 'recoil';
import { EModelEndpoint } from 'librechat-data-provider';
import { act, render, screen } from '@testing-library/react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import type { TConversation } from 'librechat-data-provider';
import {
  QueuedTurnPortalProvider,
  useQueuedTurnPortal,
} from '~/components/Chat/Steering/QueuedTurnPortal';
import PendingTurn from '~/components/Chat/Messages/PendingTurn';
import { revealedQueuedTurnFamily } from '~/store/steer';
import { ChatContext } from '~/Providers';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({ user: { name: 'Danny' } }) }));
jest.mock('~/components/Chat/Messages/MessageIcon', () => ({
  __esModule: true,
  default: () => <span data-testid="message-icon" />,
}));
jest.mock('~/components/Chat/Messages/Content/Container', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

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
          <QueuedTurnPortalProvider>
            <PendingTurn />
            <PortalTarget />
          </QueuedTurnPortalProvider>
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
