import { isSafeSkillFilePath, resolveSkillFilePathParam } from '../path';

describe('isSafeSkillFilePath', () => {
  it('accepts top-level and nested skill file paths', () => {
    expect(isSafeSkillFilePath('SKILL.md')).toBe(true);
    expect(isSafeSkillFilePath('references/working-patterns.md')).toBe(true);
    expect(isSafeSkillFilePath('assets/img/logo.png')).toBe(true);
    expect(isSafeSkillFilePath('scripts/run.sh')).toBe(true);
  });

  it('rejects traversal, absolute, and empty-segment paths', () => {
    expect(isSafeSkillFilePath('../secrets')).toBe(false);
    expect(isSafeSkillFilePath('references/../../etc/passwd')).toBe(false);
    expect(isSafeSkillFilePath('/etc/passwd')).toBe(false);
    expect(isSafeSkillFilePath('\\windows\\system32')).toBe(false);
    expect(isSafeSkillFilePath('references//guide.md')).toBe(false);
    expect(isSafeSkillFilePath('./guide.md')).toBe(false);
    expect(isSafeSkillFilePath('')).toBe(false);
  });

  it('rejects disallowed characters', () => {
    expect(isSafeSkillFilePath('guide file.md')).toBe(false);
    expect(isSafeSkillFilePath('guide\0.md')).toBe(false);
    expect(isSafeSkillFilePath('weird%20name.md')).toBe(false);
  });
});

describe('resolveSkillFilePathParam', () => {
  it('joins Express 5 splat segments (proxy decoded a literal slash)', () => {
    expect(resolveSkillFilePathParam(['references', 'working-patterns.md'])).toBe(
      'references/working-patterns.md',
    );
    expect(resolveSkillFilePathParam(['a', 'b', 'c', 'file.md'])).toBe('a/b/c/file.md');
  });

  it('handles a single decoded segment (client sent an encoded %2F)', () => {
    expect(resolveSkillFilePathParam(['references/working-patterns.md'])).toBe(
      'references/working-patterns.md',
    );
    expect(resolveSkillFilePathParam('SKILL.md')).toBe('SKILL.md');
  });

  it('returns null for empty, missing, or traversal-unsafe params', () => {
    expect(resolveSkillFilePathParam(undefined)).toBeNull();
    expect(resolveSkillFilePathParam([])).toBeNull();
    expect(resolveSkillFilePathParam('')).toBeNull();
    expect(resolveSkillFilePathParam(['..', '..', 'etc', 'passwd'])).toBeNull();
    expect(resolveSkillFilePathParam(['../../etc/passwd'])).toBeNull();
  });
});
