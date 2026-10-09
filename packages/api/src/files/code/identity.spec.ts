import FormData from 'form-data';
import { appendCodeEnvFileIdentity, buildCodeEnvDownloadQuery } from './identity';

describe('appendCodeEnvFileIdentity', () => {
  /* Validation rules mirror codeapi's `parseUploadSessionKeyInput`
   * server-side validator. Asserting client-side gives bad callers a
   * synchronous failure with file path + line number, vs. round-tripping
   * a 400 from a multipart POST. */

  it('appends kind/id/version on the multipart form for skill uploads', () => {
    const form = new FormData();
    appendCodeEnvFileIdentity(form, { kind: 'skill', id: 'skill-42', version: 7 });

    /* Spy on the form internally — `getBuffer()` chokes on stream
     * entries other tests append, but the form has only the three
     * scalar fields here so dump-and-grep is safe. */
    const body = form.getBuffer().toString();
    expect(body).toContain('name="kind"');
    expect(body).toContain('skill');
    expect(body).toContain('name="id"');
    expect(body).toContain('skill-42');
    expect(body).toContain('name="version"');
    expect(body).toContain('7');
  });

  it('omits version on the multipart form for non-skill kinds', () => {
    const form = new FormData();
    appendCodeEnvFileIdentity(form, { kind: 'agent', id: 'agent-9' });
    expect(form.getBuffer().toString()).not.toContain('name="version"');
  });

  it('rejects unknown kinds before mutating the form', () => {
    const form = new FormData();
    expect(() =>
      appendCodeEnvFileIdentity(form, {
        kind: 'system' as 'user',
        id: 'x',
      }),
    ).toThrow(/invalid kind/);
    /* form-data emits multipart boundaries even on an empty form, so
     * "did we append" is a substring check, not buffer equality. */
    expect(form.getBuffer().toString()).not.toContain('name="kind"');
    expect(form.getBuffer().toString()).not.toContain('name="id"');
  });

  it('rejects skill identity without a version', () => {
    expect(() =>
      appendCodeEnvFileIdentity(new FormData(), { kind: 'skill', id: 'skill-42' }),
    ).toThrow(/skill.*version/);
  });

  it('rejects version on non-skill kinds', () => {
    expect(() =>
      appendCodeEnvFileIdentity(new FormData(), {
        kind: 'agent',
        id: 'agent-9',
        version: 3,
      }),
    ).toThrow(/version.*skill/);
  });

  it('rejects missing id', () => {
    expect(() => appendCodeEnvFileIdentity(new FormData(), { kind: 'user', id: '' })).toThrow(
      /missing id/,
    );
  });
});

describe('buildCodeEnvDownloadQuery', () => {
  it('builds the canonical user-private query string', () => {
    expect(buildCodeEnvDownloadQuery({ kind: 'user', id: 'user-123' })).toBe(
      '?kind=user&id=user-123',
    );
  });

  it('appends version when kind is skill', () => {
    expect(buildCodeEnvDownloadQuery({ kind: 'skill', id: 'skill-abc', version: 7 })).toBe(
      '?kind=skill&id=skill-abc&version=7',
    );
  });

  it('omits version on agent kind', () => {
    expect(buildCodeEnvDownloadQuery({ kind: 'agent', id: 'agent-xyz' })).toBe(
      '?kind=agent&id=agent-xyz',
    );
  });

  it('URL-encodes ids that contain special characters', () => {
    /* `id` shouldn't normally contain unsafe chars (it's a uuid or
     * mongo ObjectId), but the URLSearchParams plumbing handles it
     * uniformly so a future call site that passes through a
     * user-supplied identifier doesn't accidentally produce a
     * malformed URL. */
    expect(buildCodeEnvDownloadQuery({ kind: 'user', id: 'a b/c?d' })).toMatch(
      /\?kind=user&id=a\+b%2Fc%3Fd/,
    );
  });

  it('throws on unknown kind', () => {
    expect(() => buildCodeEnvDownloadQuery({ kind: 'system' as 'user', id: 'x' })).toThrow(
      /invalid kind/,
    );
  });

  it('throws on skill missing version', () => {
    expect(() => buildCodeEnvDownloadQuery({ kind: 'skill', id: 'skill-42' })).toThrow(
      /skill.*version/,
    );
  });

  it('throws on version with non-skill kind', () => {
    expect(() => buildCodeEnvDownloadQuery({ kind: 'agent', id: 'agent-9', version: 3 })).toThrow(
      /version.*skill/,
    );
  });
});
