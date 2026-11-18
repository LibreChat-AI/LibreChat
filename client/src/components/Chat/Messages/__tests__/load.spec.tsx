import React, { Suspense } from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import type { ChatScreenMessagesSlots } from '@librechat/chat/components';

const mockLoadScreenMessages = jest.fn();

jest.mock('@librechat/chat/components', () => ({
  loadScreenMessages: () => mockLoadScreenMessages(),
}));
jest.mock('../hosts', () => ({}));

type ListProps = { messages: unknown; slots?: ChatScreenMessagesSlots };

function PackageList({ messages, slots }: ListProps) {
  return (
    <p>
      {String(messages)} {slots == null ? 'package defaults' : 'app slots'}
    </p>
  );
}

function loadModule(): typeof import('../load') {
  let module: typeof import('../load') | undefined;
  jest.isolateModules(() => {
    module = jest.requireActual<typeof import('../load')>('../load');
  });
  return module as typeof import('../load');
}

describe('message list loader', () => {
  beforeEach(() => {
    mockLoadScreenMessages.mockReset();
  });

  it('draws the package list once its hosts have loaded', async () => {
    mockLoadScreenMessages.mockResolvedValue({ default: PackageList });
    const { renderMessages } = loadModule();

    render(
      <Suspense fallback={<p role="status" />}>
        {renderMessages({ messagesTree: null, messages: null })}
      </Suspense>,
    );

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(await screen.findByText('null package defaults')).toBeInTheDocument();
  });

  it('loads the list once for every caller', async () => {
    mockLoadScreenMessages.mockResolvedValue({ default: PackageList });
    const { preloadMessages } = loadModule();

    const [first, second] = await Promise.all([preloadMessages(), preloadMessages()]);

    expect(first).toBe(second);
    expect(mockLoadScreenMessages).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed load instead of keeping the failure', async () => {
    mockLoadScreenMessages
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ default: PackageList });
    const { preloadMessages } = loadModule();

    await expect(preloadMessages()).rejects.toThrow('offline');
    await expect(preloadMessages()).resolves.toHaveProperty('default');
    expect(mockLoadScreenMessages).toHaveBeenCalledTimes(2);
  });
});
