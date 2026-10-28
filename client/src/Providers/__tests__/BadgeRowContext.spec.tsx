import React, { useState } from 'react';
import { RecoilRoot } from 'recoil';
import { useForm } from 'react-hook-form';
import { render, act } from '@testing-library/react';
import { LocalStorageKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExtendedFile, ChatFormValues } from '~/common';
import { getFilesDraft, getComposerDraftId, getAskAnswerDraftId } from '~/utils/drafts';
import { beginFileSearchUpload, completeFileSearchUpload } from '~/hooks/Files/search';
import { getFileSearchChoice, clearFileSearchChoices } from '~/utils/choices';
import BadgeRowProvider, { useBadgeRowContext } from '../BadgeRowContext';
import { ChatFormProvider } from '~/Providers/ChatFormContext';
import { useAutoSave } from '~/hooks/Input/useAutoSave';
import { ephemeralAgentByConvoId } from '~/store';

/**
 * `BadgeRowProvider` is an inline child of `ChatForm`, which re-renders on every
 * keystroke in the composer. Its context value is memoized for exactly that
 * reason, but a memo is only worth as much as its dependencies, and two of them
 * were hooks handing back a fresh object literal every render. The value changed
 * on each character typed, and every consumer of it rebuilt: the palette's whole
 * tool, skill and MCP server catalog, per keystroke.
 */

/* Held outside the factory so it is one function for the whole test, the way
   the real `ToastProvider` sits above the composer and does not re-render with
   it. A fresh `showToast` per render would be the mock's instability, not the
   provider's. */
const mockShowToast = jest.fn();
jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

/* The suite-wide `react-i18next` stub builds a new `t` on every render, which
   the real one does not: it holds `t` in state and replaces it only when the
   language or namespace changes. Left as-is, every `useLocalize` consumer here
   would look unstable for a reason that does not exist outside the tests. */
const mockTranslate = (key: string) => key;
const mockToolAuth = { authenticated: false };
let mockCachedFiles: object[] = [];
jest.mock('react-i18next', () => ({
  ...jest.requireActual('react-i18next'),
  useTranslation: () => ({ t: mockTranslate, i18n: { changeLanguage: jest.fn() } }),
}));

/* Startup config and the server catalog are external HTTP queries. Their
   contents do not matter to this identity test, and leaving them live lets a
   rejected `/api/config` request report after Jest has torn the test down. */
jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useGetEndpointsQuery: () => ({ data: undefined }),
  useGetStartupConfig: () => ({ data: undefined }),
  useMCPServersQuery: () => ({ data: undefined, isLoading: false }),
  useVerifyAgentToolAuth: () => ({ data: mockToolAuth }),
  useGetFiles: () => ({ data: mockCachedFiles }),
}));

type DraftScope = { index?: number; isSubmitting?: boolean; draftId?: string };

function renderProvider(initialId = 'convo-badge-row', restoreDraft = false, initiallyOff = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: 0 } },
  });
  let value: ReturnType<typeof useBadgeRowContext>;
  const Consumer = () => {
    value = useBadgeRowContext();
    return null;
  };
  let scope: DraftScope = {};
  let stage: (file: ExtendedFile) => void = () => undefined;
  let restoredFiles = new Map<string, ExtendedFile>();
  function DraftOwner({ id }: { id: string }) {
    const [files, setFiles] = useState(new Map<string, ExtendedFile>());
    stage = (file) => setFiles(new Map([[file.file_id, file]]));
    restoredFiles = files;
    useAutoSave({ conversationId: id, files, setFiles, ...scope });
    return null;
  }
  function Form({ id }: { id: string }) {
    const methods = useForm<ChatFormValues>({ defaultValues: { text: '' } });
    return (
      <ChatFormProvider {...methods}>
        <DraftOwner id={id} />
      </ChatFormProvider>
    );
  }
  const Tree = ({ marker, id }: { marker: number; id: string }) => (
    <QueryClientProvider client={client}>
      <RecoilRoot
        initializeState={({ set }) => {
          if (initiallyOff) set(ephemeralAgentByConvoId(initialId), { file_search: false });
        }}
      >
        <BadgeRowProvider conversationId={id}>
          {/* Re-rendered along with the provider, the way `Bar` is. */}
          <span>{marker}</span>
          <Consumer />
          {restoreDraft && <Form id={id} />}
        </BadgeRowProvider>
      </RecoilRoot>
    </QueryClientProvider>
  );
  let id = initialId;
  const { rerender, unmount } = render(<Tree marker={0} id={id} />);
  return {
    getValue: () => value,
    unmount,
    retype: (marker: number) => rerender(<Tree marker={marker} id={id} />),
    navigate: (next: string, nextScope: DraftScope = {}) => {
      id = next;
      scope = nextScope;
      rerender(<Tree marker={0} id={id} />);
    },
    stage: (file: ExtendedFile) => stage(file),
    files: () => restoredFiles,
  };
}

describe('File Search deferred upload effects', () => {
  beforeEach(() => {
    localStorage.clear();
    clearFileSearchChoices();
    mockCachedFiles = [];
  });

  const file = (): ExtendedFile => ({
    file_id: 'pending-search',
    type: 'text/plain',
    progress: 0.2,
    size: 5,
    tool_resource: 'file_search',
  });
  const persisted = {
    file_id: 'server-search',
    temp_file_id: 'pending-search',
    filename: 'search.txt',
    filepath: '/files/search.txt',
    type: 'text/plain',
    bytes: 5,
    embedded: true,
    llmDeliveryPath: 'none',
  };

  it.each([
    ['passive', true, false],
    ['disable', false, true],
    ['disable-then-enable', true, true],
  ] as const)(
    'preserves explicit ordering through real navigation effects (%s)',
    async (action, enabled, sameMs) => {
      const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
      const view = renderProvider('origin', true, true);
      act(() => view.stage(file()));
      const toggle = view.getValue()?.fileSearch;
      if (!toggle) throw new Error('Missing real File Search toggle');
      const intent = beginFileSearchUpload('pending-search', 'origin');
      let resolveMutation: () => void = () => undefined;
      let activated = false;
      const mutation = new Promise<void>((resolve) => {
        resolveMutation = resolve;
      });
      const completion = mutation.then(() => {
        activated = completeFileSearchUpload(
          'pending-search',
          'origin',
          intent.persisted ? undefined : intent.choiceRevision,
        );
        if (activated) toggle.setEphemeralAgent((previous) => ({ ...previous, file_search: true }));
      });
      if (!sameMs) clock.mockReturnValue(2000);
      act(() => view.navigate('new'));
      if (!sameMs) clock.mockReturnValue(3000);
      act(() => view.navigate('origin'));
      expect(localStorage.getItem(`${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}origin`)).toBe(
        'false',
      );
      expect(getFileSearchChoice('origin')).toBeNull();
      if (action !== 'passive')
        act(() => view.getValue()?.fileSearch.handleChange({ value: false }));
      if (action === 'disable-then-enable')
        act(() => view.getValue()?.fileSearch.handleChange({ value: true }));
      await act(async () => {
        resolveMutation();
        await completion;
      });
      expect(activated).toBe(enabled);
      expect(view.getValue()?.fileSearch.isToolEnabled).toBe(enabled);
      mockCachedFiles = [persisted];
      act(() => view.retype(1));
      expect(view.files().get('pending-search')?.file_id).toBe('server-search');
      act(() => view.navigate('new'));
      act(() => view.navigate('origin'));
      expect(view.getValue()?.fileSearch.isToolEnabled).toBe(enabled);
      view.unmount();
      const reloaded = renderProvider('origin', true);
      expect(reloaded.getValue()?.fileSearch.isToolEnabled).toBe(enabled);
      reloaded.unmount();
      clock.mockRestore();
    },
  );

  it.each<{ owner: string; scope: DraftScope }>([
    { owner: 'origin', scope: {} },
    { owner: 'origin', scope: { isSubmitting: true } },
    { owner: 'new', scope: { index: 1 } },
    { owner: 'origin', scope: { draftId: getAskAnswerDraftId('question') } },
  ])('keeps draft ownership across repeated navigation (%j)', ({ owner, scope }) => {
    const view = renderProvider(owner, true, true);
    act(() => view.navigate(owner, scope));
    const draftId =
      scope.draftId ?? getComposerDraftId(scope.index ?? 0, owner, scope.isSubmitting ?? false);
    act(() => view.stage(file()));
    beginFileSearchUpload('pending-search', owner);
    for (let visit = 0; visit < 3; visit++) {
      act(() => view.navigate('away'));
      expect(getFilesDraft(draftId).fileIds).toContain('pending-search');
      expect(getFilesDraft('away').fileIds).not.toContain('pending-search');
      act(() => view.navigate(owner, scope));
      expect(getFilesDraft(draftId).fileIds).toContain('pending-search');
    }
    mockCachedFiles = [persisted];
    act(() => view.retype(1));
    expect(view.files().get('pending-search')?.file_id).toBe('server-search');
    expect(view.getValue()?.fileSearch.isToolEnabled).toBe(true);
    view.unmount();
  });

  it('honors an explicit disable when intent storage is unavailable', () => {
    const view = renderProvider('origin', false, true);
    const write = Storage.prototype.setItem;
    const unavailable = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key.startsWith('file-search-upload:') || key.startsWith('file-search-choice:')) {
        throw new Error('Storage unavailable');
      }
      write.call(this, key, value);
    });
    const intent = beginFileSearchUpload('pending-search', 'origin');
    expect(intent.persisted).toBe(false);
    act(() => view.getValue()?.fileSearch.handleChange({ value: false }));
    expect(completeFileSearchUpload('pending-search', 'origin', intent.choiceRevision)).toBe(false);
    unavailable.mockRestore();
    view.unmount();
  });

  it('restores a pending explicit intent after reload without a surviving mutation callback', () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const first = renderProvider('origin', true, true);
    act(() => first.stage(file()));
    beginFileSearchUpload('pending-search', 'origin');
    act(() => first.navigate('new'));
    first.unmount();
    clock.mockReturnValue(2000);
    mockCachedFiles = [persisted];
    const reloaded = renderProvider('origin', true);
    expect(reloaded.files().get('pending-search')?.file_id).toBe('server-search');
    expect(reloaded.getValue()?.fileSearch.isToolEnabled).toBe(true);
    reloaded.unmount();
    clock.mockRestore();
  });
});

describe('BadgeRowProvider', () => {
  it('recovers completed explicit uploads on reload without overriding a later disable', () => {
    localStorage.clear();
    beginFileSearchUpload('upload-id', 'convo-badge-row');
    expect(completeFileSearchUpload('upload-id', 'convo-badge-row')).toBe(true);
    const first = renderProvider();
    expect(first.getValue()?.fileSearch.isToolEnabled).toBe(true);
    act(() => first.getValue()?.fileSearch.setToggleState(false));
    first.unmount();
    const reloaded = renderProvider();
    expect(reloaded.getValue()?.fileSearch.isToolEnabled).toBe(false);
    reloaded.unmount();
    localStorage.clear();
  });

  it('hands consumers the same value across a parent re-render', () => {
    const { getValue, retype } = renderProvider();
    const first = getValue();
    retype(1);
    expect(getValue()).toBe(first);
    retype(2);
    expect(getValue()).toBe(first);
  });

  /* The two that were rebuilding: both are carried into the context value
     whole, so an unstable reference from either defeats the memo by itself. */
  it('keeps the search form and MCP manager referentially stable', () => {
    const { getValue, retype } = renderProvider();
    const first = getValue();
    retype(1);

    const last = getValue();
    expect(last?.searchApiKeyForm).toBe(first?.searchApiKeyForm);
    expect(last?.mcpServerManager).toBe(first?.mcpServerManager);
  });

  /* Without this the cases above would still pass against a provider that had
     stopped providing: every value would be `undefined`, and identical. */
  it('is undefined outside the provider, and an object inside it', () => {
    let outside: unknown = 'unset';
    const Consumer = () => {
      outside = useBadgeRowContext();
      return null;
    };
    render(<Consumer />);
    expect(outside).toBeUndefined();

    const { getValue } = renderProvider();
    expect(getValue()).toEqual(expect.objectContaining({ conversationId: 'convo-badge-row' }));
  });
});
