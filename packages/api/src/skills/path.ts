/**
 * Skill file paths are stored and matched verbatim (e.g. `references/guide.md`).
 * A path is safe when it has no absolute prefix, no `.`/`..`/empty segments, and
 * uses only the restricted character set skills are imported with. Single source
 * of truth shared by import, upload, and the file-serving routes so read, write,
 * and delete stay in lockstep.
 */
export function isSafeSkillFilePath(p: string): boolean {
  if (!p || p.startsWith('/') || p.startsWith('\\')) {
    return false;
  }
  const segments = p.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.' || seg === '') {
      return false;
    }
  }
  return /^[a-zA-Z0-9._\-/]+$/.test(p);
}

/**
 * Reconstruct a skill file path from an Express route param. Express 5 splat
 * params (`*relativePath`) arrive as an array of already-decoded segments, while
 * a single named param arrives as a string. Wildcard routing lets nested files
 * resolve whether the client sends an encoded `%2F` or a proxy has already
 * decoded it to a literal slash before the request reaches Node. Returns `null`
 * for empty or traversal-unsafe paths.
 */
export function resolveSkillFilePathParam(param: string | string[] | undefined): string | null {
  if (param == null) {
    return null;
  }
  const joined = Array.isArray(param) ? param.join('/') : param;
  if (!isSafeSkillFilePath(joined)) {
    return null;
  }
  return joined;
}
