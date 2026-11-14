import React from 'react';
import { render, screen } from '@testing-library/react';
import { AskUserQuestionProgress } from '@librechat/chat/components';
import { ChatContext } from '~/Providers/ChatContext';
import AskHost from '../AskHost';

let mockPauses = { ids: [] as string[], hasUnattributed: false };

jest.mock('~/data-provider', () => ({
  useCachedMessages: () => ({ data: mockPauses }),
}));

function renderProgress(toolCallId: string) {
  return render(
    <ChatContext.Provider value={{ conversation: { conversationId: 'conversation-1' } } as never}>
      <AskHost saveDrafts={false}>
        <AskUserQuestionProgress args='{"question":"Which environment?"}' toolCallId={toolCallId} />
      </AskHost>
    </ChatContext.Provider>,
  );
}

describe('AskHost live pauses', () => {
  beforeEach(() => {
    mockPauses = { ids: [], hasUnattributed: false };
  });

  test('shows the in-progress question the conversation has not opened yet', () => {
    renderProgress('call-1');
    expect(screen.getByText('Which environment?')).toBeInTheDocument();
  });

  test('hides the card once this call is the live pause', () => {
    mockPauses = { ids: ['call-1'], hasUnattributed: false };
    const { container } = renderProgress('call-1');
    expect(container).toBeEmptyDOMElement();
  });
});
