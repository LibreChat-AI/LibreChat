const {
  GENERATION_PROTOCOL_V1,
  GENERATION_PROTOCOL_V2,
  getRequestedGenerationProtocol,
  getServerGenerationProtocol,
  negotiateNewGenerationProtocol,
  negotiateExistingGenerationProtocol,
} = require('../protocol');

describe('generation protocol negotiation', () => {
  test('missing, invalid, or conflicting advertisements fail closed to v1', () => {
    expect(getRequestedGenerationProtocol({})).toBe(GENERATION_PROTOCOL_V1);
    expect(
      getRequestedGenerationProtocol({
        body: { generationProtocolVersion: 2 },
        headers: { 'x-librechat-generation-protocol': 'bogus' },
      }),
    ).toBe(GENERATION_PROTOCOL_V1);
    expect(
      getRequestedGenerationProtocol({
        body: { generationProtocolVersion: 2 },
        headers: { 'x-librechat-generation-protocol': '1' },
      }),
    ).toBe(GENERATION_PROTOCOL_V1);
  });

  test('accepts a consistent v2 advertisement across body, query, and header', () => {
    expect(
      getRequestedGenerationProtocol({
        body: { generationProtocolVersion: 2 },
        query: { generationProtocolVersion: '2' },
        headers: { 'x-librechat-generation-protocol': '2' },
      }),
    ).toBe(GENERATION_PROTOCOL_V2);
  });

  test('advertises protocol v2 for every built-in generation store', () => {
    expect(getServerGenerationProtocol()).toBe(GENERATION_PROTOCOL_V2);
  });

  test('selects the protocol advertised by a new-generation client', () => {
    const current = {
      body: { generationProtocolVersion: 2 },
      headers: { 'x-librechat-generation-protocol': '2' },
    };
    expect(negotiateNewGenerationProtocol(current)).toBe(GENERATION_PROTOCOL_V2);
    expect(negotiateNewGenerationProtocol({})).toBe(GENERATION_PROTOCOL_V1);
  });

  test('never upgrades a live v1 job after new generations move to v2', () => {
    const req = {
      query: { generationProtocolVersion: '2' },
      headers: { 'x-librechat-generation-protocol': '2' },
    };
    expect(
      negotiateExistingGenerationProtocol(req, {
        metadata: { generationProtocolVersion: 1 },
      }),
    ).toBe(GENERATION_PROTOCOL_V1);
    expect(
      negotiateExistingGenerationProtocol(req, {
        metadata: { generationProtocolVersion: 2 },
      }),
    ).toBe(GENERATION_PROTOCOL_V2);
    expect(negotiateExistingGenerationProtocol(req, { metadata: {} })).toBe(GENERATION_PROTOCOL_V1);
  });
});
