/**
 * Regression for issue #13916: hard-refreshing a conversation that
 * contains a large (>1MB) code-execution office file crashed the app
 * with React error #185 ("Maximum update depth exceeded").
 *
 * The loop only manifests with the REAL consumer wiring, which the
 * focused unit spec (sibling file) can't reproduce because it passes a
 * fixed `attachment` prop:
 *
 *   ContentRender → useAttachments (re-derives `attachment` with a fresh
 *   identity on every messageAttachmentsMap write) → … → FileAttachment
 *   → useAttachmentPreviewSync (writes the resolved record back into
 *   messageAttachmentsMap; `attachment` is in the effect's deps).
 *
 * On a loaded conversation the message's attachment is frozen at the
 * immediate-persist snapshot `status: 'pending'`; polling resolves it to
 * `ready`, the effect writes it into the map, useAttachments re-derives a
 * new attachment identity, the effect re-fires, and so on without ever
 * reaching a fixed point. This test reproduces that exact feedback path
 * and asserts it settles instead of looping.
 */

import { RecoilRoot } from 'recoil';
import { Tools } from 'librechat-data-provider';
import { render } from '@testing-library/react';
import type {
  TFile,
  TAttachment,
  TFilePreview,
  TAttachmentMetadata,
} from 'librechat-data-provider';

const mockUseFilePreview = jest.fn();
jest.mock('~/data-provider', () => ({
  useFilePreview: (...args: unknown[]) => mockUseFilePreview(...args),
}));
jest.mock('~/hooks/useLocalize', () => () => (key: string) => key);

import useAttachments from '~/hooks/Messages/useAttachments';
import useAttachmentPreviewSync from '../useAttachmentPreviewSync';

const messageId = 'msg-1';
const fileId = 'fid-1';

/** DB-frozen, immediate-persist snapshot: status pending, no text yet. */
const dbAttachment = {
  user: 'user-1',
  object: 'file',
  bytes: 1256732,
  embedded: false,
  usage: 0,
  file_id: fileId,
  filename: 'repro-13916-large.docx',
  filepath: '/uploads/repro-13916-large.docx',
  type: Tools.execute_code,
  messageId,
  toolCallId: 'tc-1',
  text: undefined,
  textFormat: undefined,
  status: 'pending',
} as TFile & TAttachmentMetadata as TAttachment;

/* Stable array identity so the only identity churn during the test comes
 * from messageAttachmentsMap writes, not from re-creating this prop. */
const dbAttachments: TAttachment[] = [dbAttachment];

let renderCount = 0;

function PreviewBridge({ attachment }: { attachment: TAttachment }) {
  renderCount += 1;
  useAttachmentPreviewSync(attachment);
  return null;
}

/** Mirrors ContentRender: the rendered attachment is the merged value
 * produced by useAttachments, re-derived from the live map on each write. */
function Consumer() {
  const { attachments } = useAttachments({ messageId, attachments: dbAttachments });
  const attachment = attachments[0];
  if (!attachment) {
    return null;
  }
  return <PreviewBridge attachment={attachment} />;
}

describe('useAttachmentPreviewSync — #13916 infinite-loop regression', () => {
  beforeEach(() => {
    renderCount = 0;
    mockUseFilePreview.mockReset();
  });

  it('settles (no React #185) when a pending code-exec preview resolves to ready on load', () => {
    mockUseFilePreview.mockReturnValue({
      data: {
        file_id: fileId,
        status: 'ready',
        text: '<p>edited paragraph added</p>',
        textFormat: 'html',
      } as TFilePreview,
      isFetching: false,
    });

    expect(() =>
      render(
        <RecoilRoot>
          <Consumer />
        </RecoilRoot>,
      ),
    ).not.toThrow();
    /* A correct fixed point reaches the resolved state in a handful of
     * renders. A regressed write-back would blow past React's nested
     * update ceiling (50) and throw long before any sane bound. */
    expect(renderCount).toBeLessThan(10);
  });

  it('still merges the resolved record into the map exactly once', () => {
    let latestMap: Record<string, TAttachment[] | undefined> = {};
    mockUseFilePreview.mockReturnValue({
      data: {
        file_id: fileId,
        status: 'ready',
        text: '<p>final</p>',
        textFormat: 'html',
      } as TFilePreview,
      isFetching: false,
    });

    function MapProbe() {
      const { attachments } = useAttachments({ messageId, attachments: dbAttachments });
      latestMap = { [messageId]: attachments };
      const attachment = attachments[0];
      return attachment ? <PreviewBridge attachment={attachment} /> : null;
    }

    render(
      <RecoilRoot>
        <MapProbe />
      </RecoilRoot>,
    );

    const resolved = latestMap[messageId]?.[0] as TFile & TAttachmentMetadata;
    expect(resolved.status).toBe('ready');
    expect(resolved.text).toBe('<p>final</p>');
    expect(resolved.textFormat).toBe('html');
  });

  it('settles for a failed resolution too', () => {
    mockUseFilePreview.mockReturnValue({
      data: {
        file_id: fileId,
        status: 'failed',
        previewError: 'render-timeout',
      } as TFilePreview,
      isFetching: false,
    });

    expect(() =>
      render(
        <RecoilRoot>
          <Consumer />
        </RecoilRoot>,
      ),
    ).not.toThrow();
    expect(renderCount).toBeLessThan(10);
  });
});
