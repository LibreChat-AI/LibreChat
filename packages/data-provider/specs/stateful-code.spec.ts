import {
  STATEFUL_CODE_ENVIRONMENTS,
  resolveStatefulCodeEnvironment,
  resolveAllowedStatefulCodeEnvironments,
} from '../src/types/agents';

describe('stateful code environment policy', () => {
  it('allows every environment when deployment configuration is omitted', () => {
    expect(resolveAllowedStatefulCodeEnvironments()).toEqual(STATEFUL_CODE_ENVIRONMENTS);
  });

  it('returns configured environments in stable UI order', () => {
    expect(resolveAllowedStatefulCodeEnvironments(['conversation', 'user'])).toEqual([
      'user',
      'conversation',
    ]);
  });

  it('falls back to the first allowed environment when a preference is unavailable', () => {
    expect(resolveStatefulCodeEnvironment('user', ['agent-user', 'conversation'])).toBe(
      'agent-user',
    );
  });
});
