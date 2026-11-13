import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import type { ChatContract } from '~/hooks/Chat/contract';
import { ChatContext, useChatContext } from '~/Providers/ChatContext';

function TestConsumer() {
  const ctx = useChatContext();
  return <span data-testid="index">{ctx.index}</span>;
}

describe('ChatContext', () => {
  it('throws when useChatContext is called outside a provider', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<TestConsumer />)).toThrow(
      'useChatContext must be used within a ChatContext.Provider',
    );
    spy.mockRestore();
  });

  it('provides context value when wrapped in provider', () => {
    const mockHelpers = { index: 0 } as ChatContract;
    render(
      <ChatContext.Provider value={mockHelpers}>
        <TestConsumer />
      </ChatContext.Provider>,
    );
    expect(screen.getByTestId('index')).toHaveTextContent('0');
  });
});
