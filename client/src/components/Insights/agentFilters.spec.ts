import { clearAgentFilters, shouldRecoverAgentFilters } from './agentFilters';

describe('Insights agent filter recovery', () => {
  it('removes only agent filters from a stale bookmarked URL', () => {
    const params = clearAgentFilters(
      new URLSearchParams('agentIds=deleted-agent&agentIds=revoked-agent&range=30d'),
    );

    expect(params.getAll('agentIds')).toEqual([]);
    expect(params.get('range')).toBe('30d');
  });

  it('recovers only authorization failures with explicit agent filters', () => {
    expect(shouldRecoverAgentFilters(403, ['revoked-agent'])).toBe(true);
    expect(shouldRecoverAgentFilters(403, [])).toBe(false);
    expect(shouldRecoverAgentFilters(500, ['agent-a'])).toBe(false);
  });
});
