import { getConfigOverrideIssues } from './overrides';

describe('getConfigOverrideIssues', () => {
  it('accepts a partial section whose provided fields are valid', () => {
    expect(
      getConfigOverrideIssues({
        registration: { allowedDomains: ['a.com'] },
        interface: { schedules: { maxPerUser: 2 } },
        mcpServers: { github: { timeout: 5000 } },
      }),
    ).toEqual([]);
  });

  it('reports each invalid field by its dot-path', () => {
    expect(
      getConfigOverrideIssues({
        registration: { oauthStateTtlMs: 5 },
        balance: { enabled: 'yes' },
        mcpServers: { github: { timeout: 'x' } },
      }).map((issue) => issue.path),
    ).toEqual(['registration.oauthStateTtlMs', 'balance.enabled', 'mcpServers.github.timeout']);
  });

  it('checks a field path against the schema it addresses', () => {
    expect(getConfigOverrideIssues(120_000, 'registration.oauthStateTtlMs')).toEqual([]);
    expect(getConfigOverrideIssues(5, 'registration.oauthStateTtlMs')).toEqual([
      expect.objectContaining({ path: 'registration.oauthStateTtlMs' }),
    ]);
    expect(getConfigOverrideIssues('bad', 'endpoints.custom.0.models')).toEqual([
      expect.objectContaining({ path: 'endpoints.custom.0.models' }),
    ]);
  });

  it('matches either form of a union field and reports the shape that matched', () => {
    expect(getConfigOverrideIssues(false, 'interface.schedules')).toEqual([]);
    expect(getConfigOverrideIssues({ minIntervalMinutes: 5 }, 'interface.schedules')).toEqual([]);
    expect(
      getConfigOverrideIssues({ maxPerUser: 'x' }, 'interface.schedules').map(
        (issue) => issue.path,
      ),
    ).toEqual(['interface.schedules.maxPerUser']);
    expect(getConfigOverrideIssues('x', 'interface.schedules')).toHaveLength(1);
  });

  it('validates merged-by-name array items partially and replaced arrays in full', () => {
    expect(
      getConfigOverrideIssues({ endpoints: { custom: [{ name: 'groq', baseURL: 'https://a' }] } }),
    ).toEqual([]);
    expect(
      getConfigOverrideIssues({ endpoints: { custom: [{ name: 'groq', models: 5 }] } }).map(
        (issue) => issue.path,
      ),
    ).toEqual(['endpoints.custom.0.models']);
    expect(
      getConfigOverrideIssues({ modelSpecs: { list: [{ name: 'x' }] } }).map((issue) => issue.path),
    ).toEqual(['modelSpecs.list']);
  });

  it('requires the merge key on every merged-by-name array item', () => {
    expect(
      getConfigOverrideIssues({
        endpoints: { custom: [{ baseURL: 'https://a' }, { name: '', models: 5 }] },
      }),
    ).toEqual([
      { path: 'endpoints.custom.0', message: 'name: Required' },
      { path: 'endpoints.custom.1', message: 'name: Required' },
    ]);
    expect(getConfigOverrideIssues({ baseURL: 'https://a' }, 'endpoints.custom.0')).toEqual([]);
  });

  it('accepts fields the schema does not define and stored secret shapes', () => {
    expect(getConfigOverrideIssues({ unknownSection: 5 })).toEqual([]);
    expect(getConfigOverrideIssues(3, 'unknown.path')).toEqual([]);
    expect(
      getConfigOverrideIssues({
        endpoints: { custom: [{ name: 'x', apiKey: 'v3:enc', apiKeyPreview: 'sk-...' }] },
        ocr: { apiKey: '' },
      }),
    ).toEqual([]);
  });

  it('rejects null, which would otherwise replace the base value', () => {
    expect(getConfigOverrideIssues({ interface: { contextCost: null } })).toHaveLength(1);
  });
});
