/**
 * @jest-environment jsdom
 */
import { Provider, createStore } from 'jotai';
import { render, screen } from '@testing-library/react';
import type { TChatProject, TConversation, TFile, TMessage } from 'librechat-data-provider';
import type { ChatContract } from '../../../react/chat/contract';
import type { ChatScreenProps } from '../Screen';
import { ChatContext } from '../../../react/chat/context';
import { initEnglish } from '../../../__fixtures__/i18n';
import ChatScreen from '../Screen';

beforeAll(initEnglish);

const ROOT = '00000000-0000-0000-0000-000000000000';

const messages = [
  {
    messageId: 'u1',
    parentMessageId: ROOT,
    conversationId: 'c1',
    isCreatedByUser: true,
    text: 'Hi',
    files: [{ file_id: 'f1' }],
  },
  {
    messageId: 'a1',
    parentMessageId: 'u1',
    conversationId: 'c1',
    isCreatedByUser: false,
    text: 'Hello',
  },
] as TMessage[];

const project = { _id: 'p1', name: 'Research' } as unknown as TChatProject;

function renderScreen(
  props: Partial<ChatScreenProps>,
  conversation: Partial<TConversation> | null = { conversationId: 'c1', title: 'Plans' },
  fileMap?: Record<string, TFile>,
) {
  return render(
    <Provider store={createStore()}>
      <ChatContext.Provider value={{ conversation } as unknown as ChatContract}>
        <ChatScreen
          conversationId="c1"
          messages={messages}
          fileMap={fileMap}
          isLoading={false}
          landingFooter
          configuredFooter={false}
          renderHeader={({ readOnly, parentConversationId }) => (
            <header data-read-only={String(readOnly)} data-parent={parentConversationId ?? ''} />
          )}
          renderBadge={(projectId) => <p>Badge {projectId}</p>}
          renderMessages={({ messagesTree }) => (
            <ol aria-label="Messages">
              {messagesTree?.map((message) => (
                <li key={message.messageId}>
                  {message.text} {message.files?.map((file) => file.filename).join(',')}
                  {message.children?.map((child) => child.text).join(',')}
                </li>
              ))}
            </ol>
          )}
          landing={<p>Welcome</p>}
          renderComposer={({ isLanding, footerBelow, project: landingProject, placeholder }) => (
            <textarea
              aria-label="Message"
              placeholder={placeholder}
              data-landing={String(isLanding)}
              data-footer-below={String(footerBelow)}
              data-project={landingProject?.name ?? ''}
            />
          )}
          renderFooter={(placement) => <footer data-placement={placement} />}
          renderMascot={(_bandRef, isLanding) => (
            <span data-testid="mascot" data-landing={String(isLanding)} />
          )}
          {...props}
        />
      </ChatContext.Provider>
    </Provider>,
  );
}

const composer = () => screen.getByRole('textbox', { name: 'Message' });

describe('ChatScreen', () => {
  it('builds the tree from the session, hydrating files from the host, under the conversation title', () => {
    renderScreen({}, undefined, { f1: { file_id: 'f1', filename: 'notes.txt' } as TFile });

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Plans');
    const roots = screen.getAllByRole('listitem');
    expect(roots).toHaveLength(1);
    expect(roots[0]).toHaveTextContent('Hi notes.txt');
    expect(roots[0]).toHaveTextContent('Hello');
    expect(composer()).toHaveAttribute('data-landing', 'false');
    expect(screen.getByTestId('mascot')).toHaveAttribute('data-landing', 'false');
  });

  it('greets a new chat with the new-chat heading, the full footer and the welcome screen', () => {
    const { container } = renderScreen({ conversationId: undefined, messages: null }, null);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New chat');
    expect(screen.getByText('Welcome')).toBeInTheDocument();
    expect(composer()).toHaveAttribute('data-landing', 'true');
    expect(composer()).toHaveAttribute('data-footer-below', 'true');
    expect(container.querySelectorAll('footer')).toHaveLength(1);
    expect(container.querySelector('footer')).toHaveAttribute('data-placement', 'full');
  });

  it("keeps a deployment's configured footer in the conversation's composer band", () => {
    const { container } = renderScreen({ configuredFooter: true });

    expect(container.querySelector('footer')).toHaveAttribute('data-placement', 'band');
    expect(composer()).toHaveAttribute('data-footer-below', 'true');
  });

  it("starts a new chat in the routed project with the project's placeholder", () => {
    renderScreen({ conversationId: undefined, messages: null, project }, null);

    expect(composer()).toHaveAttribute('data-project', 'Research');
    expect(composer()).toHaveAttribute('placeholder', expect.stringContaining('Research'));
  });

  it("badges the conversation's project", () => {
    renderScreen({}, { conversationId: 'c1', title: 'Plans', chatProjectId: 'p1' });

    expect(screen.getByText('Badge p1')).toBeInTheDocument();
  });

  it("replaces the composer with the read-only note in a subagent's thread", () => {
    const { container } = renderScreen(
      {},
      {
        conversationId: 'c1',
        title: 'Child',
        subagentThread: { parentConversationId: 'parent' } as TConversation['subagentThread'],
      },
    );

    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.getByText(/This child thread is view-only here/)).toBeInTheDocument();
    expect(container.querySelector('header')).toHaveAttribute('data-read-only', 'true');
    expect(container.querySelector('header')).toHaveAttribute('data-parent', 'parent');
  });
});
