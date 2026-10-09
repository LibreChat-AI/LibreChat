import {
  assertS3FileName,
  assertPathSegment,
  sanitizeContentDispositionFilename,
} from '../validation';

describe('assertPathSegment', () => {
  it('returns safe single path segments', () => {
    expect(assertPathSegment('userId', 'user123', 'test')).toBe('user123');
  });

  it('rejects empty, slash, traversal, and control-character segments', () => {
    expect(() => assertPathSegment('userId', '', 'test')).toThrow('must not be empty');
    expect(() => assertPathSegment('userId', null, 'test')).toThrow('must not be empty');
    expect(() => assertPathSegment('userId', undefined, 'test')).toThrow('must not be empty');
    expect(() => assertPathSegment('userId', 'user/123', 'test')).toThrow(
      'must not contain slashes',
    );
    expect(() => assertPathSegment('userId', '..', 'test')).toThrow(
      'must not contain path traversal',
    );
    expect(assertPathSegment('tenantId', 'tenant..legacy', 'test')).toBe('tenant..legacy');
    expect(() => assertPathSegment('userId', 'user\u0000id', 'test')).toThrow(
      'contains unsafe path characters',
    );
    expect(() => assertPathSegment('userId', 'user\u007fid', 'test')).toThrow(
      'contains unsafe path characters',
    );
  });
});

describe('assertS3FileName', () => {
  it('allows nested S3 file names', () => {
    expect(assertS3FileName('fileName', 'reports/2026/output.csv', 'test')).toBe(
      'reports/2026/output.csv',
    );
  });

  it('rejects traversal, empty components, backslashes, and control characters', () => {
    expect(() => assertS3FileName('fileName', '../secret.txt', 'test')).toThrow(
      'must not contain path traversal',
    );
    expect(() => assertS3FileName('fileName', 'reports//output.csv', 'test')).toThrow(
      'must not contain empty path components',
    );
    expect(() => assertS3FileName('fileName', 'reports\\output.csv', 'test')).toThrow(
      'must not contain backslashes',
    );
    expect(() => assertS3FileName('fileName', 'report\u0000.csv', 'test')).toThrow(
      'contains unsafe path characters',
    );
  });
});

describe('sanitizeContentDispositionFilename', () => {
  it('strips quoted-string and header separator characters', () => {
    expect(sanitizeContentDispositionFilename('report";\\\r\nbad.pdf')).toBe('reportbad.pdf');
  });

  it('strips all ASCII control characters from header filenames', () => {
    expect(sanitizeContentDispositionFilename('report\u0000\t\u001fbad\u007f.pdf')).toBe(
      'reportbad.pdf',
    );
  });

  it('returns a safe fallback when all filename characters are stripped', () => {
    expect(sanitizeContentDispositionFilename('";\\\r\n')).toBe('download');
  });
});
