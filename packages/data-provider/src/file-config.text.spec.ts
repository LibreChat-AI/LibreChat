import {
  isPermissiveMimeConfig,
  defaultTextMimeTypes,
  mergeFileConfig,
  inferMimeType,
} from './file-config';

describe('default text MIME configuration', () => {
  const fileConfig = mergeFileConfig({});
  const accepts = (mimeType: string) =>
    fileConfig.checkType?.(mimeType, fileConfig.text?.supportedMimeTypes ?? []);

  it.each([
    'text/x-c++',
    'text/x-c++src',
    'text/x-c++hdr',
    'application/ld+json',
    'application/vnd.api+json',
    'image/svg+xml',
  ])('accepts MIME types containing +: %s', (mimeType) => {
    expect(accepts(mimeType)).toBe(true);
  });

  it('accepts the MIME type inferred for a C++ source file', () => {
    const mimeType = inferMimeType('main.cpp', '');
    expect(mimeType).toBe('text/x-c++');
    expect(accepts(mimeType)).toBe(true);
  });

  it.each([
    'text/plain',
    'application/pdf',
    'application/octet-stream',
    'application/vnd.ms-excel',
  ])('preserves previously accepted MIME types: %s', (mimeType) => {
    expect(accepts(mimeType)).toBe(true);
  });

  it.each([
    '',
    'text',
    '/plain',
    'text/',
    'text//plain',
    'text/plain/extra',
    'text/pl ain',
    ' text/plain',
    'text/plain; charset=utf-8',
  ])('rejects malformed MIME types: %s', (mimeType) => {
    expect(accepts(mimeType)).toBe(false);
  });

  it('keeps the default and merged text configuration permissive for RAG routing', () => {
    expect(isPermissiveMimeConfig(defaultTextMimeTypes)).toBe(true);
    expect(isPermissiveMimeConfig(fileConfig.text?.supportedMimeTypes)).toBe(true);
  });
});
