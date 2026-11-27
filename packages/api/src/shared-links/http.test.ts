import {
  buildShareFileEtag,
  parseSharedLinksPageSize,
  isValidSharedLinksCursor,
  DEFAULT_SHARED_LINKS_PAGE_SIZE,
  MAX_SHARED_LINKS_PAGE_SIZE,
} from './http';

const encodeCursor = (payload: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(payload)).toString('base64');

describe('parseSharedLinksPageSize', () => {
  it('falls back to the default for anything unparseable', () => {
    expect(parseSharedLinksPageSize(undefined)).toBe(DEFAULT_SHARED_LINKS_PAGE_SIZE);
    expect(parseSharedLinksPageSize('')).toBe(DEFAULT_SHARED_LINKS_PAGE_SIZE);
    expect(parseSharedLinksPageSize('ten')).toBe(DEFAULT_SHARED_LINKS_PAGE_SIZE);
    expect(parseSharedLinksPageSize('1e3')).toBe(DEFAULT_SHARED_LINKS_PAGE_SIZE);
    expect(parseSharedLinksPageSize(25)).toBe(DEFAULT_SHARED_LINKS_PAGE_SIZE);
  });

  it('clamps to a sane range', () => {
    expect(parseSharedLinksPageSize('1000')).toBe(MAX_SHARED_LINKS_PAGE_SIZE);
    expect(parseSharedLinksPageSize('0')).toBe(1);
    expect(parseSharedLinksPageSize('-5')).toBe(1);
    expect(parseSharedLinksPageSize('25')).toBe(25);
  });
});

describe('isValidSharedLinksCursor', () => {
  const id = '0123456789abcdef01234567';

  it('accepts a composite cursor for either sort', () => {
    expect(isValidSharedLinksCursor(encodeCursor({ primary: 'Title', id }), 'title')).toBe(true);
    expect(
      isValidSharedLinksCursor(
        encodeCursor({ primary: '2026-01-01T00:00:00.000Z', id }),
        'createdAt',
      ),
    ).toBe(true);
  });

  it('accepts a titleless boundary only where the field can be absent', () => {
    expect(isValidSharedLinksCursor(encodeCursor({ primary: null, id }), 'title')).toBe(true);
    // createdAt is always stamped, so a null boundary could not have been issued.
    expect(isValidSharedLinksCursor(encodeCursor({ primary: null, id }), 'createdAt')).toBe(false);
  });

  it('rejects a composite cursor whose id could not have been issued', () => {
    // Without a usable id it is not a composite cursor, so it has to stand on its own
    // as a legacy value: for a createdAt page that means parsing as a date.
    expect(
      isValidSharedLinksCursor(
        encodeCursor({ primary: '2026-01-01T00:00:00.000Z', id: 'nope' }),
        'createdAt',
      ),
    ).toBe(false);
  });

  it('still accepts the plain value older links carry', () => {
    expect(isValidSharedLinksCursor('2026-01-01T00:00:00.000Z', 'createdAt')).toBe(true);
    expect(isValidSharedLinksCursor('not-a-date', 'createdAt')).toBe(false);
    expect(isValidSharedLinksCursor('Some Title', 'title')).toBe(true);
  });

  it('accepts a cursor carrying a long title but rejects an absurd one', () => {
    const longTitle = 'T'.repeat(1024);
    expect(isValidSharedLinksCursor(encodeCursor({ primary: longTitle, id }), 'title')).toBe(true);
    expect(isValidSharedLinksCursor('a'.repeat(8193), 'title')).toBe(false);
  });
});

describe('buildShareFileEtag', () => {
  const file = {
    file_id: 'file-1',
    previewRevision: 'rev-1',
    bytes: 1234,
    storageKey: 'uploads/user/plot.png',
    filepath: '/images/user/plot.png?v=1',
  };

  it('is stable for an unchanged snapshot', () => {
    expect(buildShareFileEtag(file)).toBe(buildShareFileEtag({ ...file }));
    expect(buildShareFileEtag(file)).toMatch(/^"share-[0-9a-f]{32}"$/);
  });

  it('moves when any part of the snapshot identity moves', () => {
    const base = buildShareFileEtag(file);
    expect(buildShareFileEtag({ ...file, previewRevision: 'rev-2' })).not.toBe(base);
    expect(buildShareFileEtag({ ...file, bytes: 1235 })).not.toBe(base);
    expect(buildShareFileEtag({ ...file, storageKey: 'uploads/user/other.png' })).not.toBe(base);
    // A same-size republish keeps its size and revision but moves the stored object.
    expect(buildShareFileEtag({ ...file, filepath: '/images/user/plot.png?v=2' })).not.toBe(base);
  });

  it('does not collide when a value shifts across fields', () => {
    expect(buildShareFileEtag({ file_id: 'a', storageKey: 'b' })).not.toBe(
      buildShareFileEtag({ file_id: 'ab' }),
    );
  });
});
