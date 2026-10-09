import {
  isAgentFadingTier,
  isCurrentAgentFadingTier,
  isAgentFadingTierEntries,
  isAgentFadingTierEntry,
} from './fading';

const tier = { v: 2, budgetTokens: 20_000, masked: true };

describe('isAgentFadingTier', () => {
  it('accepts the compact shape and rejects anything else', () => {
    expect(isAgentFadingTier(tier)).toBe(true);
    expect(isAgentFadingTier({ ...tier, v: 1 })).toBe(true);
    expect(isCurrentAgentFadingTier(tier)).toBe(true);
    expect(isCurrentAgentFadingTier({ ...tier, v: 1 })).toBe(false);
    expect(isAgentFadingTier({ ...tier, v: 3 })).toBe(false);
    expect(isAgentFadingTier({ ...tier, budgetTokens: 0 })).toBe(false);
    expect(isAgentFadingTier({ ...tier, masked: 'yes' })).toBe(false);
    expect(isAgentFadingTier(null)).toBe(false);
  });
});

describe('isAgentFadingTierEntry', () => {
  it('requires a non-empty agent ID on a valid tier, however long', () => {
    expect(isAgentFadingTierEntry({ agentId: 'agent-a', ...tier })).toBe(true);
    expect(isAgentFadingTierEntry({ agentId: '', ...tier })).toBe(false);
    /** Ephemeral agent IDs encode endpoint, model and sender without a bound. */
    expect(isAgentFadingTierEntry({ agentId: 'ephemeral|'.repeat(200), ...tier })).toBe(true);
    expect(isAgentFadingTierEntry({ agentId: 'agent-a', ...tier, budgetTokens: -1 })).toBe(false);
    expect(isAgentFadingTierEntry(tier)).toBe(false);
  });
});

describe('isAgentFadingTierEntries', () => {
  it('accepts unique valid entries and rejects duplicates or malformed members', () => {
    expect(
      isAgentFadingTierEntries([
        { agentId: 'agent-a', ...tier },
        { agentId: 'agent-b', ...tier, masked: false },
      ]),
    ).toBe(true);
    expect(isAgentFadingTierEntries([])).toBe(true);
    expect(
      isAgentFadingTierEntries([
        { agentId: 'agent-a', ...tier },
        { agentId: 'agent-a', ...tier },
      ]),
    ).toBe(false);
    expect(isAgentFadingTierEntries([{ agentId: 'agent-a', ...tier }, tier])).toBe(false);
    expect(isAgentFadingTierEntries({ 'agent-a': tier })).toBe(false);
  });
});
