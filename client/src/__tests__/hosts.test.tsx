import React from 'react';
import { join } from 'path';
import { readFileSync } from 'fs';
import { render, screen } from '@testing-library/react';
import { agentAuthor, useParentAuthor } from '@librechat/chat/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('~/components/Chat/Messages/MessageIcon', () => ({
  __esModule: true,
  default: ({ iconData }: { iconData?: { modelLabel?: string } }) => (
    <span data-testid="app-message-icon">{iconData?.modelLabel}</span>
  ),
}));

/** The registrations the app entry performs, loaded the way `App.jsx` loads them. Nothing here
 *  imports a message component, so the hosts cannot arrive as a side effect of one. */
const ENTRY_HOSTS = ['~/Providers/MessagePartsHostContext', '~/Providers/MessagesHostContext'];
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
  it('registers both default hosts from the app entry', () => {
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
});
