/**
 * Coverage for `useAttachmentPreviewSync` — the bridge between the
 * deferred-preview code-execution lifecycle and the attachment cache.
 *
 * Behavior under test:
 *   1. Polling enables only when `attachment.status === 'pending'` AND
 *      some conversation is submitting (per the user's explicit gate).
 *   2. On a terminal poll response (ready/failed), the resolved record
 *      is upserted into `messageAttachmentsMap` by `file_id`.
 *   3. The hook's returned `status` reflects the polled value once
 *      it arrives, not just the prop snapshot.
 *
 * The underlying `useFilePreview` hook is mocked here — its own
 * polling cadence and refetchInterval semantics are React Query's
 * concern, not this hook's.
 */

import { useEffect } from 'react';
import { Tools } from 'librechat-data-provider';
import { renderHook } from '@testing-library/react';
import { RecoilRoot, useRecoilValue, useSetRecoilState } from 'recoil';
import type {
  TAttachment,
  TFile,
  TAttachmentMetadata,
  TFilePreview,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { MessageContext } from '~/Providers/MessageContext';
import store from '~/store';

type AttachmentFixture = TFile & TAttachmentMetadata;

const mockUseFilePreview = jest.fn();
jest.mock('~/data-provider', () => ({
  useFilePreview: (...args: unknown[]) => mockUseFilePreview(...args),
}));

import useAttachmentPreviewSync from '../useAttachmentPreviewSync';

const wrapper = ({ children }: { children: ReactNode }) => <RecoilRoot>{children}</RecoilRoot>;

const messageId = 'msg-1';
const fileId = 'fid-1';

function makeAttachment(overrides: Partial<AttachmentFixture> = {}): AttachmentFixture {
  return {
    user: 'user-1',
    object: 'file',
    bytes: 1024,
    embedded: false,
    usage: 0,
    file_id: fileId,
    filename: 'data.xlsx',
    filepath: '/uploads/data.xlsx',
    type: Tools.execute_code,
    messageId,
    toolCallId: 'tc-1',
    text: undefined,
    textFormat: undefined,
    status: 'pending',
    ...overrides,
  };
}

/** Read messageAttachmentsMap and bridge it out via a mutable ref. */
function setup({
  attachment,
  isSubmitting,
  preview,
  isFetching = false,
  seedLiveMap = true,
  seedEntries,
}: {
  attachment: TAttachment;
  isSubmitting: boolean;
  preview?: TFilePreview;
  isFetching?: boolean;
  /* When false, simulates a loaded conversation: the message's
   * attachments come from the DB but `messageAttachmentsMap[messageId]`
   * is empty (no SSE handler ever fired for this messageId). The
   * upsert must INSERT (not just update) the resolved record into the
   * live map so the parent's `useAttachments` merge picks it up. */
  seedLiveMap?: boolean;
  /* Overrides the seeded live entries (defaults to `[attachment]`) —
   * used to simulate sibling tool calls sharing the same file_id. */
  seedEntries?: TAttachment[];
}) {
  mockUseFilePreview.mockReset();
  mockUseFilePreview.mockReturnValue({ data: preview, isFetching });
  const ref: { current: Record<string, TAttachment[] | undefined> } = { current: {} };
  let lastEnabled: boolean | undefined;
  /* Spy on the second arg of useFilePreview to assert the gate. */
  mockUseFilePreview.mockImplementation((_id: unknown, opts: { enabled?: boolean }) => {
    lastEnabled = opts?.enabled;
    return { data: preview, isFetching };
  });

  const Bridge = () => {
    /* Seed the messageAttachmentsMap with the test attachment so the
     * hook's upsert path has something to find. Also expose setters
     * for tests that simulate `isAnySubmitting` toggling — the
     * selector reads `conversationKeysAtom` × `isSubmittingFamily(key)`
     * so we have to populate both for the selector to fire. */
    const setMap = useSetRecoilState(store.messageAttachmentsMap);
    const setKeys = useSetRecoilState(store.conversationKeysAtom);
    const setSubmitting = useSetRecoilState(store.isSubmittingFamily(0));
    useEffect(() => {
      if (seedLiveMap) {
        setMap({ [messageId]: seedEntries ?? [attachment] });
      }
      setKeys([0]);
      setSubmitting(isSubmitting);
    }, [setMap, setKeys, setSubmitting]);
    const map = useRecoilValue(store.messageAttachmentsMap);
    ref.current = map;
    return null;
  };

  const { result } = renderHook(
    () => {
      return useAttachmentPreviewSync(attachment);
    },
    {
      wrapper: ({ children }: { children: ReactNode }) =>
        wrapper({
          children: (
            <>
              <Bridge />
              <MessageContext.Provider value={{ messageId, isExpanded: true, isSubmitting }}>
                {children}
              </MessageContext.Provider>
            </>
          ),
        }),
    },
  );

  return {
    result,
    get map() {
      return ref.current;
    },
    get enabled() {
      return lastEnabled;
    },
  };
}

/**
 * Render the hook with controllable preview output (so a test can
 * trigger the pending→ready edge by re-rendering with a new value)
 * AND expose a snapshot read of the per-file_id `previewJustResolved`
 * flag so the test can assert the hook flipped it on the edge.
 *
 * `isSubmittingAtMount` seeds `isSubmittingFamily(0)` *before* the hook
 * runs (via `initializeState`) so the hook's mount-time snapshot read
 * captures the intended value. Setting it after mount via a child
 * effect would race with the hook's first render and the gate would
 * see the default (`false`), defeating the whole point of the test.
 */
function setupWithTransitions(
  initialPreview?: TFilePreview,
  {
    isSubmittingAtMount = true,
    messageIsSubmittingAtMount = isSubmittingAtMount,
  }: { isSubmittingAtMount?: boolean; messageIsSubmittingAtMount?: boolean } = {},
) {
  let currentPreview = initialPreview;
  mockUseFilePreview.mockReset();
  mockUseFilePreview.mockImplementation(() => ({
    data: currentPreview,
    isFetching: false,
  }));

  const flagRef: { current: boolean | undefined } = { current: undefined };
  const FlagProbe = ({ id }: { id: string }) => {
    /* Subscribing read — re-renders the probe whenever the flag flips,
     * so `flagRef.current` is updated after the consumer hook commits
     * the transition. (A non-subscribing snapshot read inside an
     * effect would capture the value as of the previous commit, which
     * misses the flag set fired in *this* render's effect tick.) */
    const flag = useRecoilValue(store.previewJustResolved([messageId, id]));
    useEffect(() => {
      flagRef.current = flag;
    }, [flag]);
    return null;
  };

  const { rerender } = renderHook(
    ({ attachment }: { attachment: TAttachment }) => useAttachmentPreviewSync(attachment),
    {
      initialProps: { attachment: makeAttachment({ status: 'pending' }) },
      wrapper: ({ children }: { children: ReactNode }) => (
        <RecoilRoot
          initializeState={(snap) => {
            snap.set(store.isSubmittingFamily(0), isSubmittingAtMount);
          }}
        >
          <FlagProbe id={fileId} />
          <MessageContext.Provider
            value={{ messageId, isExpanded: true, isSubmitting: messageIsSubmittingAtMount }}
          >
            {children}
          </MessageContext.Provider>
        </RecoilRoot>
      ),
    },
  );

  return {
    setPreview: (preview: TFilePreview | undefined) => {
      currentPreview = preview;
      rerender({ attachment: makeAttachment({ status: 'pending' }) });
    },
    get justResolved() {
      return flagRef.current;
    },
  };
}

describe('useAttachmentPreviewSync', () => {
  it('enables polling whenever status=pending (no longer gated on isSubmitting)', () => {
    const ctx = setup({
      attachment: makeAttachment({ status: 'pending' }),
      isSubmitting: true,
    });
    expect(ctx.enabled).toBe(true);
  });

  it('does NOT enable polling when status is already ready', () => {
    const ctx = setup({
      attachment: makeAttachment({ status: 'ready' }),
      isSubmitting: true,
    });
    expect(ctx.enabled).toBe(false);
  });

  it('does NOT enable polling when status is already failed', () => {
    const ctx = setup({
      attachment: makeAttachment({ status: 'failed', previewError: 'timeout' }),
      isSubmitting: true,
    });
    expect(ctx.enabled).toBe(false);
  });

  it('STILL enables polling for pending records even after the LLM has finished generating', () => {
    /* Regression for the stuck-spinner bug: the deferred render can
     * complete a few seconds AFTER the SSE stream closes. With the
     * earlier `isAnySubmitting` gate, polling stopped the moment the
     * model finished and the resolved-but-not-yet-emitted state would
     * never reach the UI. Polling now runs on `status === 'pending'`
     * alone; `useFilePreview`'s `refetchInterval` auto-stops on the
     * first terminal response, and the server-side render ceiling +
     * lazy sweep cap the worst case. */
    const ctx = setup({
      attachment: makeAttachment({ status: 'pending' }),
      isSubmitting: false,
    });
    expect(ctx.enabled).toBe(true);
  });

  it('does NOT enable polling when the attachment has no file_id', () => {
    const noId = { ...makeAttachment({ status: 'pending' }) } as Partial<TAttachment>;
    delete (noId as { file_id?: string }).file_id;
    const ctx = setup({
      attachment: noId as TAttachment,
      isSubmitting: true,
    });
    expect(ctx.enabled).toBe(false);
  });

  it('returns ready when no preview and no status (legacy back-compat)', () => {
    const legacy = makeAttachment();
    delete (legacy as Partial<TAttachment & { status?: string }>).status;
    const ctx = setup({ attachment: legacy as TAttachment, isSubmitting: false });
    expect(ctx.result.current.status).toBe('ready');
  });

  it('upserts the resolved preview into messageAttachmentsMap when preview reports ready', () => {
    const ctx = setup({
      attachment: makeAttachment({ status: 'pending' }),
      isSubmitting: true,
      preview: {
        file_id: fileId,
        status: 'ready',
        text: '<table>final</table>',
        textFormat: 'html',
      },
    });
    const updated = ctx.map[messageId]?.[0] as AttachmentFixture;
    expect(updated.status).toBe('ready');
    expect(updated.text).toBe('<table>final</table>');
    expect(ctx.result.current.status).toBe('ready');
  });

  it('upserts the resolved preview when preview reports failed (with previewError)', () => {
    const ctx = setup({
      attachment: makeAttachment({ status: 'pending' }),
      isSubmitting: true,
      preview: {
        file_id: fileId,
        status: 'failed',
        previewError: 'parser-error',
      },
    });
    const updated = ctx.map[messageId]?.[0] as AttachmentFixture;
    expect(updated.status).toBe('failed');
    expect(updated.previewError).toBe('parser-error');
    expect(ctx.result.current.status).toBe('failed');
    expect(ctx.result.current.previewError).toBe('parser-error');
  });

  it('fans the resolved preview out to EVERY sibling entry sharing the file_id', () => {
    const first = makeAttachment({ status: 'pending', toolCallId: 'tc-1' });
    const sibling = makeAttachment({ status: 'pending', toolCallId: 'tc-2' });
    const other = makeAttachment({ file_id: 'fid-other', status: 'pending', toolCallId: 'tc-3' });
    const ctx = setup({
      attachment: first,
      isSubmitting: true,
      seedEntries: [first, sibling, other],
      preview: {
        file_id: fileId,
        status: 'ready',
        text: '<table>final</table>',
        textFormat: 'html',
      },
    });
    const list = (ctx.map[messageId] ?? []) as AttachmentFixture[];
    expect(list).toHaveLength(3);
    expect(list[0].status).toBe('ready');
    expect(list[0].text).toBe('<table>final</table>');
    expect(list[1].status).toBe('ready');
    expect(list[1].text).toBe('<table>final</table>');
    expect(list[1].toolCallId).toBe('tc-2');
    expect(list[2].status).toBe('pending');
    expect(list[2].text).toBeUndefined();
  });

  it('does NOT upsert while the polled status is still pending', () => {
    const ctx = setup({
      attachment: makeAttachment({ status: 'pending' }),
      isSubmitting: true,
      preview: { file_id: fileId, status: 'pending' },
    });
    /* Map should be unchanged from the initial seed — no patch. */
    const list = ctx.map[messageId] ?? [];
    expect(list).toHaveLength(1);
    expect((list[0] as AttachmentFixture).status).toBe('pending');
  });

  it('reports isPolling true when the query is fetching and the gate is open', () => {
    const ctx = setup({
      attachment: makeAttachment({ status: 'pending' }),
      isSubmitting: true,
      isFetching: true,
    });
    expect(ctx.result.current.isPolling).toBe(true);
  });

  it('reports isPolling false when the query is not fetching', () => {
    const ctx = setup({
      attachment: makeAttachment({ status: 'pending' }),
      isSubmitting: true,
      isFetching: false,
    });
    expect(ctx.result.current.isPolling).toBe(false);
  });

  it('INSERTS a new live entry when messageAttachmentsMap has no record for this file_id (loaded-conversation path)', () => {
    /* Regression for the "DB-frozen pending" bug: on a reloaded
     * conversation, messages come back from the DB with the
     * immediate-persist snapshot (`status: 'pending'`) and there is no
     * SSE handler running for the historical messageId — so
     * `messageAttachmentsMap[messageId]` is empty. The polling layer
     * must INSERT a new entry (not just update an existing one) so the
     * parent's `useAttachments` merge can overlay the resolved
     * lifecycle fields onto the DB attachment by file_id. */
    const ctx = setup({
      attachment: makeAttachment({ status: 'pending' }),
      isSubmitting: false,
      seedLiveMap: false,
      preview: {
        file_id: fileId,
        status: 'ready',
        text: '<table>resolved-on-reload</table>',
        textFormat: 'html',
      },
    });
    const list = ctx.map[messageId] ?? [];
    expect(list).toHaveLength(1);
    const inserted = list[0] as AttachmentFixture;
    expect(inserted.file_id).toBe(fileId);
    expect(inserted.status).toBe('ready');
    expect(inserted.text).toBe('<table>resolved-on-reload</table>');
    expect(inserted.textFormat).toBe('html');
    /* The inserted entry must carry forward the original attachment's
     * non-lifecycle fields (filename, type, messageId, toolCallId) so
     * the renderer can still classify it correctly. */
    expect(inserted.filename).toBe('data.xlsx');
    expect(inserted.messageId).toBe(messageId);
  });

  it('INSERTS a failed entry on a loaded conversation when polling reports failed', () => {
    const ctx = setup({
      attachment: makeAttachment({ status: 'pending' }),
      isSubmitting: false,
      seedLiveMap: false,
      preview: {
        file_id: fileId,
        status: 'failed',
        previewError: 'render-timeout',
      },
    });
    const list = ctx.map[messageId] ?? [];
    expect(list).toHaveLength(1);
    const inserted = list[0] as AttachmentFixture;
    expect(inserted.status).toBe('failed');
    expect(inserted.previewError).toBe('render-timeout');
  });

  describe('previewJustResolved signal (auto-open trigger)', () => {
    /* The signal is the bridge to ToolArtifactCard's auto-open path:
     * the card mounts after the routing re-runs (post-transition), so
     * it can't observe the transition itself. Setting a one-shot flag
     * keyed by message and file lets only the owner consume the signal
     * on its first effect tick. We assert on the flag directly here; the
     * consume+open behavior lives in `ToolArtifactCard`'s coverage. */
    it('flips the owning message and file flag on the pending→ready transition', () => {
      const ctx = setupWithTransitions({ file_id: fileId, status: 'pending' });
      expect(ctx.justResolved).toBe(false);
      ctx.setPreview({
        file_id: fileId,
        status: 'ready',
        text: '<table>x</table>',
        textFormat: 'html',
      });
      expect(ctx.justResolved).toBe(true);
    });

    it('does not flag a previous response preview as newly resolved during regeneration', () => {
      const ctx = setupWithTransitions(
        { file_id: fileId, status: 'pending' },
        { isSubmittingAtMount: true, messageIsSubmittingAtMount: false },
      );
      ctx.setPreview({
        file_id: fileId,
        status: 'ready',
        text: '<table>old response</table>',
        textFormat: 'html',
      });
      expect(ctx.justResolved).toBe(false);
    });

    it('reclassifies a reused pending file when its owning response changes to the live one', () => {
      let preview: TFilePreview | undefined = { file_id: fileId, status: 'pending' };
      let owner = 'historical-response';
      let isSubmitting = false;
      mockUseFilePreview.mockReset();
      mockUseFilePreview.mockImplementation(() => ({ data: preview, isFetching: false }));

      const flags = { live: false, history: false };
      const FlagProbe = () => {
        flags.live = useRecoilValue(store.previewJustResolved(['live-response', fileId]));
        flags.history = useRecoilValue(store.previewJustResolved(['historical-response', fileId]));
        return null;
      };
      const { rerender } = renderHook(
        ({ attachment }: { attachment: TAttachment }) => useAttachmentPreviewSync(attachment),
        {
          initialProps: { attachment: makeAttachment({ messageId: owner }) },
          wrapper: ({ children }: { children: ReactNode }) => (
            <RecoilRoot>
              <FlagProbe />
              <MessageContext.Provider value={{ messageId: owner, isExpanded: true, isSubmitting }}>
                {children}
              </MessageContext.Provider>
            </RecoilRoot>
          ),
        },
      );
      owner = 'live-response';
      isSubmitting = true;
      rerender({ attachment: makeAttachment({ messageId: owner }) });
      preview = {
        file_id: fileId,
        status: 'ready',
        text: '<table>new answer</table>',
        textFormat: 'html',
      };
      rerender({ attachment: makeAttachment({ messageId: owner }) });
      expect(flags.live).toBe(true);
      expect(flags.history).toBe(false);
    });

    it('does not flag a live file that becomes history before its preview resolves', () => {
      let preview: TFilePreview | undefined = { file_id: fileId, status: 'pending' };
      let owner = 'live-response';
      let isSubmitting = true;
      mockUseFilePreview.mockReset();
      mockUseFilePreview.mockImplementation(() => ({ data: preview, isFetching: false }));

      let historyFlag = false;
      const FlagProbe = () => {
        historyFlag = useRecoilValue(store.previewJustResolved(['historical-response', fileId]));
        return null;
      };
      const { rerender } = renderHook(
        ({ attachment }: { attachment: TAttachment }) => useAttachmentPreviewSync(attachment),
        {
          initialProps: { attachment: makeAttachment({ messageId: owner }) },
          wrapper: ({ children }: { children: ReactNode }) => (
            <RecoilRoot>
              <FlagProbe />
              <MessageContext.Provider value={{ messageId: owner, isExpanded: true, isSubmitting }}>
                {children}
              </MessageContext.Provider>
            </RecoilRoot>
          ),
        },
      );
      owner = 'historical-response';
      isSubmitting = false;
      rerender({ attachment: makeAttachment({ messageId: owner }) });
      preview = {
        file_id: fileId,
        status: 'ready',
        text: '<table>old answer</table>',
        textFormat: 'html',
      };
      rerender({ attachment: makeAttachment({ messageId: owner }) });
      expect(historyFlag).toBe(false);
    });

    it('does NOT flip the flag when the polled status is "failed"', () => {
      /* Failed previews stay as a download-only chip — nothing to
       * auto-open. The signal must stay false so the eventual
       * routing decision (PreviewPlaceholderCard with the alert
       * subtitle) doesn't get hijacked into opening an empty panel. */
      const ctx = setupWithTransitions({ file_id: fileId, status: 'pending' });
      ctx.setPreview({
        file_id: fileId,
        status: 'failed',
        previewError: 'render-timeout',
      });
      expect(ctx.justResolved).toBe(false);
    });

    it('does NOT flip the flag when the first observed status is already "ready" (history load)', () => {
      /* A page-load mount where the file resolved long ago must not
       * trigger auto-open — the user is scrolling through history,
       * not awaiting a result. Without this guard, every loaded
       * conversation would yank the panel open on first paint. */
      const ctx = setupWithTransitions({
        file_id: fileId,
        status: 'ready',
        text: '<table>x</table>',
        textFormat: 'html',
      });
      expect(ctx.justResolved).toBe(false);
    });

    it('does NOT flip the flag on a navigation-time pending→ready (hook mounted with isSubmitting=false)', () => {
      /* Regression for the "panel auto-opens on every revisit" bug:
       * the immediate-persist snapshot saves the message's attachment
       * at `status: 'pending'`, which never gets rewritten when the
       * file record itself transitions to `'ready'`. When the user
       * navigates back, the hook mounts with `isSubmitting=false`,
       * polls once, and sees a pending→ready transition — but this
       * is NOT a fresh resolution from the user's perspective, just
       * polling catching up to long-resolved data. The
       * `mountedDuringStreamRef` gate must drop this transition on
       * the floor so the panel stays closed. The pre-PR commit
       * history explicitly removed history-load auto-open; this
       * preserves that contract. */
      const ctx = setupWithTransitions(
        { file_id: fileId, status: 'pending' },
        { isSubmittingAtMount: false },
      );
      ctx.setPreview({
        file_id: fileId,
        status: 'ready',
        text: '<table>resolved-on-revisit</table>',
        textFormat: 'html',
      });
      expect(ctx.justResolved).toBe(false);
    });
  });
});
