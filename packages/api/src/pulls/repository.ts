/** `owner/name` or `owner/*`, compared without case as GitHub does. Nothing else matches. */
export function isAllowedRepository(repo: string, allowed: readonly string[] | undefined): boolean {
  const [owner, name] = repo.toLowerCase().split('/');
  return (allowed ?? []).some((entry) => {
    const [allowedOwner, allowedName] = entry.toLowerCase().split('/');
    return allowedOwner === owner && (allowedName === '*' || allowedName === name);
  });
}
