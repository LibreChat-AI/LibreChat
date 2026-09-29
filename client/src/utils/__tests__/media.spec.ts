import type { TAttachment } from 'librechat-data-provider';
import {
  attachmentIdentity,
  attachmentRenderKey,
  buildAttachmentsByName,
  resolveInlineMedia,
  toAbsoluteFilePath,
} from '~/utils/media';

const attachment = (overrides: Partial<TAttachment> = {}): TAttachment =>
  ({
    filename: '5_dti.png',
    filepath: '/api/files/code/download/sess/abc/5_dti.png',
    conversationId: 'c1',
    ...overrides,
  }) as unknown as TAttachment;

describe('buildAttachmentsByName', () => {
  it('indexes by the leaf filename, case-insensitively', () => {
    const file = attachment({ filename: 'charts/5_DTI.png' });
    const byName = buildAttachmentsByName([file]);
    expect(byName.get('5_dti.png')).toBe(file);
  });

  it('keeps resolving when one stored file surfaces under two calls', () => {
    // Inherited across steps, or a regeneration that updated the record in
    // place. One file, so nothing is ambiguous — and the later record wins,
    // since that is the one carrying the fresher lifecycle fields.
    const first = attachment({ file_id: 'f1', toolCallId: 't1' } as Partial<TAttachment>);
    const again = attachment({ file_id: 'f1', toolCallId: 't2' } as Partial<TAttachment>);
    expect(buildAttachmentsByName([first, again]).get('5_dti.png')).toBe(again);
  });

  it.each([
    ['two different agents', 'a1', 'a2'],
    ['two sibling calls by one agent', 'a1', 'a1'],
    ['legacy rows naming no agent', undefined, undefined],
  ])('refuses a basename two stored files claim — %s', (_label, left, right) => {
    // A regeneration and two siblings that both wrote `output.png` are
    // indistinguishable from the metadata, so picking either is a coin flip
    // that renders one file under the other's caption.
    const a = attachment({ filepath: '/files/left.png', toolCallId: 't1', agentId: left });
    const b = attachment({ filepath: '/files/right.png', toolCallId: 't2', agentId: right });
    expect(buildAttachmentsByName([a, b]).has('5_dti.png')).toBe(false);
  });

  it('keeps a name ambiguous once a third entry arrives', () => {
    const left = attachment({ filepath: '/files/left.png' });
    const right = attachment({ filepath: '/files/right.png' });
    const later = attachment({ filepath: '/files/later.png' });
    expect(buildAttachmentsByName([left, right, later]).has('5_dti.png')).toBe(false);
  });

  it('does not let one collision poison an unrelated name', () => {
    const left = attachment({ filepath: '/files/left.png', agentId: 'a1' });
    const right = attachment({ filepath: '/files/right.png', agentId: 'a2' });
    const other = attachment({ filename: 'other.png', filepath: '/files/o.png', agentId: 'a3' });
    const byName = buildAttachmentsByName([left, right, other]);
    expect(byName.has('5_dti.png')).toBe(false);
    expect(byName.get('other.png')).toBe(other);
  });

  it('skips a file no <img> can display', () => {
    // An `<img>` aimed at a CSV renders nothing; the file keeps its download
    // chip instead.
    const csv = attachment({ filename: 'report.csv', filepath: '/api/files/report.csv' });
    expect(buildAttachmentsByName([csv]).size).toBe(0);
  });

  it('indexes an image fallback that carries no dimensions', () => {
    // An oversized output falls back to a download URL with an image name and
    // no width/height. `<Image>` needs those to reserve layout space; a
    // markdown `<img>` does not, and the URL serves the picture fine.
    const fallback = attachment({ width: undefined, height: undefined } as Partial<TAttachment>);
    expect(buildAttachmentsByName([fallback]).get('5_dti.png')).toBe(fallback);
  });

  it('resolves the latest record of one rewritten file', () => {
    // A tool rewriting one path reuses its file_id; the later record carries
    // the newer URL, so keeping the first would resolve to a stale one.
    const first = attachment({ file_id: 'f1', filepath: '/api/f/a.png' } as Partial<TAttachment>);
    const rewritten = attachment({
      file_id: 'f1',
      filepath: '/api/f/a.png?v=2',
    } as Partial<TAttachment>);
    expect(buildAttachmentsByName([first, rewritten]).get('5_dti.png')).toBe(rewritten);
  });

  it('skips attachments with nothing to point at', () => {
    expect(buildAttachmentsByName([attachment({ filepath: undefined })]).size).toBe(0);
    expect(buildAttachmentsByName([attachment({ filename: undefined })]).size).toBe(0);
  });

  it('keeps resolving after a rewritten file, without reading it as ambiguous', () => {
    const first = attachment({ file_id: 'f1', filepath: '/api/f/a.png' } as Partial<TAttachment>);
    const rewritten = attachment({
      file_id: 'f1',
      filepath: '/api/f/a.png?v=2',
    } as Partial<TAttachment>);
    const third = attachment({
      file_id: 'f1',
      filepath: '/api/f/a.png?v=3',
    } as Partial<TAttachment>);
    expect(buildAttachmentsByName([first, rewritten, third]).get('5_dti.png')).toBe(third);
  });

  it('returns one shared instance when nothing is indexable', () => {
    expect(buildAttachmentsByName(undefined)).toBe(buildAttachmentsByName([]));
  });
});

describe('resolveInlineMedia', () => {
  const file = attachment();
  const byName = buildAttachmentsByName([file]);

  it.each([
    ['a bare filename', '5_dti.png'],
    ['a sandbox path', '/mnt/data/5_dti.png'],
    ['a percent-encoded name', '5%5Fdti.png'],
    ['a cache-busting query', '5_dti.png?v=2'],
  ])('resolves %s', (_label, src) => {
    expect(resolveInlineMedia(src, byName)).toBe(file);
  });

  it.each([
    ['an absolute URL', 'https://example.com/5_dti.png'],
    ['a data URI', 'data:image/png;base64,AAAA'],
    ['a protocol-relative URL', '//cdn.example.com/5_dti.png'],
    ['a sandbox scheme', 'sandbox:/mnt/data/5_dti.png'],
    ['an explicit /api/ path', '/api/files/other/session/5_dti.png'],
    ['an explicit /images/ path', '/images/user/5_dti.png'],
  ])('leaves %s alone', (_label, src) => {
    // The served paths matter even though a `5_dti.png` attachment exists: the
    // author addressed one specific file, and reducing it to a basename would
    // display a DIFFERENT attachment that happens to share the leaf.
    expect(resolveInlineMedia(src, byName)).toBeUndefined();
  });

  it('resolves nothing for a file the turn never produced', () => {
    expect(resolveInlineMedia('missing.png', byName)).toBeUndefined();
  });

  it('resolves nothing without a map', () => {
    expect(resolveInlineMedia('5_dti.png', undefined)).toBeUndefined();
    expect(resolveInlineMedia(undefined, byName)).toBeUndefined();
  });

  it('survives a malformed escape rather than throwing', () => {
    expect(() => resolveInlineMedia('%E0%A4%A.png', byName)).not.toThrow();
  });
});

describe('attachmentIdentity', () => {
  it('prefers file_id over filepath', () => {
    expect(attachmentIdentity(attachment({ file_id: 'f1' } as Partial<TAttachment>))).toBe('f1');
    expect(attachmentIdentity(attachment())).toBe('/api/files/code/download/sess/abc/5_dti.png');
  });

  it('keeps sibling calls that share a claimed file_id apart', () => {
    // Documented in useAttachments: sibling code calls can share a claimed
    // file_id for the same filename, and each anchors its own card.
    const left = attachment({ file_id: 'f1', toolCallId: 't1' } as Partial<TAttachment>);
    const right = attachment({ file_id: 'f1', toolCallId: 't2' } as Partial<TAttachment>);
    expect(attachmentIdentity(left)).not.toBe(attachmentIdentity(right));
  });

  it('keeps handoff agents repeating a provider tool id apart', () => {
    const left = attachment({
      file_id: 'f1',
      toolCallId: 't1',
      agentId: 'a1',
    } as Partial<TAttachment>);
    const right = attachment({
      file_id: 'f1',
      toolCallId: 't1',
      agentId: 'a2',
    } as Partial<TAttachment>);
    expect(attachmentIdentity(left)).not.toBe(attachmentIdentity(right));
  });

  it('falls back to type:toolCallId for unkeyed tool artifacts', () => {
    const citation = {
      type: 'file_search',
      toolCallId: 't1',
      conversationId: 'c1',
    } as unknown as TAttachment;
    expect(attachmentIdentity(citation)).toBe('file_search:t1');
  });

  it('gives no identity to a row that names no stored file', () => {
    // Two rows that cannot be told apart are two rows, not one.
    expect(
      attachmentIdentity(attachment({ file_id: undefined, filepath: undefined })),
    ).toBeUndefined();
  });
});

describe('toAbsoluteFilePath', () => {
  const base = 'https://chat.example.com/librechat';

  it.each([
    ['a code-execution download', '/api/files/code/download/sess/abc/5_dti.png'],
    ['a share route', '/api/share/abc/img.png'],
    ['an uploaded image', '/images/user/pic.png'],
  ])('prefixes the API base onto %s', (_label, path) => {
    // Without this every generated chart 404s against the origin root on a
    // subpath deployment — and /api/ is what code-execution artifacts use.
    expect(toAbsoluteFilePath(path, base)).toBe(`${base}${path}`);
  });

  it.each([
    ['an absolute URL', 'https://cdn.example.com/a.png'],
    ['a data URI', 'data:image/png;base64,AAAA'],
    ['a bare relative name', '5_dti.png'],
    ['an unserved root path', '/static/a.png'],
    ['an empty path', ''],
  ])('leaves %s alone', (_label, path) => {
    expect(toAbsoluteFilePath(path, base)).toBe(path);
  });

  it('serves exactly the paths resolution declines to look up', () => {
    // Both read SERVED_PATH_PATTERN. If they ever disagree, an explicitly
    // addressed file either loses its base URL or gets swapped for another
    // attachment sharing its basename.
    for (const path of ['/images/user/a.png', '/api/files/x/a.png']) {
      expect(toAbsoluteFilePath(path, base)).toBe(`${base}${path}`);
      expect(
        resolveInlineMedia(path, buildAttachmentsByName([attachment({ filename: 'a.png' })])),
      ).toBeUndefined();
    }
  });
});

describe('attachmentRenderKey', () => {
  it('splits two run steps that reuse one provider tool-call id', () => {
    // `filterAttachmentsForPart` routes these to different parts by step, so
    // they are two artifacts. Collapsing them drops one from the media row —
    // the only place it appears once the fold hides the parts' own copies.
    const first = attachment({
      file_id: 'f1',
      toolCallId: 't1',
      stepId: 's1',
    } as Partial<TAttachment>);
    const second = attachment({
      file_id: 'f1',
      toolCallId: 't1',
      stepId: 's2',
    } as Partial<TAttachment>);
    expect(attachmentRenderKey(first)).not.toBe(attachmentRenderKey(second));
  });

  it('keeps one record of one artifact together across re-renders', () => {
    const a = attachment({ file_id: 'f1', toolCallId: 't1', stepId: 's1' } as Partial<TAttachment>);
    const b = attachment({ file_id: 'f1', toolCallId: 't1', stepId: 's1' } as Partial<TAttachment>);
    expect(attachmentRenderKey(a)).toBe(attachmentRenderKey(b));
  });

  it('leaves a step-less legacy row on the plain identity', () => {
    const legacy = attachment({ file_id: 'f1', toolCallId: 't1' } as Partial<TAttachment>);
    expect(attachmentRenderKey(legacy)).toBe(attachmentIdentity(legacy));
  });

  it('has no key when the identity has none', () => {
    expect(
      attachmentRenderKey(attachment({ file_id: undefined, filepath: undefined })),
    ).toBeUndefined();
  });
});
