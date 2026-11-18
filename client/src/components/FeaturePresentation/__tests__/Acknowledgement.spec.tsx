import React, { useEffect, useRef, useState } from 'react';
import { Provider } from 'jotai';
import { ResumableRun } from '@librechat/chat';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService, resolveNavigation } from 'librechat-data-provider';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation, useParams } from 'react-router-dom';
import type { TConversation } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import {
  registerComposerDraft,
  captureComposerDraft,
  bindComposerLaunch,
  adoptComposerConversation,
  renewNewConversationDraftToken,
  getFilesDraft,
} from '~/utils/drafts';
import {
  beginFileSearchUpload,
  captureFileSearchUpload,
  completeFileSearchUpload,
  cancelFileSearchUpload,
} from '~/hooks/Files/search';
import { FeaturePresentationProvider, useFeaturePresentation } from '../Context';
import { useGetMessagesByConvoId } from '~/data-provider/Messages/queries';
import { useComposerRoute } from '~/Providers/ComposerRouteContext';
import useUpdateFiles from '~/hooks/Files/useUpdateFiles';
import { clearFileSearchChoices } from '~/utils/choices';
import PresentationWorkspace from '../Workspace';
import useResumablePane from '~/hooks/SSE/pane';
import ChatRouteOwner from '../Route';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getMessagesByConvoId: jest.fn(async () => []) },
  };
});
const mounts = jest.fn();
const unmounts = jest.fn();
const generation = jest.fn();
const newChat = jest.fn();
const identities = jest.fn();
let pane: ReturnType<typeof useResumablePane>['pane'];
let currentConversation: TConversation | null;
let pendingUpload: (id: string) => { complete: () => void; current: () => boolean };
let currentFiles = new Map<string, ExtendedFile>();
const uploadIds = new Set<string>();

function Controls() {
  const presentation = useFeaturePresentation()!;
  return (
    <>
      <button onClick={() => presentation.expand('agentBuilder')}>{'Expand'}</button>
      <button onClick={() => presentation.minimize('agentBuilder')}>{'Minimize'}</button>
    </>
  );
}
function Chat() {
  const { conversationId } = useParams();
  const location = useLocation();
  const [conversation, setConversation] = useState<TConversation | null>({
    conversationId: 'new',
    endpoint: null,
    title: null,
    createdAt: '',
    updatedAt: '',
  });
  currentConversation = conversation;
  const [files, setFiles] = useState(new Map<string, ExtendedFile>());
  currentFiles = files;
  const updates = useUpdateFiles(setFiles);
  pendingUpload = (id: string) => {
    const owner = captureComposerDraft(0, conversation?.conversationId ?? 'new');
    uploadIds.add(id);
    beginFileSearchUpload(id, captureFileSearchUpload(owner.conversationId(), owner));
    updates.addFile({ file_id: id, filename: id + '.txt', progress: 0.1, size: 1 }, owner);
    return {
      current: owner,
      complete: () => {
        completeFileSearchUpload(id, owner.conversationId());
        updates.updateFileById(id, { file_id: 'saved-' + id, progress: 1 }, false, owner);
      },
    };
  };

  const [run] = useState(() => new ResumableRun());
  pane = useResumablePane({
    run,
    runIndex: 0,
    isAddedRequest: false,
    setStreamId: jest.fn(),
    refreshBalance: jest.fn(),
    setIsSubmitting: jest.fn(),
    setConversation,
    newConversation: newChat,
    setGenerationEpoch: generation,
  }).pane;
  useGetMessagesByConvoId(conversationId ?? '');
  const readRoute = useComposerRoute();
  const route = readRoute();
  const host = useRef({});
  useEffect(
    () =>
      registerComposerDraft(
        0,
        conversation?.conversationId ?? 'new',
        'pending',
        host.current,
        readRoute,
      ),
    [conversation?.conversationId, readRoute, route],
  );
  useEffect(() => {
    mounts();
    return () => {
      unmounts();
    };
  }, []);
  useEffect(() => {
    identities(conversationId, location.pathname, location.search);
  }, [conversationId, location]);
  return <input aria-label="Live composer" defaultValue="unsent" />;
}
function setup(basename = '') {
  const navigation = resolveNavigation({ pages: { agentBuilder: { enabled: true } } });
  function Layout() {
    return (
      <FeaturePresentationProvider
        links={[{ id: 'agents', title: 'com_sidepanel_agent_builder', icon: () => null }]}
        features={{ agentBuilder: () => null }}
        navigation={navigation}
        onPanelOpen={jest.fn()}
      >
        <Controls />
        <PresentationWorkspace />
      </FeaturePresentationProvider>
    );
  }
  const source = '/c/new?projectId=project-a&branch=one';
  window.history.replaceState({}, '', basename + source);
  const router = createMemoryRouter(
    [
      {
        element: <Layout />,
        children: [
          {
            path: '/c/:conversationId',
            element: (
              <ChatRouteOwner>
                <Chat />
              </ChatRouteOwner>
            ),
          },
          { path: '/agent-builder', element: <div>{'Builder'}</div> },
        ],
      },
    ],
    { basename: basename || '/', initialEntries: [basename + source] },
  );
  const unsubscribe = router.subscribe(({ location }) =>
    window.history.replaceState({}, '', location.pathname + location.search),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <Provider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </Provider>,
  );
  const launch = { conversationId: 'new' };
  bindComposerLaunch(launch, 0);
  const owner = captureComposerDraft(0, 'new');
  const capturedPane = pane;
  act(() => capturedPane.setGenerationEpoch('new', null));
  beginFileSearchUpload('ack-upload', captureFileSearchUpload('new', owner));
  const acknowledge = () =>
    act(() => {
      expect(adoptComposerConversation(launch, 'assigned-chat', 0)).toBe(true);
      capturedPane.replaceNewConversationUrl('assigned-chat');
    });
  return {
    router,
    owner,
    acknowledge,
    capturedPane,
    source,
    cleanup: () => {
      cancelFileSearchUpload('ack-upload');
      uploadIds.forEach(cancelFileSearchUpload);
      uploadIds.clear();
      view.unmount();
      unsubscribe();
      client.clear();
      window.history.replaceState({}, '', '/');
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  clearFileSearchChoices();
});
it.each([
  ['before', ''],
  ['after', ''],
  ['before', '/app'],
  ['after', '/app'],
])(
  'minimizes an acknowledged first turn without FINAL (ack %s expansion, base %s)',
  async (when, basename) => {
    const state = setup(basename);
    try {
      const composer = screen.getByLabelText('Live composer');
      if (when === 'before') state.acknowledge();
      fireEvent.click(screen.getByText('Expand'));
      await waitFor(() =>
        expect(state.router.state.location.pathname).toBe(basename + '/agent-builder'),
      );
      if (when === 'after') state.acknowledge();
      expect(identities).toHaveBeenLastCalledWith(
        'new',
        '/c/new',
        '?projectId=project-a&branch=one',
      );
      expect(state.owner()).toBe(true);
      expect(state.owner.conversationId()).toBe('assigned-chat');
      expect(completeFileSearchUpload('ack-upload', 'assigned-chat')).toBe(true);
      expect(dataService.getMessagesByConvoId).not.toHaveBeenCalled();
      // CREATED may arrive after ACK; placement must not reconcile or restart the live first turn.
      act(() =>
        pane.setConversation?.(
          (previous) => previous && { ...previous, conversationId: 'assigned-chat' },
        ),
      );
      fireEvent.click(screen.getByText('Minimize'));
      await waitFor(() =>
        expect(state.router.state.location.pathname + state.router.state.location.search).toBe(
          basename + '/c/assigned-chat?projectId=project-a&branch=one',
        ),
      );
      expect(currentConversation?.conversationId).toBe('assigned-chat');
      expect(screen.getByLabelText('Live composer')).toBe(composer);
      expect(state.owner()).toBe(true);
      expect(dataService.getMessagesByConvoId).not.toHaveBeenCalled();
      expect(newChat).not.toHaveBeenCalled();
      expect(generation).toHaveBeenCalledTimes(1);
      expect(mounts).toHaveBeenCalledTimes(1);
      expect(unmounts).not.toHaveBeenCalled();
    } finally {
      state.cleanup();
    }
  },
);

it('can minimize before CREATED without reconciling or restarting the in-flight source', async () => {
  const state = setup();
  try {
    state.acknowledge();
    fireEvent.click(screen.getByText('Expand'));
    fireEvent.click(screen.getByText('Minimize'));
    await waitFor(() => expect(state.router.state.location.pathname).toBe('/c/assigned-chat'));
    expect(currentConversation?.conversationId).toBe('new');
    expect(identities).toHaveBeenLastCalledWith('new', '/c/new', '?projectId=project-a&branch=one');
    expect(dataService.getMessagesByConvoId).not.toHaveBeenCalled();
    expect(newChat).not.toHaveBeenCalled();
    act(() =>
      pane.setConversation?.(
        (previous) => previous && { ...previous, conversationId: 'assigned-chat' },
      ),
    );
    expect(dataService.getMessagesByConvoId).not.toHaveBeenCalled();
    expect(state.owner()).toBe(true);
  } finally {
    state.cleanup();
  }
});

it.each(['completed', 'aborted', 'error'] as const)(
  'commits the assigned route once the acknowledged run ends (%s), then permits retry and navigation',
  async (outcome) => {
    const state = setup('/app');
    try {
      const composer = screen.getByLabelText('Live composer');
      fireEvent.click(screen.getByText('Expand'));
      state.acknowledge();
      act(() =>
        pane.setConversation?.(
          (previous) => previous && { ...previous, conversationId: 'assigned-chat' },
        ),
      );
      fireEvent.click(screen.getByText('Minimize'));
      await waitFor(() =>
        expect(state.router.state.location.pathname).toBe('/app/c/assigned-chat'),
      );
      expect(dataService.getMessagesByConvoId).not.toHaveBeenCalled();
      act(() =>
        state.capturedPane.publishRunEnd({
          conversationId: 'assigned-chat',
          outcome,
          endedAt: Date.now(),
        }),
      );
      await waitFor(() =>
        expect(identities).toHaveBeenLastCalledWith(
          'assigned-chat',
          '/c/assigned-chat',
          '?projectId=project-a&branch=one',
        ),
      );
      await waitFor(() => expect(dataService.getMessagesByConvoId).toHaveBeenCalledTimes(1));
      expect(state.owner()).toBe(true);
      act(() => pane.renewActiveRun());
      fireEvent.click(screen.getByText('Expand'));
      fireEvent.click(screen.getByText('Minimize'));
      await waitFor(() =>
        expect(state.router.state.location.pathname).toBe('/app/c/assigned-chat'),
      );
      expect(screen.getByLabelText('Live composer')).toBe(composer);
      expect(dataService.getMessagesByConvoId).toHaveBeenCalledTimes(1);
      await act(async () => {
        await state.router.navigate('/c/other?projectId=project-b');
      });
      expect(state.owner()).toBe(false);
      act(() => state.capturedPane.replaceNewConversationUrl('stale-assignment'));
      expect(state.router.state.location.pathname).toBe('/app/c/other');
      expect(window.location.pathname).toBe('/app/c/other');
    } finally {
      state.cleanup();
    }
  },
);

it('fences a pending acknowledgement and upload immediately when the real chat changes', async () => {
  const state = setup();
  try {
    const callback = state.capturedPane.replaceNewConversationUrl;
    fireEvent.click(screen.getByText('Expand'));
    state.acknowledge();
    let navigation: Promise<void> | undefined;
    act(() => {
      navigation = state.router.navigate('/c/other');
      expect(state.owner()).toBe(false);
      callback('late-assignment');
    });
    await act(async () => {
      await navigation;
    });
    expect(window.location.pathname).toBe('/c/other');
    expect(completeFileSearchUpload('ack-upload', 'assigned-chat')).toBe(false);
    await act(async () => {
      await state.router.navigate('/c/new');
    });
    act(() => callback('stale-after-new-chat'));
    expect(window.location.pathname).toBe('/c/new');
    expect(identities).toHaveBeenLastCalledWith('new', '/c/new', '');
  } finally {
    state.cleanup();
  }
});

it('keeps the module-level browser replacement behavior without a presentation host', () => {
  window.history.replaceState({ preserved: true }, '', '/c/new?projectId=legacy');
  const { result, unmount } = renderHook(() =>
    useResumablePane({
      run: new ResumableRun(),
      runIndex: 2,
      isAddedRequest: false,
      setStreamId: jest.fn(),
      refreshBalance: jest.fn(),
      setIsSubmitting: jest.fn(),
      setConversation: jest.fn(),
      setGenerationEpoch: jest.fn(),
    }),
  );
  act(() => result.current.pane.replaceNewConversationUrl('legacy-id'));
  expect(window.location.pathname + window.location.search).toBe('/c/legacy-id?projectId=legacy');
  expect(window.history.state).toEqual({ preserved: true });
  act(() => result.current.pane.replaceNewConversationUrl('not-a-new-chat'));
  expect(window.location.pathname).toBe('/c/legacy-id');
  unmount();
  window.history.replaceState({}, '', '/');
});

it('returns to the source when an acknowledged first turn aborts before a saved conversation survives', async () => {
  const state = setup('/app');
  try {
    fireEvent.click(screen.getByText('Expand'));
    state.acknowledge();
    act(() =>
      state.capturedPane.publishRunEnd({
        conversationId: 'new',
        outcome: 'aborted',
        endedAt: Date.now(),
      }),
    );
    fireEvent.click(screen.getByText('Minimize'));
    await waitFor(() =>
      expect(state.router.state.location.pathname + state.router.state.location.search).toBe(
        '/app' + state.source,
      ),
    );
    expect(dataService.getMessagesByConvoId).not.toHaveBeenCalled();
    expect(newChat).not.toHaveBeenCalled();
  } finally {
    state.cleanup();
  }
});

it.each(['', '/app'])(
  'accepts the original pending POST acknowledgement after a presentation-only round trip (%s)',
  async (basename) => {
    const state = setup(basename);
    try {
      const composer = screen.getByLabelText('Live composer');
      fireEvent.click(screen.getByText('Expand'));
      fireEvent.click(screen.getByText('Minimize'));
      await waitFor(() => expect(state.router.state.location.pathname).toBe(basename + '/c/new'));
      state.acknowledge();
      expect(state.owner()).toBe(true);
      fireEvent.click(screen.getByText('Expand'));
      fireEvent.click(screen.getByText('Minimize'));
      await waitFor(() =>
        expect(state.router.state.location.pathname + state.router.state.location.search).toBe(
          basename + '/c/assigned-chat?projectId=project-a&branch=one',
        ),
      );
      expect(screen.getByLabelText('Live composer')).toBe(composer);
      expect(dataService.getMessagesByConvoId).not.toHaveBeenCalled();
      expect(state.owner()).toBe(true);
    } finally {
      state.cleanup();
    }
  },
);

it.each(['', '/app'])(
  'restores the actual source before unmasking an early abort after returning before CREATED (%s)',
  async (basename) => {
    const state = setup(basename);
    try {
      const composer = screen.getByLabelText('Live composer');
      state.acknowledge();
      fireEvent.click(screen.getByText('Expand'));
      fireEvent.click(screen.getByText('Minimize'));
      await waitFor(() =>
        expect(state.router.state.location.pathname).toBe(basename + '/c/assigned-chat'),
      );
      expect(currentConversation?.conversationId).toBe('new');
      act(() =>
        state.capturedPane.publishRunEnd({
          conversationId: 'new',
          outcome: 'aborted',
          endedAt: Date.now(),
        }),
      );
      await waitFor(() =>
        expect(state.router.state.location.pathname + state.router.state.location.search).toBe(
          basename + state.source,
        ),
      );
      expect(dataService.getMessagesByConvoId).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Live composer')).toBe(composer);
      expect(completeFileSearchUpload('ack-upload', 'assigned-chat')).toBe(false);
      const retryOwner = captureComposerDraft(0, 'new');
      expect(retryOwner()).toBe(true);
      expect(retryOwner.conversationId()).toBe('new');
    } finally {
      state.cleanup();
    }
  },
);

it.each(['foreground', 'hidden'])(
  'keeps assigned ownership through terminal error without a FINAL or prior Minimize (%s)',
  async (placement) => {
    const state = setup('/app');
    try {
      state.acknowledge();
      if (placement === 'hidden') fireEvent.click(screen.getByText('Expand'));
      act(() =>
        pane.setConversation?.(
          (previous) => previous && { ...previous, conversationId: 'assigned-chat' },
        ),
      );
      const uploadOwner = captureComposerDraft(0, 'assigned-chat');
      expect(uploadOwner()).toBe(true);
      act(() => {
        pane.publishRunEnd({
          conversationId: 'assigned-chat',
          outcome: 'error',
          endedAt: Date.now(),
        });
        expect(uploadOwner()).toBe(true);
      });
      await waitFor(() =>
        expect(identities).toHaveBeenLastCalledWith(
          'assigned-chat',
          '/c/assigned-chat',
          '?projectId=project-a&branch=one',
        ),
      );
      expect(uploadOwner()).toBe(true);
      expect(state.owner()).toBe(true);
      if (placement === 'hidden') {
        expect(state.router.state.location.pathname).toBe('/app/agent-builder');
        fireEvent.click(screen.getByText('Minimize'));
      }
      await waitFor(() =>
        expect(state.router.state.location.pathname).toBe('/app/c/assigned-chat'),
      );
    } finally {
      state.cleanup();
    }
  },
);

it.each(['foreground', 'hidden', 'returned'])(
  'completes an in-memory follow-up upload after terminal error (%s, draft saving off)',
  async (placement) => {
    const state = setup('/app');
    try {
      state.acknowledge();
      if (placement !== 'foreground') fireEvent.click(screen.getByText('Expand'));
      act(() =>
        pane.setConversation?.(
          (previous) => previous && { ...previous, conversationId: 'assigned-chat' },
        ),
      );
      if (placement === 'returned') fireEvent.click(screen.getByText('Minimize'));
      let upload!: ReturnType<typeof pendingUpload>;
      act(() => {
        upload = pendingUpload('follow-up');
      });
      expect(currentFiles.get('follow-up')?.progress).toBe(0.1);
      expect(getFilesDraft('assigned-chat').fileIds).toEqual([]);
      act(() => {
        pane.publishRunEnd({
          conversationId: 'assigned-chat',
          outcome: 'error',
          endedAt: Date.now(),
        });
        expect(upload.current()).toBe(true);
      });
      act(() => upload.complete());
      await waitFor(() =>
        expect(identities).toHaveBeenLastCalledWith(
          'assigned-chat',
          '/c/assigned-chat',
          '?projectId=project-a&branch=one',
        ),
      );
      expect(currentFiles.get('follow-up')).toMatchObject({
        file_id: 'saved-follow-up',
        progress: 1,
      });
      expect(upload.current()).toBe(true);
      if (placement === 'hidden') {
        expect(state.router.state.location.pathname).toBe('/app/agent-builder');
        fireEvent.click(screen.getByText('Minimize'));
      }
      await waitFor(() =>
        expect(state.router.state.location.pathname).toBe('/app/c/assigned-chat'),
      );
      expect(upload.current()).toBe(true);
      expect(getFilesDraft('assigned-chat').fileIds).toEqual([]);
    } finally {
      state.cleanup();
    }
  },
);

it('retires uploads with a discarded first-turn generation and accepts a fresh retry without creating a chat', async () => {
  const state = setup('/app');
  try {
    let oldUpload!: ReturnType<typeof pendingUpload>;
    act(() => {
      oldUpload = pendingUpload('before-abort');
    });
    state.acknowledge();
    fireEvent.click(screen.getByText('Expand'));
    fireEvent.click(screen.getByText('Minimize'));
    act(() =>
      pane.publishRunEnd({ conversationId: 'new', outcome: 'aborted', endedAt: Date.now() }),
    );
    await waitFor(() => expect(state.router.state.location.pathname).toBe('/app/c/new'));
    expect(oldUpload.current()).toBe(false);
    act(() => oldUpload.complete());
    expect(currentFiles.get('before-abort')?.progress).not.toBe(1);
    expect(dataService.getMessagesByConvoId).not.toHaveBeenCalled();
    act(() => {
      pane.setGenerationEpoch('new', null);
      const retry = { conversationId: 'new' };
      bindComposerLaunch(retry, 0);
      expect(adoptComposerConversation(retry, 'retry-chat', 0)).toBe(true);
      pane.replaceNewConversationUrl('retry-chat');
    });
    let retryUpload!: ReturnType<typeof pendingUpload>;
    act(() => {
      retryUpload = pendingUpload('retry-upload');
    });
    fireEvent.click(screen.getByText('Expand'));
    fireEvent.click(screen.getByText('Minimize'));
    await waitFor(() => expect(state.router.state.location.pathname).toBe('/app/c/retry-chat'));
    act(() => retryUpload.complete());
    expect(currentFiles.get('retry-upload')).toMatchObject({
      file_id: 'saved-retry-upload',
      progress: 1,
    });
    expect(newChat).not.toHaveBeenCalled();
  } finally {
    state.cleanup();
  }
});

it('ignores an old pending ACK after the new-chat generation changes before navigation commits', async () => {
  const state = setup();
  try {
    fireEvent.click(screen.getByText('Expand'));
    act(() => renewNewConversationDraftToken(0));
    act(() => state.capturedPane.replaceNewConversationUrl('retired-generation'));
    fireEvent.click(screen.getByText('Minimize'));
    await waitFor(() => expect(state.router.state.location.pathname).toBe('/c/new'));
    expect(state.owner()).toBe(false);
    expect(dataService.getMessagesByConvoId).not.toHaveBeenCalled();
  } finally {
    state.cleanup();
  }
});
