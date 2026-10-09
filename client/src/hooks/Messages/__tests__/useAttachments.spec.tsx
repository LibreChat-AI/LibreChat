/**
 * Coverage for `useAttachments` — the merge layer that overlays live
 * (SSE / poll-driven) attachment lifecycle fields onto DB-loaded
 * attachments by `file_id`.
 *
 * The merge is the only thing that lets the deferred-preview flow
 * recover on a reloaded conversation: messages persist with the
 * immediate-snapshot `status: 'pending'`, but the file record itself
 * resolves to `'ready'` later. Without the by-file_id overlay, the
 * renderer would route through the plain file chip forever.
 */

import { useEffect } from 'react';
import { Tools } from 'librechat-data-provider';
import { renderHook } from '@testing-library/react';
import { RecoilRoot, useSetRecoilState } from 'recoil';
import type { TAttachment, TFile, TAttachmentMetadata } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import store from '~/store';

type AttachmentFixture = TFile & TAttachmentMetadata;

jest.mock('~/hooks/useLocalize', () => () => (key: string) => key);

import useAttachments from '../useAttachments';

const messageId = 'msg-1';

function makeAttachment(overrides: Partial<AttachmentFixture> = {}): AttachmentFixture {
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

function makeNonFileAttachment(
  overrides: Partial<TAttachment & { agentId?: string; stepId?: string }> = {},
): AttachmentFixture {
  return {
    type: Tools.ui_resources,
    toolCallId: 'call_0',
    agentId: 'agent-a',
    stepId: 'step-1',
    messageId,
    ...overrides,
  } as unknown as AttachmentFixture;
}

function setup({
  attachments,
  liveMap,
}: {
  attachments?: TAttachment[];
  liveMap?: Record<string, TAttachment[]>;
}) {
  const Seed = () => {
    const setMap = useSetRecoilState(store.messageAttachmentsMap);
    useEffect(() => {
      if (liveMap) {
        setMap(liveMap);
      }
    }, [setMap]);
    return null;
  };

  return renderHook(() => useAttachments({ messageId, attachments }), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <RecoilRoot>
        <Seed />
        {children}
      </RecoilRoot>
    ),
  });
}

describe('useAttachments', () => {
  it('returns DB attachments when no live entries exist', () => {
    const db = makeAttachment({ status: 'pending' });
    const { result } = setup({ attachments: [db] });
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0]).toBe(db);
  });

  it('returns live entries when no DB attachments exist (active SSE turn)', () => {
    const live = makeAttachment({ status: 'ready', text: '<table>x</table>' });
    const { result } = setup({
      attachments: undefined,
      liveMap: { [messageId]: [live] },
    });
    expect(result.current.attachments).toHaveLength(1);
    expect((result.current.attachments[0] as TAttachment & { text?: string }).text).toBe(
      '<table>x</table>',
    );
  });

  it('overlays live lifecycle fields onto matching DB attachment by file_id', () => {
    /* This is the regression test for the stuck-pending bug on a
     * reloaded conversation: the DB record was frozen at the
     * immediate-persist snapshot; the polling layer fetched the
     * resolved record and inserted it into messageAttachmentsMap; the
     * merge here must surface the resolved fields to the renderer. */
    const db = makeAttachment({ status: 'pending', text: undefined, textFormat: undefined });
    const live = makeAttachment({
      status: 'ready',
      text: '<table>resolved</table>',
      textFormat: 'html',
    });
    const { result } = setup({
      attachments: [db],
      liveMap: { [messageId]: [live] },
    });
    expect(result.current.attachments).toHaveLength(1);
    const merged = result.current.attachments[0] as AttachmentFixture;
    expect(merged.status).toBe('ready');
    expect(merged.text).toBe('<table>resolved</table>');
    expect(merged.textFormat).toBe('html');
    /* Non-lifecycle DB fields stay intact. */
    expect(merged.filename).toBe('data.xlsx');
  });

  it('keeps live-only entries alongside DB attachments (background harvest delivery)', () => {
    const db = makeAttachment({ file_id: 'fid-A', status: 'pending' });
    const live = makeAttachment({ file_id: 'fid-B', status: 'ready' });
    const { result } = setup({
      attachments: [db],
      liveMap: { [messageId]: [live] },
    });
    /* Attachments are only emitted after successful persistence, so a
     * live-only entry is a real file whose message-row snapshot predates
     * it — e.g. a background code task's harvested files, SSE-delivered
     * on a poll turn after the dispatch message was saved. Dropping it
     * would hide the files until a full reload. */
    expect(result.current.attachments).toHaveLength(2);
    expect((result.current.attachments[0] as AttachmentFixture).file_id).toBe('fid-A');
    expect((result.current.attachments[0] as AttachmentFixture).status).toBe('pending');
    expect((result.current.attachments[1] as AttachmentFixture).file_id).toBe('fid-B');
  });

  it('overlays bare live records (no toolCallId) onto DB entries that carry one', () => {
    /* Preview-sync polling inserts the resolved FILE record, which has no
     * toolCallId; the DB attachment does. The lifecycle overlay must still
     * match (wildcard), or reloaded office previews stick on pending. */
    const db = makeAttachment({ status: 'pending', text: undefined });
    const live = { ...makeAttachment({ status: 'ready', text: 'resolved' }) };
    delete (live as { toolCallId?: string }).toolCallId;
    const { result } = setup({
      attachments: [db],
      liveMap: { [messageId]: [live as AttachmentFixture] },
    });
    expect(result.current.attachments).toHaveLength(1);
    expect((result.current.attachments[0] as AttachmentFixture).status).toBe('ready');
  });

  it('keeps sibling tool calls’ live attachments when file ids repeat across calls', () => {
    /* Two background code calls regenerated the same filename — same
     * claimed file_id, different toolCallId. Each card anchors its own
     * attachment, so the second must not displace the first. */
    const db = makeAttachment({ file_id: 'shared' });
    const sibling = { ...makeAttachment({ file_id: 'shared' }), toolCallId: 'tc-2' };
    const { result } = setup({
      attachments: [db],
      liveMap: { [messageId]: [sibling] },
    });
    expect(result.current.attachments).toHaveLength(2);
  });

  it('keeps handoff agents’ live attachments when file_id AND toolCallId collide', () => {
    /* Handoff agents can repeat provider tool ids (`call_0`) and share a
     * claimed file_id. The sibling agent's live entry must neither
     * overlay the first agent's DB row nor be deduped away — each
     * agent's card anchors its own attachment. */
    const db = { ...makeAttachment({ file_id: 'shared', status: 'pending' }), agentId: 'agent_a' };
    const sibling = {
      ...makeAttachment({ file_id: 'shared', status: 'ready' }),
      agentId: 'agent_b',
    };
    const { result } = setup({
      attachments: [db],
      liveMap: { [messageId]: [sibling] },
    });
    expect(result.current.attachments).toHaveLength(2);
    expect((result.current.attachments[0] as AttachmentFixture).status).toBe('pending');
    expect((result.current.attachments[0] as { agentId?: string }).agentId).toBe('agent_a');
    expect((result.current.attachments[1] as { agentId?: string }).agentId).toBe('agent_b');
  });

  it('overlays agent-less live records onto agent-scoped DB rows (wildcard) without re-appending', () => {
    /* Preview-sync fan-out and bare deferred updates carry no agentId;
     * they must still resolve an agent-stamped DB row, and the overlaid
     * entry must be recognized as a duplicate via its less-specific key. */
    const db = {
      ...makeAttachment({ file_id: 'shared', status: 'pending', text: undefined }),
      agentId: 'agent_a',
    };
    const live = makeAttachment({ file_id: 'shared', status: 'ready', text: 'resolved' });
    const { result } = setup({
      attachments: [db],
      liveMap: { [messageId]: [live] },
    });
    expect(result.current.attachments).toHaveLength(1);
    expect((result.current.attachments[0] as AttachmentFixture).status).toBe('ready');
    expect((result.current.attachments[0] as { agentId?: string }).agentId).toBe('agent_a');
  });

  it('dedupes unkeyed live entries against DB copies by type + toolCallId', () => {
    const citation = {
      type: 'file_search',
      toolCallId: 'tc-1',
      messageId,
    } as unknown as AttachmentFixture;
    const { result } = setup({
      attachments: [citation],
      liveMap: { [messageId]: [{ ...citation }] },
    });
    /* The final message event replays the same persisted file_search
     * citation the SSE handler already stored — one card, not two. */
    expect(result.current.attachments).toHaveLength(1);
  });

  it('dedupes an agent-less replay of an agent-owned non-file row', () => {
    const db = makeNonFileAttachment();
    const replay = makeNonFileAttachment({ agentId: undefined });

    const { result } = setup({
      attachments: [db],
      liveMap: { [messageId]: [replay] },
    });

    expect(result.current.attachments).toEqual([db]);
  });

  it('keeps a non-file row owned by a different live agent', () => {
    const db = makeNonFileAttachment();
    const sibling = makeNonFileAttachment({ agentId: 'agent-b' });

    const { result } = setup({
      attachments: [db],
      liveMap: { [messageId]: [sibling] },
    });

    expect(result.current.attachments).toEqual([db, sibling]);
  });

  it('dedupes a non-file replay with the same known agent and step', () => {
    const db = makeNonFileAttachment();
    const replay = makeNonFileAttachment();

    const { result } = setup({
      attachments: [db],
      liveMap: { [messageId]: [replay] },
    });

    expect(result.current.attachments).toEqual([db]);
  });

  it('keeps non-file rows with distinct known steps', () => {
    const db = makeNonFileAttachment({ stepId: 'step-1' });
    const sibling = makeNonFileAttachment({ stepId: 'step-2' });

    const { result } = setup({
      attachments: [db],
      liveMap: { [messageId]: [sibling] },
    });

    expect(result.current.attachments).toEqual([db, sibling]);
  });

  it('keeps a known step conflict when the live agent is missing', () => {
    const db = makeNonFileAttachment({ stepId: 'step-1' });
    const sibling = makeNonFileAttachment({ agentId: undefined, stepId: 'step-2' });

    const { result } = setup({
      attachments: [db],
      liveMap: { [messageId]: [sibling] },
    });

    expect(result.current.attachments).toEqual([db, sibling]);
  });

  it('keeps a known agent conflict when the live step is missing', () => {
    const db = makeNonFileAttachment({ agentId: 'agent-a' });
    const sibling = makeNonFileAttachment({ agentId: 'agent-b', stepId: undefined });

    const { result } = setup({
      attachments: [db],
      liveMap: { [messageId]: [sibling] },
    });

    expect(result.current.attachments).toEqual([db, sibling]);
  });

  it.each([
    [
      'DB-specific / live missing step',
      makeNonFileAttachment(),
      makeNonFileAttachment({ stepId: undefined }),
    ],
    [
      'DB-missing / live specific step',
      makeNonFileAttachment({ stepId: undefined }),
      makeNonFileAttachment(),
    ],
    [
      'DB-specific / live missing agent',
      makeNonFileAttachment(),
      makeNonFileAttachment({ agentId: undefined }),
    ],
    [
      'DB-missing / live specific agent',
      makeNonFileAttachment({ agentId: undefined }),
      makeNonFileAttachment(),
    ],
  ])('dedupes compatible non-file ownership: %s', (_label, db, replay) => {
    const { result } = setup({
      attachments: [db],
      liveMap: { [messageId]: [replay] },
    });

    expect(result.current.attachments).toEqual([db]);
  });

  it('drops live entries with no stable identity at all', () => {
    const db = makeAttachment({ file_id: 'fid-A' });
    const anonymous = { messageId } as unknown as AttachmentFixture;
    const { result } = setup({
      attachments: [db],
      liveMap: { [messageId]: [anonymous] },
    });
    expect(result.current.attachments).toHaveLength(1);
    expect((result.current.attachments[0] as AttachmentFixture).file_id).toBe('fid-A');
  });
});
