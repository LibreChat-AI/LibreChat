import { skillMessageFields } from './skills';

describe('skillMessageFields', () => {
  it('returns manual and server-resolved always-applied skill names', () => {
    expect(
      skillMessageFields({
        manualSkills: ['manual', '', 42, null],
        alwaysApplySkillPrimes: [{ name: 'always' }, { name: '' }],
      }),
    ).toEqual({ manualSkills: ['manual'], alwaysAppliedSkills: ['always'] });
  });

  it.each([undefined, null, [], [''], [42], 'manual'])(
    'omits empty or malformed metadata: %p',
    (manualSkills) => {
      expect(skillMessageFields({ manualSkills, alwaysApplySkillPrimes: [] })).toEqual({});
    },
  );

  it.each(['isEdited', 'isCompaction', 'skipSaveUserMessage'] as const)(
    'leaves existing message fields alone for %s',
    (flag) => {
      expect(
        skillMessageFields({
          [flag]: true,
          manualSkills: ['new-manual'],
          alwaysApplySkillPrimes: [{ name: 'new-always' }],
        }),
      ).toEqual({});
    },
  );
});
