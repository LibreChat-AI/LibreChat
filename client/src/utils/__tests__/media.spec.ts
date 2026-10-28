import type { TAttachment, TMessage } from 'librechat-data-provider';
import {
  attachmentIdentity,
  attachmentRenderKey,
  buildAttachmentsByName,
  buildFilesByName,
  resolveSandboxLink,
  buildConversationFilesByName,
  resolveInlineMedia,
  sandboxUrlTransform,
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

  it('keeps non-file artifacts from agents reusing a provider tool id apart', () => {
    const alpha = {
      type: 'ui_resources',
      toolCallId: 'call_0',
      agentId: 'agent-alpha',
    } as unknown as TAttachment;
    const beta = { ...alpha, agentId: 'agent-b' } as TAttachment;

    expect(attachmentIdentity(alpha)).toBe('ui_resources:call_0::agent-alpha');
    expect(attachmentIdentity(beta)).toBe('ui_resources:call_0::agent-b');
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

describe('buildFilesByName', () => {
  const deck = attachment({
    filename: 'deck.pptx',
    filepath: '/api/files/code/download/s/d/deck.pptx',
  });

  it('indexes non-image files that the image map leaves out', () => {
    expect(buildFilesByName([deck]).get('deck.pptx')).toBe(deck);
    expect(buildAttachmentsByName([deck]).size).toBe(0);
  });

  it('keeps a basename two stored files claim as unresolved, unlike the image map', () => {
    const other = attachment({ filename: 'deck.pptx', filepath: '/api/files/other/deck.pptx' });
    const files = buildFilesByName([deck, other]);
    expect(files.has('deck.pptx')).toBe(true);
    expect(files.get('deck.pptx')).toBeUndefined();
    const a = attachment({ filename: 'a.png', filepath: '/api/files/1/a.png', file_id: '1' });
    const b = attachment({ filename: 'a.png', filepath: '/api/files/2/a.png', file_id: '2' });
    expect(buildAttachmentsByName([a, b]).has('a.png')).toBe(false);
  });
});

describe('resolveSandboxLink', () => {
  const deck = attachment({
    filename: 'deck.pptx',
    filepath: '/api/files/code/download/s/d/deck.pptx',
  });
  const byName = buildFilesByName([deck]);

  it('resolves a sandbox path by case-insensitive basename', () => {
    expect(resolveSandboxLink('/mnt/data/sub/Deck.PPTX', byName)).toEqual({
      isSandboxPath: true,
      attachment: deck,
    });
  });

  it.each([
    '/api/files/x/deck.pptx',
    'https://example.com/mnt/data/deck.pptx',
    'deck.pptx',
    undefined,
  ])('does not treat %s as a sandbox path', (href) => {
    expect(resolveSandboxLink(href, byName)).toEqual({ isSandboxPath: false });
  });

  it('reports an unmatched sandbox path without an attachment', () => {
    expect(resolveSandboxLink('/mnt/data/missing.pptx', byName)).toEqual({
      isSandboxPath: true,
      attachment: undefined,
    });
  });
});

describe('resolveSandboxLink fallback', () => {
  const mk = (file_id: string) =>
    ({
      filename: 'deck.pptx',
      filepath: `/p/${file_id}/deck.pptx`,
      file_id,
    }) as unknown as TAttachment;
  const own = buildFilesByName([mk('own')]);
  const other = buildConversationFilesByName([
    { attachments: [mk('other')] } as unknown as TMessage,
  ]);

  it('prefers the turn own map over the fallback', () => {
    expect(resolveSandboxLink('/mnt/data/deck.pptx', own, other).attachment).toBe(
      own.get('deck.pptx'),
    );
  });

  it('uses the fallback when the own map misses', () => {
    expect(resolveSandboxLink('/mnt/data/deck.pptx', undefined, other).attachment).toBe(
      other.get('deck.pptx'),
    );
  });

  it('does not consult the fallback for a name the turn holds ambiguously', () => {
    const ambiguous = buildFilesByName([mk('x'), mk('y')]);
    expect(resolveSandboxLink('/mnt/data/deck.pptx', ambiguous, other)).toEqual({
      isSandboxPath: true,
      attachment: undefined,
    });
  });

  it('ignores the fallback for a non-sandbox href', () => {
    expect(resolveSandboxLink('/api/files/deck.pptx', undefined, other)).toEqual({
      isSandboxPath: false,
    });
  });
});

describe('buildConversationFilesByName', () => {
  const file = (
    filename: string,
    file_id: string,
    filepath = `/api/files/${file_id}/${filename}`,
  ) => ({ filename, file_id, filepath }) as unknown as TAttachment;
  const msg = (messageId: string, attachments?: TAttachment[]) =>
    ({ messageId, attachments }) as unknown as TMessage;

  it('finds a file from an earlier message', () => {
    const deck = file('deck.pptx', 'a');
    const map = buildConversationFilesByName([msg('1', [deck]), msg('2')]);
    expect(map.get('deck.pptx')).toBe(deck);
  });

  it('lets the newest message win a basename', () => {
    const map = buildConversationFilesByName([
      msg('1', [file('report.csv', 'a', 'out/report.csv')]),
      msg('3', [file('report.csv', 'b', 'b/report.csv')]),
    ]);
    expect((map.get('report.csv') as { file_id?: string }).file_id).toBe('b');
  });

  it('keeps the later record of the same stored file across messages', () => {
    const later = file('r.csv', 'a', '/new/r.csv');
    const map = buildConversationFilesByName([
      msg('1', [file('r.csv', 'a', '/old/r.csv')]),
      msg('2', [later]),
    ]);
    expect(map.get('r.csv')).toBe(later);
  });

  it('keeps the later record of the same stored file within one message', () => {
    const later = file('r.csv', 'a', '/new/r.csv');
    const map = buildConversationFilesByName([msg('1', [file('r.csv', 'a', '/old/r.csv'), later])]);
    expect(map.get('r.csv')).toBe(later);
  });

  it('never holds an undefined value', () => {
    const map = buildConversationFilesByName([
      msg('1', [file('x.csv', 'a'), file('x.csv', 'b'), file('ok.csv', 'c')]),
    ]);
    expect(map.has('x.csv')).toBe(false);
    expect([...map.values()].every((v) => v !== undefined)).toBe(true);
  });

  it('does not let an older message fill a name a newer one left ambiguous', () => {
    const map = buildConversationFilesByName([
      msg('1', [file('x.csv', 'a')]),
      msg('2', [file('x.csv', 'b'), file('x.csv', 'c')]),
    ]);
    expect(map.get('x.csv')).toBeUndefined();
  });

  it('skips attachments without a filepath and shares the empty map', () => {
    const map = buildConversationFilesByName([
      msg('1', [{ filename: 'n.csv', file_id: 'a' } as unknown as TAttachment]),
    ]);
    expect(map.size).toBe(0);
    expect(buildConversationFilesByName(undefined)).toBe(buildConversationFilesByName([]));
    expect(map).toBe(buildConversationFilesByName([]));
  });
});

describe('sandboxUrlTransform', () => {
  it('reduces a sandbox:/mnt/data/ URL to its path', () => {
    expect(sandboxUrlTransform('sandbox:/mnt/data/deck.pptx')).toBe('/mnt/data/deck.pptx');
  });

  it.each([
    ['https://example.com/a', 'https://example.com/a'],
    ['/mnt/data/deck.pptx', '/mnt/data/deck.pptx'],
    ['sandbox:/etc/passwd', ''],
    ['javascript:alert(1)', ''],
  ])('screens %s like the default transform', (url, expected) => {
    expect(sandboxUrlTransform(url)).toBe(expected);
  });
});
