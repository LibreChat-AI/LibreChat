import { DEFAULT_LOOKUP_CONCURRENCY, getLookupConcurrency } from './concurrency';

describe('getLookupConcurrency', () => {
  it('falls back to the default for each key', () => {
    expect(getLookupConcurrency(undefined, 'mcpCatalogLookups')).toBe(
      DEFAULT_LOOKUP_CONCURRENCY.mcpCatalogLookups,
    );
    expect(getLookupConcurrency({ concurrency: { skillNameLookups: 2 } }, 'resumeAgentLoads')).toBe(
      DEFAULT_LOOKUP_CONCURRENCY.resumeAgentLoads,
    );
  });

  it('bounds permission principal lookups with a configurable default', () => {
    expect(getLookupConcurrency(undefined, 'permissionPrincipalLookups')).toBe(4);
    expect(
      getLookupConcurrency(
        { concurrency: { permissionPrincipalLookups: 2 } },
        'permissionPrincipalLookups',
      ),
    ).toBe(2);
  });

  it('uses the configured value, including 1 for serial lookups', () => {
    expect(getLookupConcurrency({ concurrency: { skillNameLookups: 1 } }, 'skillNameLookups')).toBe(
      1,
    );
  });
});
