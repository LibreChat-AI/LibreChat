import React from 'react';
import { RecoilRoot } from 'recoil';
import { Constants } from 'librechat-data-provider';
import { render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import { ArtifactsProvider, useArtifactsContext } from '~/Providers/ArtifactsContext';

const mockUseLatestMessage = jest.fn();

jest.mock('~/hooks/Messages/useLatestMessage', () => ({
  useLatestMessage: () => mockUseLatestMessage(),
}));

function TestConsumer() {
  const { latestMessageError } = useArtifactsContext();
  return <span data-testid="latest-message-error">{String(latestMessageError)}</span>;
}

function renderWithMessage(message: Partial<TMessage> | null) {
  mockUseLatestMessage.mockReturnValue(message);
  return render(
    <RecoilRoot>
      <ArtifactsProvider value={{ canUndock: false }}>
        <TestConsumer />
      </ArtifactsProvider>
    </RecoilRoot>,
  );
}

describe('ArtifactsProvider latestMessageError', () => {
  it('is false for a normally completed message', () => {
    renderWithMessage({ messageId: 'message-1', error: false, unfinished: false });
    expect(screen.getByTestId('latest-message-error')).toHaveTextContent('false');
  });

  it('is true for an errored message', () => {
    renderWithMessage({ messageId: 'message-1', error: true, unfinished: false });
    expect(screen.getByTestId('latest-message-error')).toHaveTextContent('true');
  });

  it('is true for an aborted message (unfinished with no finish_reason)', () => {
    renderWithMessage({ messageId: 'message-1', error: false, unfinished: true });
    expect(screen.getByTestId('latest-message-error')).toHaveTextContent('true');
  });

  it('is false for a tool-call-limit pause even though the message is unfinished', () => {
    renderWithMessage({
      messageId: 'message-1',
      error: false,
      unfinished: true,
      finish_reason: String(Constants.TOOL_CALL_LIMIT_FINISH_REASON),
    });
    expect(screen.getByTestId('latest-message-error')).toHaveTextContent('false');
  });
});
