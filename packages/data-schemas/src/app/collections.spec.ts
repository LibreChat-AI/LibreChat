import { isConfigTombstoneAtOrBelow, getConfigTombstoneSegments } from './collections';

const CUSTOM = ['endpoints', 'custom'];

describe('stored tombstones compared with a path', () => {
  it('counts a keyed tombstone below a path at or above its array, never below a position in it', () => {
    const keyed = 'endpoints.custom["a.b"].headers';
    const below = (segments: string[]) => isConfigTombstoneAtOrBelow(keyed, { segments });
    expect(below(['endpoints'])).toBe(true);
    expect(below(CUSTOM)).toBe(true);
    expect(below(['endpoints', 'custom', '0'])).toBe(false);
    expect(below(['endpoints', 'openAI'])).toBe(false);
    expect(isConfigTombstoneAtOrBelow('endpoints.custom["broken', { segments: CUSTOM })).toBe(
      false,
    );
    expect(
      isConfigTombstoneAtOrBelow('endpoints.custom["broken', { segments: ['endpoints'] }),
    ).toBe(true);
  });

  it('splits a tombstone holding `["` after anything but an array merged by key on its dots', () => {
    const legacy = 'mcpServers.a["b"]';
    expect(getConfigTombstoneSegments(legacy)).toEqual(['mcpServers', 'a["b"]']);
    expect(getConfigTombstoneSegments('endpoints.custom["a.b"]')).toEqual(CUSTOM);
    expect(isConfigTombstoneAtOrBelow(legacy, { segments: ['mcpServers', 'a["b"]'] })).toBe(true);
    expect(isConfigTombstoneAtOrBelow(legacy, { segments: ['mcpServers', 'a'] })).toBe(false);
  });
});
