import type { TPlugin } from 'librechat-data-provider';
import { pluginNeedsAuth } from '../auth';

const base: TPlugin = { name: 'Tool', pluginKey: 'tool' };

describe('pluginNeedsAuth', () => {
  it('returns true when auth fields are declared and not authenticated', () => {
    expect(
      pluginNeedsAuth({
        ...base,
        authConfig: [{ authField: 'API_KEY', label: 'Key', description: '' }],
      }),
    ).toBe(true);
  });

  it('returns false when already authenticated', () => {
    expect(
      pluginNeedsAuth({
        ...base,
        authConfig: [{ authField: 'API_KEY', label: 'Key', description: '' }],
        authenticated: true,
      }),
    ).toBe(false);
  });

  it('returns false when no auth fields are declared', () => {
    expect(pluginNeedsAuth(base)).toBe(false);
    expect(pluginNeedsAuth({ ...base, authConfig: [] })).toBe(false);
  });
});
