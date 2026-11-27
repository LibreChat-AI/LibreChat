import { anthropicEndpointSchema } from './config';

describe('Anthropic endpoint webSearchToolVersion', () => {
  it('is optional so the default tool version stays in effect', () => {
    const parsed = anthropicEndpointSchema.parse({});
    expect(parsed.webSearchToolVersion).toBeUndefined();
  });

  it.each(['web_search_20250305', 'web_search_20260209', 'web_search_20260318'])(
    'accepts %s',
    (version) => {
      expect(anthropicEndpointSchema.parse({ webSearchToolVersion: version })).toMatchObject({
        webSearchToolVersion: version,
      });
    },
  );

  it.each(['web_search_20990101', 'web_search', ''])('rejects %p', (version) => {
    expect(anthropicEndpointSchema.safeParse({ webSearchToolVersion: version }).success).toBe(
      false,
    );
  });
});
