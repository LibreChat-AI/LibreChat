/**
 * True for the failures a code-execution sandbox reports about the requested
 * PATH, and only those. Deliberately narrow: a bare "not found" is also what
 * the sandbox emits for a missing interpreter (`python3: not found`), and
 * treating that as an absent file would hide a runner dependency the operator
 * needs to see.
 *
 * Reads that miss are an ordinary outcome — `create_file` reads the target
 * before writing so it can detect an overwrite — so callers use this to keep
 * an expected miss out of error-level logging and off the model's error path.
 */
export function isMissingSandboxPathError(reason: string): boolean {
  const message = reason.toLowerCase();
  return (
    message.includes('no such file or directory') ||
    message.includes('cannot access') ||
    message.includes('cannot find the path') ||
    message.includes('enoent')
  );
}
