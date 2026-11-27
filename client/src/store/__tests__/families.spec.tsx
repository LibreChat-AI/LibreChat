/* eslint-disable i18next/no-literal-string */
import React, { useRef } from 'react';
import { RecoilRoot, useRecoilState } from 'recoil';
import { Constants } from 'librechat-data-provider';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  useNavigate,
  RouterProvider,
  useSearchParams,
  createBrowserRouter,
} from 'react-router-dom';
import type { TConversation } from 'librechat-data-provider';
import families from '../families';

const draftConvo = (overrides: Partial<TConversation> = {}): TConversation =>
  ({
    conversationId: Constants.NEW_CONVO,
    title: 'New Chat',
    endpoint: 'openAI',
    model: 'gpt-4o',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }) as TConversation;

/**
 * Each button replays the exact write sequence of a real caller against the
 * real `conversationByIndex` atom effect and a real browser router, so the
 * history assertions below cover the mechanism, not a re-implementation:
 * - `edit-model` — any settings change on the landing (model menu, params panel)
 * - `chip-switch` — ProjectLandingChip.applyProject (atom write + in-place URL)
 * - `sidebar-switch` — useNewConvo: setConversation followed by navigate(push)
 * - `clear-project` — useDeleteProjectMutation scrubbing the active draft
 */
function Driver() {
  const [conversation, setConversation] = useRecoilState(families.conversationByIndex(0));
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const editCount = useRef(0);

  const editModel = () => {
    if (!conversation) {
      return;
    }
    editCount.current += 1;
    setConversation({ ...conversation, model: `edited-${editCount.current}` });
  };

  const chipSwitch = () => {
    if (!conversation) {
      return;
    }
    setConversation({ ...conversation, chatProjectId: 'proj-chip' });
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('projectId', 'proj-chip');
    setSearchParams(nextParams, { replace: true, flushSync: true });
  };

  const sidebarSwitch = () => {
    setConversation(draftConvo({ model: 'sidebar-model', chatProjectId: 'proj-side' }));
    navigate(`/c/${Constants.NEW_CONVO}?projectId=proj-side`);
  };

  const clearProject = () => {
    if (!conversation) {
      return;
    }
    setConversation({ ...conversation, chatProjectId: null });
  };

  return (
    <div>
      <span data-testid="convo-id">{conversation?.conversationId ?? 'none'}</span>
      <span data-testid="convo-model">{conversation?.model ?? 'none'}</span>
      <button onClick={() => setConversation(draftConvo())}>seed</button>
      <button onClick={editModel}>edit-model</button>
      <button onClick={chipSwitch}>chip-switch</button>
      <button onClick={sidebarSwitch}>sidebar-switch</button>
      <button onClick={clearProject}>clear-project</button>
      <button
        onClick={() =>
          setConversation(
            draftConvo({
              conversationId: 'saved-123',
              createdAt: '2026-08-16T00:00:00Z',
              model: 'persisted-model',
            }),
          )
        }
      >
        persist
      </button>
      <button
        onClick={() => setConversation(draftConvo({ disableParams: true, model: 'blocked-model' }))}
      >
        disabled-edit
      </button>
    </div>
  );
}

type HistoryOp = { verb: 'push' | 'replace'; url: string };

describe('conversationByIndex URL mirroring', () => {
  let ops: HistoryOp[] = [];

  const pushes = () => ops.filter((op) => op.verb === 'push');
  const replaces = () => ops.filter((op) => op.verb === 'replace');

  beforeEach(() => {
    window.history.replaceState({}, '', `/c/${Constants.NEW_CONVO}`);
    ops = [];
    const realPush = window.history.pushState.bind(window.history);
    const realReplace = window.history.replaceState.bind(window.history);
    jest.spyOn(window.history, 'pushState').mockImplementation((data, unused, url) => {
      ops.push({ verb: 'push', url: String(url) });
      realPush(data, unused, url);
    });
    jest.spyOn(window.history, 'replaceState').mockImplementation((data, unused, url) => {
      ops.push({ verb: 'replace', url: String(url) });
      realReplace(data, unused, url);
    });
  });

  const renderChat = () => {
    const router = createBrowserRouter([{ path: '/c/:conversationId', element: <Driver /> }]);
    render(
      <RecoilRoot>
        <RouterProvider router={router} />
      </RecoilRoot>,
    );
  };

  const seed = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'seed' }));
    await waitFor(() =>
      expect(screen.getByTestId('convo-id')).toHaveTextContent(
        new RegExp(`^${Constants.NEW_CONVO}$`),
      ),
    );
    ops.length = 0;
  };

  it('mirrors draft edits into the URL without minting history entries', async () => {
    renderChat();
    await seed();
    const depthBefore = window.history.length;

    const edit = screen.getByRole('button', { name: 'edit-model' });
    fireEvent.click(edit);
    await waitFor(() => expect(window.location.search).toContain('model=edited-1'));
    fireEvent.click(edit);
    await waitFor(() => expect(window.location.search).toContain('model=edited-2'));
    fireEvent.click(edit);
    await waitFor(() => expect(window.location.search).toContain('model=edited-3'));

    expect(pushes()).toHaveLength(0);
    expect(replaces()).toHaveLength(3);
    expect(window.history.length).toBe(depthBefore);
    expect(window.location.pathname).toBe(`/c/${Constants.NEW_CONVO}`);
    expect(window.location.search).toContain('endpoint=openAI');
  });

  it('keeps the landing project switch in place, as ProjectLandingChip intends', async () => {
    renderChat();
    await seed();
    const depthBefore = window.history.length;

    fireEvent.click(screen.getByRole('button', { name: 'chip-switch' }));

    await waitFor(() => expect(window.location.search).toContain('projectId=proj-chip'));
    expect(pushes()).toHaveLength(0);
    expect(window.history.length).toBe(depthBefore);
  });

  it('mirrors onto the entry the sidebar project switch pushed, not its Back target', async () => {
    renderChat();
    await seed();
    const depthBefore = window.history.length;

    fireEvent.click(screen.getByRole('button', { name: 'sidebar-switch' }));

    await waitFor(() => expect(pushes()).toHaveLength(1));
    await waitFor(() =>
      expect(replaces().some((op) => op.url.includes('model=sidebar-model'))).toBe(true),
    );

    const pushIndex = ops.findIndex((op) => op.verb === 'push');
    const mirrorIndex = ops.findIndex((op) => op.url.includes('model=sidebar-model'));
    /** Pins Recoil onSet timing relative to the navigate() that follows the
     * atom write in useNewConvo: the mirror must land after the router's
     * push — on the new entry — never rewriting the Back target beneath it. */
    expect(mirrorIndex).toBeGreaterThan(pushIndex);

    expect(pushes()[0].url).toBe(`/c/${Constants.NEW_CONVO}?projectId=proj-side`);
    expect(window.history.length).toBe(depthBefore + 1);
    expect(window.location.search).toContain('projectId=proj-side');
  });

  it('scrubs projectId in place when the active draft loses its project', async () => {
    renderChat();
    await seed();
    fireEvent.click(screen.getByRole('button', { name: 'chip-switch' }));
    await waitFor(() => expect(window.location.search).toContain('projectId=proj-chip'));
    ops.length = 0;
    const depthBefore = window.history.length;

    fireEvent.click(screen.getByRole('button', { name: 'clear-project' }));

    await waitFor(() => expect(window.location.search).not.toContain('projectId'));
    expect(pushes()).toHaveLength(0);
    expect(window.history.length).toBe(depthBefore);
    expect(window.location.search).toContain('model=');
  });

  it('never touches history once the conversation is persisted', async () => {
    renderChat();
    await seed();

    fireEvent.click(screen.getByRole('button', { name: 'persist' }));

    await waitFor(() => expect(screen.getByTestId('convo-id')).toHaveTextContent('saved-123'));
    expect(ops).toHaveLength(0);
  });

  it('stays out of the URL entirely when params are disabled', async () => {
    renderChat();
    await seed();

    fireEvent.click(screen.getByRole('button', { name: 'disabled-edit' }));

    await waitFor(() =>
      expect(screen.getByTestId('convo-model')).toHaveTextContent('blocked-model'),
    );
    expect(ops).toHaveLength(0);
  });
});
