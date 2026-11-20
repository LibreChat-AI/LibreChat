import { getCodeEnvScope, isCodeRefInScope } from './scope';

describe('getCodeEnvScope', () => {
  it("files an agent's own resource under the agent and everything else under the user", () => {
    const identity = { agentId: 'agent', userId: 'user' };
    expect(getCodeEnvScope({ agentScoped: true, ...identity })).toEqual({
      kind: 'agent',
      id: 'agent',
    });
    expect(getCodeEnvScope({ agentScoped: false, ...identity })).toEqual({
      kind: 'user',
      id: 'user',
    });
  });
});

describe('isCodeRefInScope', () => {
  const user = { kind: 'user' as const, id: 'user' };
  const agent = { kind: 'agent' as const, id: 'agent' };

  it('accepts only a pointer filed under the same kind and id', () => {
    expect(isCodeRefInScope({ kind: 'user', id: 'user' }, user)).toBe(true);
    expect(isCodeRefInScope({ kind: 'agent', id: 'agent' }, agent)).toBe(true);
  });

  it.each([
    ['another user', { kind: 'user' as const, id: 'other' }, user],
    ['another agent', { kind: 'agent' as const, id: 'other' }, agent],
    ['an agent, for a user-scoped file', { kind: 'agent' as const, id: 'agent' }, user],
    ['the user, for an agent-scoped file', { kind: 'user' as const, id: 'user' }, agent],
    ['an agent that shares the user id', { kind: 'agent' as const, id: 'user' }, user],
    [
      'anyone, when the scope has no id',
      { kind: 'user' as const, id: 'user' },
      { kind: 'user' as const },
    ],
  ])('refuses a pointer filed under %s', (_label, ref, scope) => {
    expect(isCodeRefInScope(ref, scope)).toBe(false);
  });

  it('leaves a pointer this pipeline does not write to its owner', () => {
    expect(isCodeRefInScope({ kind: 'skill', id: 'skill' }, user)).toBe(true);
  });
});
