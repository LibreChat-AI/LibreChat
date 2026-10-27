import { getDefaultStore } from 'jotai';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { act, fireEvent, render } from '@testing-library/react';
import type { ChatScopedRequest } from '../useChatScopedRequest';
import { navigationGenerationAtom } from '~/store/navigation';
import useChatScopedRequest from '../useChatScopedRequest';

const mockConversation = { current: { conversationId: 'convo-1' as string | undefined } };
jest.mock('~/Providers', () => ({
  useChatContext: () => ({ conversation: mockConversation.current }),
}));

/** The real token lives in a module-level map keyed by composer index; the
 *  mock swaps in a plain symbol a test can renew by assignment. */
const mockDraftToken = { current: Symbol('new-conversation-draft') };
jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  getNewConversationDraftToken: () => mockDraftToken.current,
}));

let hookApi: ChatScopedRequest | null = null;
const onCancel = jest.fn();

function Harness() {
  hookApi = useChatScopedRequest(0, onCancel);
  return null;
}

function NavigateAwayTrigger({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button type="button" data-testid="navigate-away" onClick={() => navigate(to)} />;
}

const renderHarness = (initialPath = '/c/convo-1') =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <NavigateAwayTrigger to="/c/convo-2" />
      <Harness />
    </MemoryRouter>,
  );

beforeEach(() => {
  hookApi = null;
  onCancel.mockClear();
  mockConversation.current = { conversationId: 'convo-1' };
  mockDraftToken.current = Symbol('new-conversation-draft');
  getDefaultStore().set(navigationGenerationAtom, 0);
});

describe('useChatScopedRequest', () => {
  it('issues increasing tokens and reports only the latest as current', () => {
    renderHarness();

    const first = hookApi!.begin();
    expect(hookApi!.isCurrent(first)).toBe(true);

    const second = hookApi!.begin();
    expect(hookApi!.isCurrent(first)).toBe(false);
    expect(hookApi!.isCurrent(second)).toBe(true);
  });

  it('reports mounted while rendered and unmounted after unmount', () => {
    const { unmount } = renderHarness();
    expect(hookApi!.isMounted()).toBe(true);

    unmount();
    expect(hookApi!.isMounted()).toBe(false);
  });

  it('cancels a pending request when the chat identity changes', () => {
    const { rerender } = renderHarness();
    /** The initial mount also runs the cancellation effect once; only calls
     *  made after that first commit are this test's concern. */
    onCancel.mockClear();
    const token = hookApi!.begin();

    mockConversation.current = { conversationId: 'convo-2' };
    rerender(
      <MemoryRouter initialEntries={['/c/convo-1']}>
        <NavigateAwayTrigger to="/c/convo-2" />
        <Harness />
      </MemoryRouter>,
    );

    expect(hookApi!.isCurrent(token)).toBe(false);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending request when a navigation starts, via navigationGenerationAtom', () => {
    renderHarness();
    onCancel.mockClear();
    const token = hookApi!.begin();

    act(() => {
      getDefaultStore().set(navigationGenerationAtom, 1);
    });

    expect(hookApi!.isCurrent(token)).toBe(false);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending request when the route pathname changes', () => {
    const { getByTestId } = renderHarness();
    onCancel.mockClear();
    const token = hookApi!.begin();

    fireEvent.click(getByTestId('navigate-away'));

    expect(hookApi!.isCurrent(token)).toBe(false);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not cancel a pending request when nothing relevant changes across a re-render', () => {
    const { rerender } = renderHarness();
    onCancel.mockClear();
    const token = hookApi!.begin();

    rerender(
      <MemoryRouter initialEntries={['/c/convo-1']}>
        <NavigateAwayTrigger to="/c/convo-2" />
        <Harness />
      </MemoryRouter>,
    );

    expect(hookApi!.isCurrent(token)).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
