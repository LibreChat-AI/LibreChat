import React from 'react';
import { useResetAtom } from 'jotai/utils';
import { MemoryRouter } from 'react-router-dom';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { PartsPreviewContext } from '@librechat/chat/react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import type { MessagesOperations } from '~/Providers/MessagesViewContext';
import type { Artifact } from '~/common';
import {
  artifactsState,
  currentArtifactId,
  visibleArtifacts,
  artifactsVisibility,
} from '~/store/artifacts';
import { loadRehypeModules } from '~/components/Chat/Messages/Content/rehype';
import { MessagesOperationsContext } from '~/Providers/MessagesViewContext';
import Markdown from '~/components/Chat/Messages/Content/Markdown';
import { artifactsLiveReply } from '~/components/Artifacts/state';
import { MessageContext } from '~/Providers';

beforeAll(() => loadRehypeModules());

const header = ':::artifact{identifier="chart" title="Chart" type="text/markdown"}';
const conversationId = 'conversation-1';
let registered: Record<string, Artifact | undefined> | null;
let selected: string | null;
let visible: boolean;
let resetArchive: () => void;
let jotai = createStore();

beforeEach(() => {
  jotai = createStore();
});

function Registry() {
  registered = useRecoilValue(artifactsState);
  selected = useRecoilValue(currentArtifactId);
  visible = useRecoilValue(artifactsVisibility);
  resetArchive = useResetAtom(visibleArtifacts);
  return null;
}

/** Starts a main pane run whose tail is `messageId`, as the pane's host records it. */
const startRun = (messageId: string) =>
  act(() => {
    jotai.set(artifactsLiveReply, (reply) => ({ run: reply.run + 1, messageId }));
  });

/** Moves the running reply to `messageId`, as the tail does when the run's reply arrives. */
const followTail = (messageId: string) =>
  act(() => {
    jotai.set(artifactsLiveReply, (reply) => ({ run: reply.run, messageId }));
  });

const reply = (messageId: string, content: string, isSubmitting = false) => (
  <MessageContext.Provider value={{ messageId, conversationId, isExpanded: false, isSubmitting }}>
    <Markdown content={content} isLatestMessage={isSubmitting} />
  </MessageContext.Provider>
);

/** The reader closed the pane earlier: an artifact that opens itself has to reveal it. */
const page = (ui: React.ReactNode, operations?: MessagesOperations) => (
  <JotaiProvider store={jotai}>
    <RecoilRoot initializeState={({ set }) => set(artifactsVisibility, false)}>
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

it('shows progress from the header and opens the closed artifact of the live reply, in the same card', () => {
  startRun('current');
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
  expect(selected).toBeNull();

  rerender(view(`Here is the latest.\n${newVersion}\n:::\n`));
  expect(status).toBe(screen.getByRole('status'));
  expect(status).toHaveTextContent('Ready');
  expect(selected).toBe(artifactId('current'));
  expect(visible).toBe(true);
  expect(registered?.[artifactId('current')]?.content).toBe('New content\n');

  fireEvent.click(screen.getByRole('button', { name: /^Close artifact: Chart/ }));
  expect(selected).toBeNull();
  rerender(view(`Here is the latest.\n${newVersion}\n:::\nThat is all.`));
  expect(selected).toBeNull();
  expect(visible).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /^Open artifact: Chart/ }));
  expect(selected).toBe(artifactId('current'));
});

it('leaves a completed artifact closed when its response loads or continues', () => {
  const { rerender } = render(page(reply('saved', savedVersion)));
  expect(screen.getByRole('status')).toHaveTextContent('Ready');
  expect(registered?.[artifactId('saved')]?.content).toBe('Old content\n');

  startRun('saved');
  rerender(page(reply('saved', `${savedVersion}\n\nContinuing`, true)));
  expect(screen.getByRole('status')).toHaveTextContent('Ready');
  expect(selected).toBeNull();
  expect(visible).toBe(false);
});

it('keeps a source-code artifact click-to-open while its response generates', () => {
  const script = [
    ':::artifact{identifier="script" title="script.py" type="application/vnd.code"}',
    '```python',
    'print(1)',
    '```',
    ':::',
    '',
  ].join('\n');
  startRun('current');
  render(page(reply('current', script, true)));
  expect(screen.getByRole('status')).toHaveTextContent('Ready');
  expect(selected).toBeNull();
  expect(visible).toBe(false);
});

it('opens an artifact whose card only mounts after the live reply ended', () => {
  startRun('current');
  render(page(reply('current', `${newVersion}\n:::`)));
  expect(screen.getByRole('status')).toHaveTextContent('Ready');
  expect(selected).toBe(artifactId('current'));
  expect(visible).toBe(true);
});

it('opens an artifact whose reply becomes the tail only as the run ends', () => {
  startRun('prompt');
  render(page(reply('current', `${newVersion}\n:::`)));
  expect(screen.getByRole('status')).toHaveTextContent('Ready');
  expect(selected).toBeNull();
  followTail('current');
  expect(selected).toBe(artifactId('current'));
  expect(visible).toBe(true);
});

it('leaves an artifact the reply had before it was continued closed', () => {
  startRun('other');
  const { rerender } = render(page(reply('saved', `${savedVersion}\n`, true)));
  rerender(page(reply('saved', `${savedVersion}\n`)));
  expect(screen.getByRole('status')).toHaveTextContent('Ready');

  startRun('saved');
  rerender(page(reply('saved', `${savedVersion}\n\nContinuing`, true)));
  expect(screen.getByRole('status')).toHaveTextContent('Ready');
  expect(selected).toBeNull();
  expect(visible).toBe(false);
});

it('opens nothing for a reply that is not the main pane live reply', () => {
  startRun('current');
  render(page(reply('side', `${newVersion}\n:::\n`, true)));
  expect(screen.getByRole('status')).toHaveTextContent('Ready');
  expect(selected).toBeNull();
  expect(visible).toBe(false);
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

it('accepts a closing delimiter at EOF when the stream ends, and opens the artifact', () => {
  const content = `${newVersion}\n:::`;
  startRun('current');
  const { rerender } = render(page(reply('current', content, true)));
  expect(registered).toBeNull();
  expect(selected).toBeNull();
  rerender(page(reply('current', content)));
  expect(screen.getByRole('status')).toHaveTextContent('Ready');
  expect(registered?.[artifactId('current')]?.content).toBe('New content\n');
  expect(selected).toBe(artifactId('current'));
  expect(visible).toBe(true);
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
