import { ALL_REPOSITORIES, isAllowedRepository } from './repository';

describe('isAllowedRepository', () => {
  it.each([
    ['o/r', ['o/r'], true],
    ['O/R', ['o/r'], true],
    ['o/other', ['o/r'], false],
    ['o/other', ['o/*'], true],
    ['x/r', ['o/*'], false],
    ['o/r', [], false],
    ['o/r', undefined, false],
  ])('%s against %j is %s', (repo, allowed, expected) => {
    expect(isAllowedRepository(repo, allowed)).toBe(expected);
  });

  it('matches any repository for the opt-in list, and only for it', () => {
    expect(isAllowedRepository('any/thing', ALL_REPOSITORIES)).toBe(true);
    expect(isAllowedRepository('o/r', ['*/r'])).toBe(true);
    expect(isAllowedRepository('o/r', ['o/r2'])).toBe(false);
  });
});
