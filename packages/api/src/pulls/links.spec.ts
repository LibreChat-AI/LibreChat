import { findPullRequestLink } from './links';

describe('findPullRequestLink', () => {
  it('finds the pull request `gh pr create` prints', () => {
    const output =
      'Creating pull request for feat/x into dev in o/r\n\nhttps://github.com/o/r/pull/42\n';
    expect(findPullRequestLink(output, 'o/r')).toBe(42);
  });

  it('matches the repository without case, as GitHub does', () => {
    expect(findPullRequestLink('https://github.com/Owner/Repo/pull/5', 'owner/repo')).toBe(5);
  });

  it('takes the last link to the repository when there are several', () => {
    const output = 'see https://github.com/o/r/pull/3 then https://github.com/o/r/pull/8.';
    expect(findPullRequestLink(output, 'o/r')).toBe(8);
  });

  it('finds a link only on the configured host', () => {
    expect(findPullRequestLink('https://ghe.example.com/o/r/pull/9', 'o/r')).toBeNull();
    expect(
      findPullRequestLink('https://ghe.example.com/o/r/pull/9', 'o/r', 'ghe.example.com'),
    ).toBe(9);
    expect(findPullRequestLink('https://GHE.local:8443/o/r/pull/9', 'o/r', 'ghe.local:8443')).toBe(
      9,
    );
    expect(findPullRequestLink('https://ghe.local:443/o/r/pull/9', 'o/r', 'ghe.local')).toBe(9);
    expect(findPullRequestLink('https://ghe.local:08443/o/r/pull/9', 'o/r', 'ghe.local:8443')).toBe(
      9,
    );
    expect(
      findPullRequestLink('https://github.com/o/r/pull/9', 'o/r', 'ghe.example.com'),
    ).toBeNull();
  });

  it('keeps the last link on the configured host when another installation is linked after it', () => {
    const output = 'https://ghe.example.com/o/r/pull/4 and https://github.com/o/r/pull/7';
    expect(findPullRequestLink(output, 'o/r', 'ghe.example.com')).toBe(4);
  });

  it('finds a GitLab merge request, in a nested group too', () => {
    const output = 'View it on GitLab: https://gitlab.com/g/r/-/merge_requests/14\n';
    expect(findPullRequestLink(output, 'g/r', 'gitlab.com')).toBe(14);
    expect(
      findPullRequestLink(
        'https://gitlab.example.com/g/sub/r/-/merge_requests/3',
        'g/sub/r',
        'gitlab.example.com',
      ),
    ).toBe(3);
  });

  it('does not take a merge request of a project nested under the lane one', () => {
    expect(
      findPullRequestLink('https://gitlab.com/g/r/x/-/merge_requests/3', 'g/r', 'gitlab.com'),
    ).toBeNull();
  });

  it('finds a Bitbucket pull request', () => {
    expect(
      findPullRequestLink('https://bitbucket.org/w/r/pull-requests/21', 'w/r', 'bitbucket.org'),
    ).toBe(21);
  });

  it('accepts a link to a page of the pull request', () => {
    expect(findPullRequestLink('https://github.com/o/r/pull/12/files', 'o/r')).toBe(12);
  });

  it('accepts trailing punctuation after the number', () => {
    expect(findPullRequestLink('(https://github.com/o/r/pull/12)', 'o/r')).toBe(12);
  });

  it.each([
    ['another repository', 'https://github.com/other/r/pull/4'],
    ['a repository that only starts the same', 'https://github.com/o/r-fork/pull/4'],
    ['an issue', 'https://github.com/o/r/issues/4'],
    ['a GitLab issue', 'https://gitlab.com/o/r/-/issues/4'],
    ['a new merge request page', 'https://gitlab.com/o/r/-/merge_requests/new'],
    ['the page git push suggests', 'https://github.com/o/r/pull/new/feat/x'],
    ['plain http', 'http://github.com/o/r/pull/4'],
    ['a number glued to more text', 'https://github.com/o/r/pull/4abc'],
    ['pull request zero', 'https://github.com/o/r/pull/0'],
    ['a bare number', 'opened #4'],
  ])('ignores %s', (_, output) => {
    expect(findPullRequestLink(output, 'o/r')).toBeNull();
    expect(findPullRequestLink(output, 'o/r', 'gitlab.com')).toBeNull();
  });

  it('ignores a number too large to be a pull request', () => {
    expect(findPullRequestLink(`https://github.com/o/r/pull/${'9'.repeat(20)}`, 'o/r')).toBeNull();
  });
});
