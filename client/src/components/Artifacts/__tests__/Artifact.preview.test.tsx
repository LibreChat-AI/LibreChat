import React from 'react';
import { useResetAtom } from 'jotai/utils';
import { MemoryRouter } from 'react-router-dom';
import { Provider as JotaiProvider } from 'jotai';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { PartsPreviewContext } from '@librechat/chat/react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import type { MessagesOperations } from '~/Providers/MessagesViewContext';
import type { Artifact } from '~/common';
import { artifactsState, currentArtifactId, visibleArtifacts } from '~/store/artifacts';
import { loadRehypeModules } from '~/components/Chat/Messages/Content/rehype';
import { MessagesOperationsContext } from '~/Providers/MessagesViewContext';
import Markdown from '~/components/Chat/Messages/Content/Markdown';
import { MessageContext } from '~/Providers';

beforeAll(() => loadRehypeModules());

const header = ':::artifact{identifier="chart" title="Chart" type="text/markdown"}';
const conversationId = 'conversation-1';
let registered: Record<string, Artifact | undefined> | null;
let selected: string | null;
let resetArchive: () => void;

function Registry() {
  registered = useRecoilValue(artifactsState);
  selected = useRecoilValue(currentArtifactId);
  resetArchive = useResetAtom(visibleArtifacts);
  return null;
}

const reply = (messageId: string, content: string, isSubmitting = false) => (
  <MessageContext.Provider value={{ messageId, conversationId, isExpanded: false, isSubmitting }}>
    <Markdown content={content} isLatestMessage={isSubmitting} />
  </MessageContext.Provider>
);

const page = (ui: React.ReactNode, operations?: MessagesOperations) => (
  <JotaiProvider>
    <RecoilRoot>
      <MemoryRouter initialEntries={[`/c/${conversationId}`]}>
        <MessagesOperationsContext.Provider value={operations}>
          <Registry />
          {ui}
        </MessagesOperationsContext.Provider>
      </MemoryRouter>
    </RecoilRoot>
  </JotaiProvider>
);

const savedVersion = `${header}\n\`\`\`markdown\nOld content\n\`\`\`\n:::`;
const newVersion = `${header}\n\`\`\`markdown\nNew content\n\`\`\``;
const artifactId = (messageId: string) => `chart_text/markdown_chart_${messageId}`;

it('shows progress from the header and opens only the closed artifact, in the same card', () => {
  const view = (content: string) => page(reply('current', content, true));
  const { rerender } = render(view('Here is the latest.'));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();

  rerender(view(`Here is the latest.\n${header}`));
  const status = screen.getByRole('status');
  expect(status).toHaveTextContent('Creating artifact…');
  expect(screen.getByText('Chart')).toBeVisible();
  expect(screen.queryByRole('button', { name: /^Open artifact/ })).not.toBeInTheDocument();

  rerender(view(`Here is the latest.\n${newVersion}\n:::`));
  expect(status).toHaveTextContent('Creating artifact…');
  expect(registered).toBeNull();

  rerender(view(`Here is the latest.\n${newVersion}\n:::\n`));
  expect(status).toBe(screen.getByRole('status'));
  expect(status).toHaveTextContent('Ready');
  expect(selected).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /^Open artifact: Chart/ }));
  expect(selected).toBe(artifactId('current'));
  expect(registered?.[artifactId('current')]?.content).toBe('New content\n');
});

it.each([
  ['an unfinished body', newVersion],
  ['an extending delimiter', `${newVersion}\n:::not-a-closer`],
  ['an indented colon line', `${newVersion}\n    :::`],
])('never registers %s, including after the message is restored', (_description, content) => {
  const { rerender, unmount } = render(page(reply('current', content, true)));
  expect(screen.getByRole('status')).toHaveTextContent('Creating artifact…');
  rerender(page(reply('current', content)));
  expect(screen.getByRole('status')).toHaveTextContent('Artifact generation stopped');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(registered).toBeNull();
  unmount();
  render(page(reply('current', content)));
  expect(screen.getByRole('status')).toHaveTextContent('Artifact generation stopped');
  expect(registered).toBeNull();
});

it('accepts a closing delimiter at EOF when the stream ends', () => {
  const content = `${newVersion}\n:::`;
  const { rerender } = render(page(reply('current', content, true)));
  expect(registered).toBeNull();
  rerender(page(reply('current', content)));
  expect(screen.getByRole('status')).toHaveTextContent('Ready');
  expect(registered?.[artifactId('current')]?.content).toBe('New content\n');
});

it('opens the closest completed ancestor, not a sibling, even after interruption', () => {
  const messages = [
    { messageId: 'prior', parentMessageId: 'root' },
    { messageId: 'sibling', parentMessageId: 'prior' },
    { messageId: 'prompt', parentMessageId: 'prior' },
    { messageId: 'current', parentMessageId: 'prompt' },
  ].map((message): TMessage => ({ ...message, conversationId, text: '', isCreatedByUser: false }));
  const operations: MessagesOperations = {
    getMessages: () => messages,
    ask: jest.fn(),
    regenerate: jest.fn(),
    handleContinue: jest.fn(),
    setMessages: jest.fn(),
  };
  const view = (submitting: boolean, text = newVersion) =>
    page(
      <>
        {reply('prior', savedVersion)}
        {reply('sibling', savedVersion.replace('Old content', 'Sibling content'))}
        {reply('current', text, submitting)}
      </>,
      operations,
    );
  const { rerender } = render(view(true));
  expect(screen.getByText('Updating artifact…')).toBeVisible();
  act(() => resetArchive());
  expect(screen.getByText('Updating artifact…')).toBeVisible();
  const previous = screen.getByRole('button', { name: /^Open previous version: Chart/ });
  fireEvent.click(previous);
  expect(selected).toBe(artifactId('prior'));
  expect(registered?.[artifactId('prior')]?.content).toBe('Old content\n');
  expect(registered?.[artifactId('current')]).toBeUndefined();

  fireEvent.click(previous);
  rerender(view(false));
  expect(screen.getByText('Artifact generation stopped')).toBeVisible();
  expect(screen.getByRole('button', { name: /^Open previous version: Chart/ })).toBe(previous);
  fireEvent.click(previous);
  expect(selected).toBe(artifactId('prior'));
});

it('does not register or open an artifact in a parts preview', () => {
  render(
    page(
      <PartsPreviewContext.Provider value={true}>
        {reply('parked', savedVersion)}
      </PartsPreviewContext.Provider>,
    ),
  );
  expect(screen.getByRole('status')).toHaveTextContent('Ready');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(registered).toBeNull();
});
