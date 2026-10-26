/**
 * Type-checks a TypeScript project with `bun check` when the installed Bun provides it, and
 * with the repository's `tsc` otherwise, so Bun stays optional locally while CI runs the same
 * checker. Both pass on every workspace config; `bun check` applies TypeScript 7 semantics.
 *
 * Usage: node scripts/typecheck.mts [-p <tsconfig>]
 */
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

export interface TypecheckCommand {
  checker: 'bun' | 'tsc';
  command: string;
  /** Arguments before `-p <project>`. */
  args: string[];
}

let bunCheck: boolean | undefined;

/** Probes the subcommand rather than the binary: older Bun releases have no `check`. */
function hasBunCheck(): boolean {
  bunCheck ??= spawnSync('bun', ['check', '--help'], { stdio: 'ignore' }).status === 0;
  return bunCheck;
}

/** Resolves the checker to run, or null when neither Bun nor `typescript` is available. */
export function resolveTypecheck(root: string): TypecheckCommand | null {
  if (hasBunCheck()) {
    return { checker: 'bun', command: 'bun', args: ['check'] };
  }
  try {
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc', { paths: [root] });
    return { checker: 'tsc', command: process.execPath, args: [tsc, '--noEmit'] };
  } catch {
    return null;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const typecheck = resolveTypecheck(process.cwd());
  if (!typecheck) {
    console.error('typecheck: neither `bun check` nor typescript is available; run npm ci');
    process.exit(1);
  }
  if (typecheck.checker === 'tsc') {
    console.error('typecheck: `bun check` is unavailable, falling back to tsc');
  }
  const result = spawnSync(typecheck.command, [...typecheck.args, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}
