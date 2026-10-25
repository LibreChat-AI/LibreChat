jest.mock('@tanstack/react-query', () => ({
  useMutation: () => ({}),
}));

import { resolveSharePointContentType, GENERIC_MIME_TYPE } from '../sharepoint';

describe('resolveSharePointContentType', () => {
  it('preserves specific content-type headers and strips charset/boundary parameters', () => {
    expect(resolveSharePointContentType('application/pdf; charset=UTF-8', 'document.pdf')).toBe(
      'application/pdf',
    );
    expect(resolveSharePointContentType('image/png', 'photo.png')).toBe('image/png');
    expect(resolveSharePointContentType('text/plain; charset=utf-8', 'notes.txt')).toBe(
      'text/plain',
    );
  });

  it('falls back to getMimeTypeFromFileName when header is application/octet-stream', () => {
    expect(resolveSharePointContentType('application/octet-stream', 'data.csv')).toBe('text/csv');
    expect(
      resolveSharePointContentType('application/octet-stream; charset=binary', 'financials.xlsx'),
    ).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(resolveSharePointContentType('application/octet-stream', 'slides.pptx')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    expect(resolveSharePointContentType('application/octet-stream', 'doc.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(resolveSharePointContentType('application/octet-stream', 'manual.pdf')).toBe(
      'application/pdf',
    );
  });

  it('falls back to inferMimeType for source and code extensions when header is application/octet-stream', () => {
    expect(resolveSharePointContentType('application/octet-stream', 'script.py')).toBe(
      'text/x-python',
    );
    expect(resolveSharePointContentType('application/octet-stream', 'config.json')).toBe(
      'application/json',
    );
    expect(resolveSharePointContentType('application/octet-stream', 'readme.md')).toBe(
      'text/markdown',
    );
  });

  it('falls back to extension resolution when header is null or undefined', () => {
    expect(resolveSharePointContentType(null, 'table.csv')).toBe('text/csv');
    expect(resolveSharePointContentType(undefined, 'app.py')).toBe('text/x-python');
    expect(resolveSharePointContentType('', 'document.pdf')).toBe('application/pdf');
  });

  it('returns application/octet-stream when neither header nor extension can be mapped', () => {
    expect(resolveSharePointContentType('application/octet-stream', 'archive.7z')).toBe(
      GENERIC_MIME_TYPE,
    );
    expect(resolveSharePointContentType(null, 'unrecognized_file')).toBe(GENERIC_MIME_TYPE);
  });
});
