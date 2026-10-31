import React from 'react';
import { join } from 'path';
import { readFileSync } from 'fs';
import { RecoilRoot } from 'recoil';
import { SubagentActivity } from '@librechat/chat/components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { agentAuthor, useParentAuthor, TaskContentScopeContext } from '@librechat/chat/react';
import type { ChildActivity } from '@librechat/chat/react';

jest.mock('~/components/Chat/Messages/MessageIcon', () => ({
  __esModule: true,
  default: ({ iconData }: { iconData?: { modelLabel?: string } }) => (
    <span data-testid="app-message-icon">{iconData?.modelLabel}</span>
  ),
}));

const mockReadControl = jest.fn();
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getSubagentControlReceipt: (...args: unknown[]) => mockReadControl(...args),
    },
  };
});

/** The registrations the app entry performs, loaded the way `App.jsx` loads them. Nothing here
 *  imports a message component, so the hosts cannot arrive as a side effect of one. */
const ENTRY_HOSTS = [
  '~/Providers/MessagePartsHostContext',
  '~/Providers/MessagesHostContext',
  '~/Providers/SubagentsHostContext',
  '~/components/Chat/Messages/Content/register',
];
ENTRY_HOSTS.forEach((path) => jest.requireActual(path));

function ParentAuthor() {
  const author = useParentAuthor('conversation', 'message', 'Parent agent');
  return (
    <>
      <span data-testid="parent-name">{author.name}</span>
      {author.icon}
    </>
  );
}

describe('app host registration', () => {
  it('registers every default host from the app entry', () => {
    const entry = readFileSync(join(__dirname, '..', 'App.jsx'), 'utf8');
    for (const path of ENTRY_HOSTS) {
      expect(entry).toContain(`import '${path}';`);
    }
  });

  it('renders subagent authors through the app hosts the entry registers', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ParentAuthor />
        {agentAuthor(undefined, 'Child agent').icon}
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('parent-name')).toHaveTextContent('Parent agent');
    expect(screen.getAllByTestId('app-message-icon').map((node) => node.textContent)).toEqual([
      'Parent agent',
      'Child agent',
    ]);
  });

  describe('subagent transcripts', () => {
    const control = {
      invocationId: 'budgeted',
      controlId: 'pending-control',
      action: 'queue' as const,
      status: 'accepted' as const,
      createdAt: '2026-10-23T00:00:00Z',
      updatedAt: '2026-10-23T00:00:01Z',
      message: 'Budgeted prefix',
      messageTruncated: true,
    };
    const activity: ChildActivity = {
      title: 'Child',
      status: 'running',
      items: [{ type: 'writing', text: 'Working.' }],
      controls: [control],
    };
    const renderTranscript = () =>
      render(
        <RecoilRoot>
          <QueryClientProvider
            client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
          >
            <TaskContentScopeContext.Provider
              value={{ parentConversationId: 'parent', threadId: 'child', taskId: 'task' }}
            >
              <SubagentActivity activity={activity} embedded />
            </TaskContentScopeContext.Provider>
          </QueryClientProvider>
        </RecoilRoot>,
      );

    beforeEach(() => mockReadControl.mockReset());

    it('draws content and guidance with the real app renderers and reads a receipt only on request', async () => {
      mockReadControl.mockResolvedValueOnce({
        receipt: { ...control, message: 'Full guidance.', messageTruncated: false },
      });
      renderTranscript();
      expect(screen.getByText('Working.').closest('[data-message-text]')).not.toBeNull();
      expect(screen.getByTestId('steer-part')).toHaveTextContent('Budgeted prefix');
      expect(mockReadControl).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: /show more/i }));
      await waitFor(() =>
        expect(screen.getByTestId('steer-part')).toHaveTextContent('Full guidance.'),
      );
      expect(mockReadControl).toHaveBeenCalledWith('parent', 'child', 'task', 'budgeted');
    });

    it('reports a receipt for another control as a load error', async () => {
      mockReadControl.mockResolvedValue({ receipt: { ...control, invocationId: 'other' } });
      renderTranscript();
      fireEvent.click(screen.getByRole('button', { name: /show more/i }));
      /** The receipt query retries once, as the transcript always has, before it reports. */
      expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toBeInTheDocument();
      expect(mockReadControl).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('steer-part')).toHaveTextContent('Budgeted prefix');
    });
  });
});
