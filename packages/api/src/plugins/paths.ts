import fs from 'fs';
import path from 'path';

/**
 * Agent Plugins §4.1: a configuration field defined as a plugin-relative path
 * MUST begin with `./`. Bare and parent-relative forms are rejected verbatim
 * rather than normalized, so `data` and `../bin` never resolve.
 */
export function isPluginRelativePath(value: string): boolean {
  return value.startsWith('./');
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(target);
  } catch {
    return null;
  }
}

/**
 * Resolves `target` through any symlinked ancestors, tolerating a path whose
 * leaf does not exist yet. Containment must be judged against the realpath of
 * the deepest existing ancestor so a symlinked parent cannot smuggle a
 * not-yet-created child outside the plugin root.
 */
export async function realpathAllowingMissing(target: string): Promise<string> {
  const absolute = path.resolve(target);
  const missingSegments: string[] = [];
  let current = absolute;

  for (;;) {
    const real = await realpathOrNull(current);
    if (real !== null) {
      if (missingSegments.length === 0) {
        return real;
      }
      return path.join(real, ...missingSegments.reverse());
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return absolute;
    }
    missingSegments.push(path.basename(current));
    current = parent;
  }
}

/** True when `target` is the root itself or sits beneath it. */
export function isWithinRoot(root: string, target: string): boolean {
  if (target === root) {
    return true;
  }
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target.startsWith(prefix);
}

/**
 * Resolves a package path against the filesystem-resolved plugin root and
 * enforces Agent Plugins §4.1 containment. Returns `null` when the resolved
 * path escapes the root; callers map that to the narrowest applicable failure
 * boundary for the component they are loading.
 */
export async function resolveWithinRoot(
  realRoot: string,
  relativePath: string,
): Promise<string | null> {
  const resolved = await realpathAllowingMissing(path.resolve(realRoot, relativePath));
  return isWithinRoot(realRoot, resolved) ? resolved : null;
}
