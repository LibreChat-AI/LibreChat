/**
 * What `allowAllRepositories` stands for. The config schema cannot produce it (an owner must be a
 * real name), so only the explicit opt-in can put it in a list.
 */
export const ALL_REPOSITORIES: readonly string[] = ['*/*'];

/** `owner/name` or `owner/*`, compared without case as GitHub does. Nothing else matches. */
export function isAllowedRepository(repo: string, allowed: readonly string[] | undefined): boolean {
  const [owner, name] = repo.toLowerCase().split('/');
  return (allowed ?? []).some((entry) => {
    const [allowedOwner, allowedName] = entry.toLowerCase().split('/');
    return (
      (allowedOwner === '*' || allowedOwner === owner) &&
      (allowedName === '*' || allowedName === name)
    );
  });
}
