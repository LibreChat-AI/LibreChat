import type { DirectContentEntry } from './reading';
import {
  excelFileTypes,
  fullMimeTypesList,
  retrievalMimeTypesList,
  fileConfig as baseFileConfig,
  codeInterpreterMimeTypesList,
} from './file-config';
import {
  AFTER_FAILURE,
  READING_ORDER,
  isOriginalBacked,
  isTextOnlyRecord,
  categorizeForReading,
  allocateDirectContent,
} from './reading';
import { FileSources } from './types/files';

const TABULAR_TYPES = [
  ...excelFileTypes,
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/csv',
  'application/csv',
  'text/tab-separated-values',
  'application/x-parquet',
  'application/vnd.apache.parquet',
];

const DOCUMENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/zip',
  'application/epub+zip',
  'application/json',
  'text/markdown',
  'text/plain',
  'message/rfc822',
  'application/vnd.oasis.opendocument.text',
];

const MEDIA_TYPES = ['image/png', 'image/jpeg', 'audio/mpeg', 'video/mp4'];

const entry = (
  fileId: string,
  bytes: number,
  textChars = 0,
  counts = true,
): DirectContentEntry => ({ fileId, bytes, textChars, counts });

const sorted = (ids: ReadonlySet<string>): string[] => Array.from(ids).sort();

describe('allocateDirectContent', () => {
  it('admits candidates first-fit in the order given', () => {
    const overflow = allocateDirectContent([], [entry('a', 60), entry('b', 50), entry('c', 30)], {
      bytes: 100,
    });
    expect(sorted(overflow)).toEqual(['b']);
  });

  it('charges committed content before any candidate', () => {
    const overflow = allocateDirectContent(
      [entry('history', 70)],
      [entry('a', 60), entry('b', 50), entry('c', 30)],
      { bytes: 100 },
    );
    expect(sorted(overflow)).toEqual(['a', 'b']);
  });

  it('admits a candidate that lands exactly on the limit', () => {
    expect(allocateDirectContent([entry('h', 40)], [entry('a', 60)], { bytes: 100 }).size).toBe(0);
  });

  it('judges each limit dimension on its own', () => {
    const candidates = [entry('a', 10, 500), entry('b', 10, 600), entry('c', 10, 100)];
    expect(sorted(allocateDirectContent([], candidates, { textChars: 1000 }))).toEqual(['b']);
    expect(sorted(allocateDirectContent([], candidates, { count: 2 }))).toEqual(['c']);
    expect(sorted(allocateDirectContent([], candidates, { bytes: 25 }))).toEqual(['c']);
  });

  it('does not charge the count for a file that does not count', () => {
    const candidates = [entry('a', 1), entry('output', 1, 0, false), entry('b', 1)];
    expect(sorted(allocateDirectContent([entry('h', 1)], candidates, { count: 3 }))).toEqual([]);
    expect(sorted(allocateDirectContent([entry('h', 1)], candidates, { count: 2 }))).toEqual(['b']);
  });

  it('treats a missing or zero limit as unlimited', () => {
    const candidates = [entry('a', 10_000, 10_000), entry('b', 10_000, 10_000)];
    expect(allocateDirectContent([], candidates, {}).size).toBe(0);
    expect(allocateDirectContent([], candidates, { count: 0, bytes: 0, textChars: 0 }).size).toBe(
      0,
    );
    expect(sorted(allocateDirectContent([], candidates, { bytes: 0, textChars: 15_000 }))).toEqual([
      'b',
    ]);
  });
});

describe('categorizeForReading', () => {
  it.each(TABULAR_TYPES)('classifies %s as tabular', (mimeType) => {
    expect(categorizeForReading(mimeType)).toBe('tabular');
  });

  it.each(DOCUMENT_TYPES)('classifies %s as a document', (mimeType) => {
    expect(categorizeForReading(mimeType)).toBe('document');
  });

  it.each(MEDIA_TYPES)('classifies %s as media', (mimeType) => {
    expect(categorizeForReading(mimeType)).toBe('media');
  });

  it('ignores parameters and case, as browsers send both', () => {
    expect(categorizeForReading('Text/CSV; charset=utf-8')).toBe('tabular');
    expect(categorizeForReading(' APPLICATION/VND.MS-EXCEL ')).toBe('tabular');
    expect(categorizeForReading('IMAGE/PNG')).toBe('media');
    expect(categorizeForReading('text/plain; charset=utf-8')).toBe('document');
  });

  it('treats an unknown or missing type as a document', () => {
    expect(categorizeForReading('')).toBe('document');
    expect(categorizeForReading('application/octet-stream')).toBe('document');
  });
});

describe('tabular classification stays inside admission', () => {
  it('admits every known type it classifies as tabular', () => {
    const known = [
      ...fullMimeTypesList,
      ...codeInterpreterMimeTypesList,
      ...retrievalMimeTypesList,
      ...TABULAR_TYPES,
    ];
    const unadmitted = known.filter(
      (mimeType) =>
        categorizeForReading(mimeType) === 'tabular' &&
        !baseFileConfig.checkType(mimeType, baseFileConfig.endpoints.default.supportedMimeTypes),
    );
    expect(unadmitted).toEqual([]);
  });
});

describe('record sources', () => {
  it('treats a record without a source as holding the original', () => {
    expect(isOriginalBacked({})).toBe(true);
    expect(isOriginalBacked({ source: null })).toBe(true);
  });

  it('marks only a text source as text-only', () => {
    expect(isTextOnlyRecord({ source: FileSources.text })).toBe(true);
    expect(isTextOnlyRecord({ source: FileSources.local })).toBe(false);
    expect(isTextOnlyRecord({})).toBe(false);
  });
});

describe('reading rule data', () => {
  it('orders each category over all four readers exactly once', () => {
    Object.values(READING_ORDER).forEach((order) => {
      expect(order.slice().sort()).toEqual(['code', 'provider', 'search', 'text']);
    });
  });

  it('never retries a direct reader after a capacity or encode-time failure', () => {
    const direct = ['provider', 'text'];
    Object.values(AFTER_FAILURE).forEach((map) => {
      expect(map.native_rejected?.some((reader) => direct.includes(reader))).toBe(false);
      expect(map.aggregate_overflow?.some((reader) => direct.includes(reader))).toBe(false);
      expect(map.native_capacity?.includes('provider') ?? false).toBe(false);
    });
  });

  it('tries File Search before text after a native capacity failure', () => {
    Object.values(AFTER_FAILURE).forEach((map) => {
      const order = map.native_capacity ?? [];
      expect(order.indexOf('search')).toBe(0);
      expect(order.indexOf('text')).toBe(order.length - 1);
    });
  });
});
