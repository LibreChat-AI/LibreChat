/**
 * @jest-environment jsdom
 */
import { Provider, createStore } from 'jotai';
import { render, screen, act } from '@testing-library/react';
import type { MessageFooterProps } from '../MessageFooter';
import { submissionStartFamily } from '../../../react/generation';
import { initEnglish } from '../../../__fixtures__/i18n';
import MessageFooter from '../MessageFooter';

beforeAll(initEnglish);

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

function renderFooter(
  props: Partial<MessageFooterProps> = {},
  jotaiStore: ReturnType<typeof createStore> = createStore(),
) {
  render(
    <Provider store={jotaiStore}>
      <MessageFooter
        index={0}
        isSubmitting={false}
        isLatestMessage={false}
        isUserSide={false}
        siblingIdx={0}
        siblingCount={2}
        setSiblingIdx={() => undefined}
        toolbar={<button type="button">Copy to clipboard</button>}
        {...props}
      />
    </Provider>,
  );
  return screen.queryByRole('navigation', { name: 'Sibling message navigation' }) as HTMLElement;
}

describe('MessageFooter', () => {
  it('keeps a reply footer at the column start with its sibling controls before the toolbar', () => {
    const siblings = renderFooter();

    expect(siblings.parentElement).not.toHaveClass('justify-end');
    expect(siblings).not.toHaveClass('order-last');
    expect(siblings.nextElementSibling).toHaveTextContent('Copy to clipboard');
  });

  it('aligns a user-side footer to the end and moves its sibling controls to the edge', () => {
    const siblings = renderFooter({ isUserSide: true, siblingsLast: true });

    expect(siblings.parentElement).toHaveClass('justify-end');
    expect(siblings).toHaveClass('order-last');
  });

  it('can align to the end while keeping the sibling controls inboard', () => {
    const siblings = renderFooter({ isUserSide: true });

    expect(siblings.parentElement).toHaveClass('justify-end');
    expect(siblings).not.toHaveClass('order-last');
  });

  it('shows elapsed time from its own pane while the latest reply streams', () => {
    const jotaiStore = createStore();
    jotaiStore.set(submissionStartFamily(0), Date.now() - 40_000);
    jotaiStore.set(submissionStartFamily(1), Date.now() - 5_000);
    renderFooter(
      { index: 1, isSubmitting: true, isLatestMessage: true, siblingCount: 1 },
      jotaiStore,
    );

    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent(/^5s$/);
    act(() => {
      jest.advanceTimersByTime(2_000);
    });
    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent(/^7s$/);
  });

  it('shows no elapsed time once the row settles', () => {
    const jotaiStore = createStore();
    jotaiStore.set(submissionStartFamily(0), Date.now() - 5_000);
    renderFooter({ isLatestMessage: true, siblingCount: 1 }, jotaiStore);
    expect(screen.queryByTestId('stream-elapsed')).not.toBeInTheDocument();
  });

  it('keeps the sibling controls visible on a settled row', () => {
    const settled = renderFooter({ isLatestMessage: true });
    expect(settled).not.toHaveClass('no-touch:opacity-0');
  });

  it('hides the sibling controls until hover while the latest reply streams', () => {
    const streaming = renderFooter({ isSubmitting: true, isLatestMessage: true });
    expect(streaming).toHaveClass('no-touch:opacity-0', 'group-hover:opacity-100');
  });
});
