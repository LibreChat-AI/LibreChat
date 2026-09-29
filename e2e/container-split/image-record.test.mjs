// image-record.test.mjs — the tested-image record's runner→reporter env hand-off (task 17.5).
//
// The image is resolved in run.mjs's process and reported by a SEPARATE process (the Layer B Jest
// run), so the record crosses through an environment variable. These tests pin the serialize/parse
// pair and the well-formedness gate, so a run that resolved an image cannot silently drop its `image`
// block on the way to the stage-11 reporter (Req 5.12).
//
// Native-ESM Jest under jest.config.mjs (`**/*.test.mjs`); touches no application code (NG1/NG2).

import {
  IMAGE_PROVENANCE,
  IMAGE_RECORD_ENV,
  isImageRecord,
  serializeImageRecord,
  readImageRecord,
} from './image-record.mjs';

const RECORD = Object.freeze({
  reference: 'ghcr.io/example/librechat:harness',
  id: 'sha256:abc123',
  createdAt: '2024-02-03T04:05:06.789Z',
  provenance: IMAGE_PROVENANCE.REUSED,
});

describe('image-record — the runner→reporter hand-off', () => {
  test('a well-formed record round-trips through the environment unchanged', () => {
    const env = { [IMAGE_RECORD_ENV]: serializeImageRecord(RECORD) };
    expect(readImageRecord(env)).toEqual(RECORD);
  });

  test('null id/createdAt survive the round-trip as null (reported, not fabricated)', () => {
    const partial = { reference: 'x:local', id: null, createdAt: null, provenance: 'built' };
    const env = { [IMAGE_RECORD_ENV]: serializeImageRecord(partial) };
    expect(readImageRecord(env)).toEqual(partial);
  });

  test('serializeImageRecord returns null for an absent or malformed record, so no env var is set', () => {
    expect(serializeImageRecord(null)).toBeNull();
    expect(serializeImageRecord(undefined)).toBeNull();
    // A missing reference or an unknown provenance is not a record.
    expect(serializeImageRecord({ provenance: 'reused' })).toBeNull();
    expect(serializeImageRecord({ reference: 'x:local', provenance: 'guessed' })).toBeNull();
  });

  test('readImageRecord returns null for an absent, empty, or unparseable env value', () => {
    expect(readImageRecord({})).toBeNull();
    expect(readImageRecord({ [IMAGE_RECORD_ENV]: '' })).toBeNull();
    expect(readImageRecord({ [IMAGE_RECORD_ENV]: '   ' })).toBeNull();
    expect(readImageRecord({ [IMAGE_RECORD_ENV]: '{not json' })).toBeNull();
    // Parseable JSON that is not a well-formed record reads as absent rather than a partial record.
    expect(readImageRecord({ [IMAGE_RECORD_ENV]: '{"reference":"x:local"}' })).toBeNull();
  });

  test('isImageRecord gates on reference and a known provenance', () => {
    expect(isImageRecord(RECORD)).toBe(true);
    expect(
      isImageRecord({ reference: 'x:local', provenance: 'built', id: null, createdAt: null }),
    ).toBe(true);
    expect(isImageRecord(null)).toBe(false);
    expect(isImageRecord({ reference: '', provenance: 'built' })).toBe(false);
    expect(isImageRecord({ reference: 'x:local', provenance: 'nope' })).toBe(false);
  });
});
