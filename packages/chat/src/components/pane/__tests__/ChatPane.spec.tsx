/**
 * @jest-environment jsdom
 */
import { useEffect } from 'react';
import { Provider, createStore } from 'jotai';
import { Constants } from 'librechat-data-provider';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ChatPaneProps } from '../ChatPane';
import { composerLiftFamily } from '../../../react/lift';
import { getChatPaneView } from '../view';
import ChatPane from '../ChatPane';

function renderPane(props: Partial<ChatPaneProps> = {}, lift = 0) {
  const jotaiStore = createStore();
  jotaiStore.set(composerLiftFamily(0), lift);
  const pane = (next: Partial<ChatPaneProps>) => (
    <Provider store={jotaiStore}>
      <ChatPane
        view={{ isLanding: false, column: 'messages' }}
        heading="Deploy checklist"
        header={<div data-testid="header" />}
        messages={<ol aria-label="Messages" />}
        landing={<p>Welcome</p>}
        starters={<button type="button">Starter</button>}
        composer={<textarea aria-label="Message" />}
        {...next}
      />
    </Provider>
  );
  const result = render(pane(props));
  return { ...result, rerenderPane: (next: Partial<ChatPaneProps>) => result.rerender(pane(next)) };
}

const LANDING = { isLanding: true, column: 'landing' } as const;

const paneColumn = (container: HTMLElement) =>
  container.querySelector('[data-chat-pane="0"]') as HTMLElement;
const composerBand = (container: HTMLElement) =>
  paneColumn(container).querySelector('.bg-surface-canvas') as HTMLElement;

describe('getChatPaneView', () => {
  it.each([
    [{ conversationId: undefined, hasMessages: false, isLoading: false }, true, 'landing'],
    [{ conversationId: Constants.NEW_CONVO, hasMessages: false, isLoading: true }, true, 'landing'],
    [{ conversationId: undefined, hasMessages: false, isLoading: true }, true, 'loading'],
    [{ conversationId: 'convo-1', hasMessages: false, isLoading: true }, false, 'loading'],
    [{ conversationId: 'convo-1', hasMessages: false, isLoading: false }, false, 'loading'],
    [{ conversationId: Constants.NEW_CONVO, hasMessages: true, isLoading: true }, false, 'loading'],
    [{ conversationId: 'convo-1', hasMessages: true, isLoading: false }, false, 'messages'],
    [
      { conversationId: Constants.NEW_CONVO, hasMessages: true, isLoading: false },
      false,
      'messages',
    ],
  ] as const)('%o lays out landing=%s and shows %s', (input, isLanding, column) => {
    expect(getChatPaneView(input)).toEqual({ isLanding, column });
  });
});

describe('ChatPane', () => {
  it('names the page and seats the header in its pane portal', () => {
    const { container } = renderPane();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Deploy checklist');
    expect(container.querySelector('[data-chat-pane-portal="0"]')).toContainElement(
      screen.getByTestId('header'),
    );
  });

  it('shows the message list above the composer in a scrolling conversation column', () => {
    const { container } = renderPane();

    expect(screen.getByRole('list', { name: 'Messages' })).toBeInTheDocument();
    expect(screen.queryByText('Welcome')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Starter' })).not.toBeInTheDocument();
    expect(paneColumn(container)).toHaveClass('h-full', 'overflow-y-auto');
    expect(composerBand(container)).toHaveClass('scrollbar-gutter-spacer', 'relative', 'z-10');
    expect(composerBand(container)).toContainElement(
      screen.getByRole('textbox', { name: 'Message' }),
    );
  });

  it('centres the welcome screen and its starters without a scroll container', () => {
    const { container } = renderPane({ view: LANDING });

    expect(screen.getByText('Welcome')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Messages' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Starter' })).toBeInTheDocument();
    expect(paneColumn(container)).toHaveClass('scrollbar-gutter-spacer', 'flex-1');
    expect(paneColumn(container)).not.toHaveClass('overflow-y-auto');
    expect(composerBand(container)).not.toHaveClass('scrollbar-gutter-spacer');
  });

  it('shows a spinner in place of the column while loading', () => {
    renderPane({ view: { isLanding: false, column: 'loading' } });

    expect(screen.queryByRole('list', { name: 'Messages' })).not.toBeInTheDocument();
    expect(screen.queryByText('Welcome')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
  });

  it('keeps the welcome layout under the spinner while a new session loads', () => {
    const { container } = renderPane({ view: { isLanding: true, column: 'loading' } });

    expect(screen.queryByText('Welcome')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Starter' })).toBeInTheDocument();
    expect(paneColumn(container)).toHaveClass('scrollbar-gutter-spacer', 'flex-1');
    expect(paneColumn(container)).not.toHaveClass('overflow-y-auto');
  });

  it('replaces the composer with a note for a conversation the reader cannot continue', () => {
    renderPane({ readOnlyNote: 'View only' });

    expect(screen.getByRole('note')).toHaveTextContent('View only');
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
  });

  it('pins the badge below the header only in a conversation', () => {
    const badge = <span>Project Atlas</span>;
    const { container, rerenderPane } = renderPane({ badge });

    expect(screen.getByText('Project Atlas')).toBeInTheDocument();
    expect(paneColumn(container)).toHaveClass('pt-9');

    rerenderPane({ badge, view: LANDING });
    expect(screen.queryByText('Project Atlas')).not.toBeInTheDocument();
    expect(paneColumn(container)).not.toHaveClass('pt-9');
  });

  it('lifts the welcome column by the room an open composer popover needs', () => {
    const { container } = renderPane({ view: LANDING }, 120);
    expect(paneColumn(container).style.transform).toBe('translateY(-120px)');
  });

  it('keeps a conversation column in place whatever the lift', () => {
    const { container } = renderPane({}, 120);
    expect(paneColumn(container).style.transform).toBe('');
  });

  it('seats the band footer inside the band and the footer below the column', () => {
    const { container } = renderPane({
      bandFooter: <p>Configured footer</p>,
      footer: <p>Full footer</p>,
    });

    expect(composerBand(container)).toContainElement(screen.getByText('Configured footer'));
    expect(paneColumn(container)).not.toContainElement(screen.getByText('Full footer'));
  });

  it('hands the mascot the composer band to stand on', () => {
    let band: HTMLElement | null = null;
    function Mascot({ bandRef }: { bandRef: { current: HTMLElement | null } }) {
      useEffect(() => {
        band = bandRef.current;
      }, [bandRef]);
      return null;
    }
    const { container } = renderPane({ renderMascot: (bandRef) => <Mascot bandRef={bandRef} /> });

    expect(band).toBe(composerBand(container));
  });

  it('keeps the column wrapper mounted when the view changes', () => {
    const mounts = jest.fn();
    function Wrapper({ children }: { children: ReactNode }) {
      useEffect(() => mounts(), []);
      return <section aria-label="Column">{children}</section>;
    }
    const renderColumn = (column: ReactNode) => <Wrapper>{column}</Wrapper>;
    const { rerenderPane } = renderPane({ view: LANDING, renderColumn });

    expect(screen.getByRole('region', { name: 'Column' })).toHaveTextContent('Welcome');
    rerenderPane({ view: { isLanding: false, column: 'messages' }, renderColumn });
    expect(screen.getByRole('region', { name: 'Column' })).toContainElement(
      screen.getByRole('list', { name: 'Messages' }),
    );
    expect(mounts).toHaveBeenCalledTimes(1);
  });
});
