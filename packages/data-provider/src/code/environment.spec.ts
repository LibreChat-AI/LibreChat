import { isCodeWorkspaceEnvironment } from './workspace';

const environment = (repo: string) => ({ fingerprint: 'a'.repeat(64), repo, actions: [] });

describe('isCodeWorkspaceEnvironment repository', () => {
  it.each(['o/r', 'group/sub/project', 'a.b/c_d/e-f'])('accepts %s', (repo) => {
    expect(isCodeWorkspaceEnvironment(environment(repo))).toBe(true);
  });

  it.each(['r', 'group/../project', './r', 'o/..', 'o//r'])('rejects %s', (repo) => {
    expect(isCodeWorkspaceEnvironment(environment(repo))).toBe(false);
  });
});
