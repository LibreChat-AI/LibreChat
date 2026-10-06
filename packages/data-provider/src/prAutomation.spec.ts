import { configSchema } from './config';
import { clampPRAutomationTrust } from './types/prAutomation';
import type { PRAutomationTrustLevel } from './types/prAutomation';

describe('clampPRAutomationTrust', () => {
  it('defaults to the narrowest level when the user chose nothing', () => {
    expect(clampPRAutomationTrust(undefined, 'anyone')).toBe('approvedBots');
  });

  it.each<[PRAutomationTrustLevel, PRAutomationTrustLevel, PRAutomationTrustLevel]>([
    ['anyone', 'approvedBots', 'approvedBots'],
    ['collaborators', 'approvedBots', 'approvedBots'],
    ['anyone', 'collaborators', 'collaborators'],
    ['approvedBots', 'anyone', 'approvedBots'],
    ['collaborators', 'anyone', 'collaborators'],
    ['anyone', 'anyone', 'anyone'],
  ])('requested %s under a %s ceiling gives %s', (requested, ceiling, expected) => {
    expect(clampPRAutomationTrust(requested, ceiling)).toBe(expected);
  });

  it('falls back to the narrowest level for a value it does not know', () => {
    expect(clampPRAutomationTrust('everyone' as unknown as PRAutomationTrustLevel, 'anyone')).toBe(
      'approvedBots',
    );
  });
});

describe('agent PR automation config', () => {
  const parse = (prAutomation?: unknown) =>
    configSchema.safeParse({ version: '1.0', endpoints: { agents: { prAutomation } } });

  it('is absent when not configured, which leaves it off', () => {
    const absent = configSchema.parse({ version: '1.0', endpoints: { agents: {} } });
    expect(absent.endpoints?.agents?.prAutomation).toBeUndefined();
  });

  it('defaults to disabled with the narrowest ceiling', () => {
    const empty = configSchema.parse({
      version: '1.0',
      endpoints: { agents: { prAutomation: {} } },
    });
    expect(empty.endpoints?.agents?.prAutomation).toEqual({
      enabled: false,
      maxRounds: 5,
      maxMinutes: 120,
      maxTrust: 'approvedBots',
    });
  });

  it('accepts an administrator raising the limits and the ceiling', () => {
    const result = parse({
      enabled: true,
      maxRounds: 10,
      maxMinutes: 240,
      maxTrust: 'collaborators',
    });
    expect(result.success).toBe(true);
  });

  it.each([0, 21, 1.5])('rejects %s fix rounds', (maxRounds) => {
    expect(parse({ maxRounds }).success).toBe(false);
  });

  it.each([4, 1441, 1.5])('rejects a %s minute window', (maxMinutes) => {
    expect(parse({ maxMinutes }).success).toBe(false);
  });

  it.each(['everyone', 'bots', ''])('rejects %s as a trust ceiling', (maxTrust) => {
    expect(parse({ maxTrust }).success).toBe(false);
  });
});
