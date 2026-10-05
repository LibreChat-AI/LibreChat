import {
  DEFAULT_MCP_APP_CSP_LIMITS,
  MCP_APP_CSP_MAX_DOMAINS,
  normalizeMCPAppCspDeclaration,
  resolveMCPAppCspLimits,
} from './csp';

describe('normalizeMCPAppCspDeclaration', () => {
  it('normalizes every supported directive through one source grammar', () => {
    const declaration = normalizeMCPAppCspDeclaration({
      resourceDomains: [' https://cdn.example.com '],
      connectDomains: ['wss://events.example.com', '*'],
      frameDomains: ['https://embed.example.com'],
      baseUriDomains: ['https://base.example.com/path'],
      ignored: ['https://ignored.example.com'],
    });

    expect(declaration).toEqual({
      resourceDomains: ['https://cdn.example.com'],
      connectDomains: ['wss://events.example.com'],
      frameDomains: ['https://embed.example.com'],
      baseUriDomains: ['https://base.example.com/path'],
    });
  });

  it('returns the restrictive empty declaration for invalid input', () => {
    expect(normalizeMCPAppCspDeclaration(null)).toEqual({});
    expect(normalizeMCPAppCspDeclaration([])).toEqual({});
    expect(normalizeMCPAppCspDeclaration({ connectDomains: ['javascript:alert(1)'] })).toEqual({});
  });

  it('caps each directive independently', () => {
    const domains = Array.from(
      { length: MCP_APP_CSP_MAX_DOMAINS + 4 },
      (_unused, index) => `https://host${index}.example.com`,
    );
    const declaration = normalizeMCPAppCspDeclaration({
      connectDomains: domains,
      frameDomains: domains,
    });

    expect(declaration.connectDomains).toHaveLength(MCP_APP_CSP_MAX_DOMAINS);
    expect(declaration.frameDomains).toHaveLength(MCP_APP_CSP_MAX_DOMAINS);
  });

  it('uses one injected source limit for every directive', () => {
    const domains = Array.from({ length: 5 }, (_, index) => `https://host${index}.example.com`);
    const declaration = normalizeMCPAppCspDeclaration(
      { connectDomains: domains, frameDomains: domains },
      { maxSourcesPerDirective: 3 },
    );

    expect(declaration.connectDomains).toHaveLength(3);
    expect(declaration.frameDomains).toHaveLength(3);
  });

  it('falls back per field when published limits are missing or malformed', () => {
    expect(resolveMCPAppCspLimits()).toEqual(DEFAULT_MCP_APP_CSP_LIMITS);
    expect(
      resolveMCPAppCspLimits({
        maxSourcesPerDirective: 0,
        maxSerializedLength: 8192,
      }),
    ).toEqual({ maxSourcesPerDirective: 32, maxSerializedLength: 8192 });
  });

  it('is idempotent', () => {
    const once = normalizeMCPAppCspDeclaration({
      connectDomains: [' https://api.example.com ', '*'],
      frameDomains: ['https://embed.example.com'],
    });
    expect(normalizeMCPAppCspDeclaration(once)).toEqual(once);
  });
});
