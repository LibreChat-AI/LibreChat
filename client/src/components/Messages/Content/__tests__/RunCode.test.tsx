import React from 'react';
import { RecoilRoot } from 'recoil';
import { ToastProvider } from '@librechat/client';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ToolCallResponse } from 'librechat-data-provider';
import { MessageContext } from '~/Providers/MessageContext';
import RunCode from '../RunCode';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService, callTool: jest.fn() } };
});

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/Providers', () => jest.requireActual('~/Providers/MessageContext'));
jest.mock('~/data-provider', () => jest.requireActual('~/data-provider/Tools/mutations'));

describe('RunCode animation lifecycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each(['success', 'error'] as const)(
    'only animates during execution, including %s and retry',
    async (outcome) => {
      let settle: (value: ToolCallResponse) => void = () => undefined;
      let reject: (reason: Error) => void = () => undefined;
      const callTool = jest.mocked(dataService.callTool).mockImplementation(
        () =>
          new Promise<ToolCallResponse>((resolve, fail) => {
            settle = resolve;
            reject = fail;
          }),
      );
      const queryClient = new QueryClient({
        defaultOptions: { mutations: { retry: false } },
        logger: { log: console.log, warn: console.warn, error: () => undefined },
      });
      const code = document.createElement('code');
      code.textContent = 'print(1)';
      const { container, unmount } = render(
        <QueryClientProvider client={queryClient}>
          <RecoilRoot>
            <ToastProvider>
              <MessageContext.Provider
                value={{ messageId: 'message', conversationId: 'conversation', isExpanded: false }}
              >
                <RunCode lang="python" codeRef={{ current: code }} blockIndex={0} />
              </MessageContext.Provider>
            </ToastProvider>
          </RecoilRoot>
        </QueryClientProvider>,
      );
      const button = screen.getByRole('button', { name: 'com_ui_run_code' });
      expect(container.querySelector('.spinner')).not.toBeInTheDocument();
      await act(async () => {
        fireEvent.click(button);
        await jest.advanceTimersByTimeAsync(0);
      });
      await waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(button).toBeDisabled());
      expect(container.querySelector('.spinner')).toBeInTheDocument();
      await act(async () => {
        if (outcome === 'success') settle({ result: '1', attachments: [] });
        else reject(new Error('Execution failed'));
      });
      await waitFor(() => expect(button).toBeEnabled());
      expect(container.querySelector('.spinner')).not.toBeInTheDocument();
      await act(async () => {
        jest.advanceTimersByTime(1100);
      });
      await act(async () => {
        fireEvent.click(button);
        await jest.advanceTimersByTimeAsync(0);
      });
      await waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(button).toBeDisabled());
      expect(container.querySelector('.spinner')).toBeInTheDocument();
      await act(async () => settle({ result: '1', attachments: [] }));
      await waitFor(() => expect(button).toBeEnabled());
      expect(container.querySelector('.spinner')).not.toBeInTheDocument();
      unmount();
      queryClient.clear();
    },
  );
});
