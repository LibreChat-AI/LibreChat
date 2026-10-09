/**
 * Coverage for the upsert-by-file_id behavior in `useAttachmentHandler`.
 *
 * Deferred-preview code-execution flow: the immediate persist step
 * emits an attachment with `status: 'pending'`; the deferred render
 * emits the same `file_id` again with `status: 'ready'` (and
 * resolved `text`/`textFormat`) or `'failed'` (with `previewError`).
 * The handler MUST merge over the pending placeholder in place —
 * appending would render the artifact twice in the UI (once stuck
 * pending, once resolved).
 *
 * Lightweight attachments without a `file_id` (web_search citations,
 * file_search results) keep the legacy append-only behavior so two
 * unrelated citations both show up.
 */

import { Tools } from 'librechat-data-provider';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { QueryClient } from '@tanstack/react-query';
import { renderHook, act } from '@testing-library/react';
import type {
  TFile,
  TAttachment,
  EventSubmission,
  TAttachmentMetadata,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
import useAttachmentHandler from '../useAttachmentHandler';
import store from '~/store';

type AttachmentFixture = TFile & TAttachmentMetadata;

const wrapper = ({ children }: { children: ReactNode }) => <RecoilRoot>{children}</RecoilRoot>;

const submission = {} as EventSubmission;
const messageId = 'msg-1';

function makeAttachment(overrides: Partial<AttachmentFixture>): AttachmentFixture {
  return {
    user: 'user-1',
    object: 'file',
    bytes: 1024,
    embedded: false,
    usage: 0,
    file_id: 'fid-1',
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

/* Co-mount the handler and a reader of the messageAttachmentsMap atom in
 * the same RecoilRoot so each act() shows the post-write state. The
 * `attachmentsMap` ref is mutated by the reader on every render, so
 * callers read it after their `act()` to assert.
 *
 * Also exposes the underlying `queryClient` so tests can spy on
 * `removeQueries` for the deferred-preview cache-staleness fix
 * (Codex P1 review on PR #12957; round 3 swapped invalidate→remove). */
function setup() {
  const queryClient = new QueryClient();
  const removeSpy = jest.spyOn(queryClient, 'removeQueries');
  const ref: { current: Record<string, TAttachment[] | undefined> } = { current: {} };
  const { result } = renderHook(
    () => {
      const handler = useAttachmentHandler(queryClient);
      const map = useRecoilValue(store.messageAttachmentsMap);
      ref.current = map;
      return handler;
    },
    { wrapper },
  );
  return {
    handle: (data: TAttachment) => act(() => result.current({ data, submission })),
    get list(): TAttachment[] {
      return ref.current[messageId] ?? [];
    },
    removeSpy,
  };
}

describe('useAttachmentHandler upsert-by-file_id', () => {
  it('appends a new attachment when no record with the same file_id exists', () => {
    const ctx = setup();
    ctx.handle(makeAttachment({ status: 'pending' }));
    expect(ctx.list).toHaveLength(1);
    expect(ctx.list[0]).toMatchObject({ file_id: 'fid-1', status: 'pending' });
  });

  it('upserts in place when a second event arrives for the same file_id (initial pending → deferred ready)', () => {
    const ctx = setup();
    ctx.handle(makeAttachment({ status: 'pending' }));
    ctx.handle(makeAttachment({ status: 'ready', text: '<table></table>', textFormat: 'html' }));
    /* Critical: still ONE attachment, not two. The deferred update
     * patches the pending record in place. */
    expect(ctx.list).toHaveLength(1);
    expect(ctx.list[0]).toMatchObject({
      file_id: 'fid-1',
      status: 'ready',
      text: '<table></table>',
      textFormat: 'html',
    });
  });

  it('upserts a failed deferred update over the pending placeholder', () => {
    const ctx = setup();
    ctx.handle(makeAttachment({ status: 'pending' }));
    ctx.handle(makeAttachment({ status: 'failed', previewError: 'timeout' }));
    expect(ctx.list).toHaveLength(1);
    expect(ctx.list[0]).toMatchObject({ status: 'failed', previewError: 'timeout' });
  });

  it('keeps multiple distinct file_ids as separate entries', () => {
    const ctx = setup();
    ctx.handle(makeAttachment({ file_id: 'fid-A' }));
    ctx.handle(makeAttachment({ file_id: 'fid-B' }));
    expect(ctx.list).toHaveLength(2);
    expect(ctx.list.map((a) => (a as { file_id: string }).file_id).sort()).toEqual([
      'fid-A',
      'fid-B',
    ]);
  });

  it('appends (does NOT merge) citation attachments with no file_id', () => {
    /* Lightweight attachments like file_search citations don't carry file_id.
     * The handler must keep its legacy append behavior for them: merging
     * would lose distinct citations and is unnecessary because they're never
     * the target of a deferred preview update. */
    const ctx = setup();
    const noFileId = {
      messageId,
      toolCallId: 'tc-1',
      type: Tools.file_search,
    } as unknown as TAttachment;
    ctx.handle(noFileId);
    ctx.handle(noFileId);
    expect(ctx.list).toHaveLength(2);
  });

  it('replaces a re-emitted web-search snapshot instead of stacking it', () => {
    /* The search helper rewrites and re-emits the WHOLE payload after every
     * highlight update, keeping the same toolCallId and turn. Appending those
     * stacked one copy of every image, product and place per update. */
    const ctx = setup();
    const snapshot = (processed: boolean) =>
      ({
        messageId,
        toolCallId: 'tc-1',
        type: Tools.web_search,
        [Tools.web_search]: { turn: 0, organic: [{ link: 'https://example.com', processed }] },
      }) as unknown as TAttachment;

    ctx.handle(snapshot(false));
    ctx.handle(snapshot(true));

    expect(ctx.list).toHaveLength(1);
    expect(
      (ctx.list[0] as unknown as { web_search: { organic: Array<{ processed: boolean }> } })
        .web_search.organic[0].processed,
    ).toBe(true);
  });

  it('keeps web-search snapshots from distinct tool calls separate', () => {
    const ctx = setup();
    const snapshot = (toolCallId: string) =>
      ({
        messageId,
        toolCallId,
        type: Tools.web_search,
        [Tools.web_search]: { turn: 0 },
      }) as unknown as TAttachment;

    ctx.handle(snapshot('tc-1'));
    ctx.handle(snapshot('tc-2'));

    expect(ctx.list).toHaveLength(2);
  });

  it('keeps same-agent executions separate when provider id and turn repeat', () => {
    const ctx = setup();
    const snapshot = (stepId: string, link: string) =>
      ({
        messageId,
        toolCallId: 'call_0',
        agentId: 'agent-a',
        stepId,
        type: Tools.web_search,
        [Tools.web_search]: { turn: 0, organic: [{ link }] },
      }) as unknown as TAttachment;

    ctx.handle(snapshot('step-1', 'https://first.example'));
    ctx.handle(snapshot('step-2', 'https://second.example'));
    ctx.handle(snapshot('step-1', 'https://first-updated.example'));

    expect(ctx.list).toHaveLength(2);
    expect(ctx.list.map((attachment) => attachment[Tools.web_search]?.organic?.[0]?.link)).toEqual([
      'https://first-updated.example',
      'https://second.example',
    ]);
  });

  it('keeps sibling tool calls separate when they share a file_id (distinct toolCallIds)', () => {
    /* Two background code calls regenerated the same filename — same
     * claimed file_id, different toolCallId. Each card anchors its own
     * attachment, so the second emit must append, not replace. A bare
     * update (no toolCallId) still merges by file key (wildcard). */
    const ctx = setup();
    ctx.handle(makeAttachment({ status: 'ready' }));
    ctx.handle(makeAttachment({ status: 'ready', toolCallId: 'tc-2' }));
    expect(ctx.list).toHaveLength(2);
  });

  it('keeps handoff agents separate when file_id AND toolCallId collide (distinct agentIds)', () => {
    /* Two handoff agents both emitted `call_0` and wrote the same
     * filename — same claimed file_id, same provider toolCallId,
     * different agentId. Merging would overwrite the first agent's
     * agentId and leave ContentParts one attachment short. A record
     * with no agentId still merges (wildcard, single-agent runs). */
    const ctx = setup();
    ctx.handle({ ...makeAttachment({ status: 'ready' }), agentId: 'agent_a' } as TAttachment);
    ctx.handle({ ...makeAttachment({ status: 'ready' }), agentId: 'agent_b' } as TAttachment);
    expect(ctx.list).toHaveLength(2);
    expect(ctx.list.map((a) => (a as { agentId?: string }).agentId).sort()).toEqual([
      'agent_a',
      'agent_b',
    ]);
    ctx.handle(makeAttachment({ status: 'failed', previewError: 'timeout' }));
    /* Bare-agent update merged into the FIRST compatible entry, not appended. */
    expect(ctx.list).toHaveLength(2);
    expect((ctx.list[0] as { previewError?: string }).previewError).toBe('timeout');
  });

  it('preserves fields from the first event when the second omits them', () => {
    /* The deferred preview update only carries the deltas (text, status,
     * textFormat). Fields set in the initial emit (filename, type, etc.)
     * must survive the merge — the second event uses spread-over-
     * existing semantics. */
    const ctx = setup();
    ctx.handle(makeAttachment({ status: 'pending', filename: 'phase1-name.xlsx' }));
    ctx.handle({
      file_id: 'fid-1',
      messageId,
      status: 'ready',
      text: 'final',
      textFormat: 'html',
    } as unknown as TAttachment);
    expect(ctx.list).toHaveLength(1);
    expect(ctx.list[0]).toMatchObject({
      filename: 'phase1-name.xlsx',
      status: 'ready',
      text: 'final',
    });
  });

  it('does NOT regress a resolved record when finalHandler replays the phase-1 snapshot', () => {
    /* `useEventHandlers.finalHandler` iterates `responseMessage.attachments`
     * at stream end — which is the immediate-persist snapshot
     * (status:pending, text:null). If a deferred update has already
     * moved this file_id to ready/failed, that replay must NOT
     * downgrade it. Otherwise the chip flickers back to "pending" and
     * polling restarts until the lazy sweep catches up. (Codex P1.) */
    const ctx = setup();
    ctx.handle(makeAttachment({ status: 'pending', text: undefined }));
    ctx.handle({
      file_id: 'fid-1',
      messageId,
      status: 'ready',
      text: '<table>resolved</table>',
      textFormat: 'html',
    } as unknown as TAttachment);
    /* Phase-1 replay arrives last (finalHandler at stream end). */
    ctx.handle(makeAttachment({ status: 'pending', text: undefined }));
    expect(ctx.list).toHaveLength(1);
    expect(ctx.list[0]).toMatchObject({
      status: 'ready',
      text: '<table>resolved</table>',
      textFormat: 'html',
    });
  });

  it('does NOT regress a failed record when finalHandler replays the phase-1 snapshot', () => {
    const ctx = setup();
    ctx.handle(makeAttachment({ status: 'pending' }));
    ctx.handle({
      file_id: 'fid-1',
      messageId,
      status: 'failed',
      previewError: 'parser-error',
    } as unknown as TAttachment);
    ctx.handle(makeAttachment({ status: 'pending' }));
    expect(ctx.list[0]).toMatchObject({
      status: 'failed',
      previewError: 'parser-error',
    });
  });

  describe('filePreview cache eviction (cross-turn filename reuse)', () => {
    /* Cross-turn filename reuse keeps the same `file_id`. If a prior
     * turn left `[QueryKeys.filePreview, file_id]` cached at
     * `status: 'ready'`, a new pending attachment would mount against
     * stale cache and `useFilePreview`'s polling (gated on `pending`)
     * would never start.
     *
     * The handler uses `removeQueries` (not `invalidateQueries`) for
     * this — invalidate alone only marks data stale, and the hook's
     * default `refetchOnMount` semantics combined with the
     * polling-gate-on-pending shape meant the new observer would still
     * read the stale 'ready' cache and never trigger a fetch. Removing
     * the entry forces a fresh server hit on next mount. (Codex P1
     * round-3 review on PR #12957.) */

    it('removes [QueryKeys.filePreview, file_id] when an attachment with a file_id arrives', () => {
      const ctx = setup();
      ctx.handle(makeAttachment({ status: 'pending' }));
      expect(ctx.removeSpy).toHaveBeenCalledWith(['filePreview', 'fid-1']);
    });

    it('removes the same query key for the deferred preview update event too', () => {
      /* Both the initial emit and the preview update should evict —
       * the second event is itself the authoritative new state, but
       * the upsert below races with the React Query cache and we want
       * the next mount to start clean. */
      const ctx = setup();
      ctx.handle(makeAttachment({ status: 'pending' }));
      ctx.handle(makeAttachment({ status: 'ready', text: '<table></table>', textFormat: 'html' }));
      const previewEvictions = ctx.removeSpy.mock.calls.filter(
        (c) => Array.isArray(c[0]) && c[0][0] === 'filePreview' && c[0][1] === 'fid-1',
      );
      expect(previewEvictions.length).toBe(2);
    });

    it('does not evict when the attachment carries no file_id', () => {
      const ctx = setup();
      const noFileId = {
        messageId,
        toolCallId: 'tc-1',
        type: Tools.web_search,
      } as unknown as TAttachment;
      ctx.handle(noFileId);
      const previewEvictions = ctx.removeSpy.mock.calls.filter(
        (c) => Array.isArray(c[0]) && c[0][0] === 'filePreview',
      );
      expect(previewEvictions).toHaveLength(0);
    });

    it('does NOT use invalidateQueries (would leave stale cache readable per round-3 review)', () => {
      /* Lock in the choice of `removeQueries` over `invalidateQueries`.
       * Invalidate marks data stale but does not remove it; an
       * observer reading a stale cache still gets the value back and
       * the polling `refetchInterval` evaluates against stale 'ready'
       * → returns false → polling never starts. removeQueries forces
       * a refetch on next mount. */
      const queryClient = new QueryClient();
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
      const removeSpy = jest.spyOn(queryClient, 'removeQueries');
      const ref: { current: Record<string, TAttachment[] | undefined> } = { current: {} };
      const { result } = renderHook(
        () => {
          const handler = useAttachmentHandler(queryClient);
          const map = useRecoilValue(store.messageAttachmentsMap);
          ref.current = map;
          return handler;
        },
        { wrapper },
      );
      act(() => result.current({ data: makeAttachment({ status: 'pending' }), submission }));
      const usedRemove = removeSpy.mock.calls.some(
        (c) => Array.isArray(c[0]) && c[0][0] === 'filePreview',
      );
      const usedInvalidate = invalidateSpy.mock.calls.some(
        (c) => Array.isArray(c[0]) && c[0][0] === 'filePreview',
      );
      expect(usedRemove).toBe(true);
      expect(usedInvalidate).toBe(false);
    });
  });
});
