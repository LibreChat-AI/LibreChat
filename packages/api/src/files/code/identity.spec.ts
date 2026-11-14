import FormData from 'form-data';
import {
  appendCodeEnvFileIdentity,
  buildCodeEnvDownloadQuery,
  getCodeEnvSessionFileIds,
} from './identity';

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

describe('getCodeEnvSessionFileIds', () => {
  const canonical = (id: string) =>
    `session/.codeapi-objects/${Buffer.from(id).toString('base64url')}`;

  it('indexes hosted, canonical and legacy identities without guessing dotted IDs', () => {
    expect(
      getCodeEnvSessionFileIds(
        [
          { fileId: 'hosted', name: canonical('not-hosted') },
          { name: canonical('dotted.id') },
          { name: 'session/report.csv' },
          { name: 'session/report.csv.txt' },
          { name: 'session/extensionless' },
        ],
        'session',
      ),
    ).toEqual(new Set(['hosted', 'dotted.id', 'report', 'report.csv', 'extensionless']));
    expect(
      getCodeEnvSessionFileIds([{ name: 'session/report.csv' }], 'session').has('report.csv'),
    ).toBe(false);
    expect(
      getCodeEnvSessionFileIds([{ name: canonical('report.csv') }], 'session').has('report'),
    ).toBe(false);
  });

  it.each([
    null,
    false,
    'report',
    42,
    {},
    { fileId: 42 },
    { name: 42 },
    { name: 'session-other/report.csv' },
    { name: 'other/.codeapi-objects/cmVwb3J0' },
    { name: 'prefix/session/report.csv' },
    { name: 'session/nested/report.csv' },
    { name: 'session//report.csv' },
    { name: 'session/./report.csv' },
    { name: 'session/../report.csv' },
    { name: 'session/..\\report.csv' },
    { name: 'session/report\u0000.csv' },
    { name: 'session/.codeapi-objects/' },
    { name: 'session/.codeapi-objects/cmVwb3J0=' },
    { name: 'session/.codeapi-objects/cmVwb3J0/extra' },
    { name: 'session/.codeapi-objects/%63mVwb3J0' },
    { name: 'session/.codeapi-objects/_w' },
    { name: 'session/.codeapi-objects/Zh' },
  ])('does not derive an identity from malformed or cross-session entry %p', (entry) => {
    expect(getCodeEnvSessionFileIds([entry], 'session').size).toBe(0);
  });

  it('does not decode URL paths or match file ID prefixes', () => {
    const ids = getCodeEnvSessionFileIds(
      [
        { name: 'session/report%2Ecsv.txt' },
        { name: 'session/report-extra.csv' },
        { name: canonical('report-extra') },
      ],
      'session',
    );
    expect(ids).toEqual(new Set(['report%2Ecsv', 'report-extra']));
    expect(ids.has('report')).toBe(false);
    expect(ids.has('report.csv')).toBe(false);
  });

  it('reads each summary entry a constant number of times for a large session', () => {
    const name = jest.fn(() => 'session/report.csv');
    const summaries = Array.from({ length: 10_000 }, () => ({
      get name() {
        return name();
      },
    }));
    const ids = getCodeEnvSessionFileIds(summaries, 'session');
    for (let index = 0; index < 10_000; index++) expect(ids.has('report')).toBe(true);
    expect(name.mock.calls.length).toBeLessThanOrEqual(30_000);
  });
});
