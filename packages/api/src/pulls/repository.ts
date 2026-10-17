/**
 * What `allowAllRepositories` stands for. The config schema cannot produce it (an owner must be a
 * real name), so only the explicit opt-in can put it in a list.
 */
export const ALL_REPOSITORIES: readonly string[] = ['*/*'];

/**
 * `owner/name`, `owner/*`, or a nested GitLab path such as `group/sub/name` or `group/sub/*`,
 * compared without case. `*` stands for exactly one segment, so `group/*` does not reach into
 * `group/sub/name`. Only the opt-in to every repository matches any path.
 */
export function isAllowedRepository(repo: string, allowed: readonly string[] | undefined): boolean {
  const segments = repo.toLowerCase().split('/');
  return (allowed ?? []).some((entry) => {
    if (entry === ALL_REPOSITORIES[0]) return true;
    const pattern = entry.toLowerCase().split('/');
    return (
      pattern.length === segments.length &&
      pattern.every((part, index) => part === '*' || part === segments[index])
    );
  });
}
