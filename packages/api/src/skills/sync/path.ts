/**
 * Repository paths arrive from provider APIs and admin config with inconsistent
 * leading/trailing slashes, and `.` for the repository root. Normalizing both
 * sides through this keeps configured paths, tree entry paths, and stored skill
 * paths directly comparable.
 */
export function normalizeRepoPath(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  return trimmed === '.' ? '' : trimmed;
}
