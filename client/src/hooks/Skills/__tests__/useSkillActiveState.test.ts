import { resolveSkillDefaultActive } from '../useSkillActiveState';

describe('resolveSkillDefaultActive', () => {
  test('activates deployment skills for every user by default', () => {
    expect(
      resolveSkillDefaultActive(
        { author: 'deployment-registry', source: 'deployment' },
        'user-1',
        false,
      ),
    ).toBe(true);
  });

  test('activates owned inline skills by default', () => {
    expect(resolveSkillDefaultActive({ author: 'user-1', source: 'inline' }, 'user-1', false)).toBe(
      true,
    );
  });

  test('uses the shared-skill configuration for non-owned inline skills', () => {
    const skill = { author: 'user-2', source: 'inline' } as const;
    expect(resolveSkillDefaultActive(skill, 'user-1', false)).toBe(false);
    expect(resolveSkillDefaultActive(skill, 'user-1', true)).toBe(true);
  });
});
