import { isMissingSandboxPathError } from './errors';

describe('isMissingSandboxPathError', () => {
  it('recognizes the shell and runtime spellings of an absent path', () => {
    expect(isMissingSandboxPathError('cat: /mnt/data/SKILL.md: No such file or directory')).toBe(
      true,
    );
    expect(isMissingSandboxPathError("ls: cannot access '/mnt/data/x': No such file")).toBe(true);
    expect(isMissingSandboxPathError('The system cannot find the path specified')).toBe(true);
    expect(isMissingSandboxPathError("ENOENT: no such file, open '/mnt/data/x'")).toBe(true);
    expect(isMissingSandboxPathError('CAT: /MNT/DATA/X: NO SUCH FILE OR DIRECTORY')).toBe(true);
  });

  /* A missing interpreter is a runner dependency the operator must see, not
   * an absent file — demoting it to an expected miss would hide it. */
  it('does not treat a bare "not found" as an absent path', () => {
    expect(isMissingSandboxPathError('python3: not found')).toBe(false);
    expect(isMissingSandboxPathError('/bin/sh: 1: cat: not found')).toBe(false);
  });

  it('rejects transport and permission failures', () => {
    expect(isMissingSandboxPathError('connect ECONNREFUSED 127.0.0.1:3112')).toBe(false);
    expect(isMissingSandboxPathError('Request failed with status code 403')).toBe(false);
    expect(isMissingSandboxPathError('cat: /mnt/data/x: Permission denied')).toBe(false);
    expect(isMissingSandboxPathError('')).toBe(false);
  });
});
