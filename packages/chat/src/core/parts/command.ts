import { COMMAND_RESULT_TRAILER } from 'librechat-data-provider';

/**
 * Reads the verdict the attached-workspace `bash_tool` writes into its output
 * (`formatCommandResult` in `packages/api/src/code/command.ts`):
 *
 *   stdout:\n<out>\n  stderr:\n<err>\n  [exit code: N][terminated by SIG][timed out][output truncated]
 *
 * An optional starting-directory header and timeout/cwd guidance are preserved.
 *
 * The text alone does not prove where it came from: the sandbox `bash_tool`
 * shares the name and trims its output, so a sandbox command that prints
 * `[exit code: 1]` last yields the same shape. Callers must only parse output
 * of a call whose server-stamped `executor` is `attached_workspace`, and keep
 * the text heuristics otherwise.
 */
export interface CommandOutput {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  /** Non-zero exit, a terminating signal or a timeout. */
  failed: boolean;
  /** `head + stderr + trailer === output`, so a renderer can style each part
   *  without dropping any text. `head` is the stdout section (or the
   *  no-output notice), including any directory header; `stderr` keeps its label. */
  head: string;
  stderr: string;
  trailer: string;
}

const STARTING_DIRECTORY = /^\[starting directory: "workspace\/(?:[^"\\\r\n]|\\[^\r\n])*"\]\n/;
const MARKER = /\[(exit code: (-?\d+)|terminated by ([\w+-]+)|timed out|output truncated)\]/g;
const STDOUT = 'stdout:\n';
const STDERR = 'stderr:\n';
const EMPTY = 'Command completed with no output.\n';

export function parseCommandOutput(output: string): CommandOutput | null {
  const match = COMMAND_RESULT_TRAILER.exec(output);
  if (match == null) {
    return null;
  }
  const body = output.slice(0, match.index + 1);
  const directoryLength = STARTING_DIRECTORY.exec(body)?.[0].length ?? 0;
  const content = body.slice(directoryLength);
  if (!content.startsWith(STDOUT) && !content.startsWith(STDERR) && content !== EMPTY) {
    return null;
  }
  let exitCode: number | null = null;
  let signal: string | null = null;
  let timedOut = false;
  let truncated = false;
  for (const [, marker, code, name] of match[1].matchAll(MARKER)) {
    if (code != null) {
      exitCode = Number(code);
    } else if (name != null) {
      signal = name;
    } else if (marker === 'timed out') {
      timedOut = true;
    } else {
      truncated = true;
    }
  }
  /** The last label wins: output that itself prints `stderr:` is ambiguous,
   *  and styling too little as stderr is the safer mistake. Either way no
   *  text is dropped. */
  const labelAt = content.startsWith(STDERR)
    ? directoryLength
    : body.lastIndexOf(`\n${STDERR}`) + 1;
  const split = labelAt > 0 || content.startsWith(STDERR) ? labelAt : body.length;
  return {
    exitCode,
    signal,
    timedOut,
    truncated,
    failed: (exitCode != null && exitCode !== 0) || signal != null || timedOut,
    head: body.slice(0, split),
    stderr: body.slice(split),
    trailer: match[1] + match[2],
  };
}
