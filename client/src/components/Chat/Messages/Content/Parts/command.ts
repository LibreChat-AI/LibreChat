/**
 * Reads the verdict the attached-workspace `bash_tool` writes into its output
 * (`formatCommandResult` in `packages/api/src/code/command.ts`):
 *
 *   stdout:\n<out>\n  stderr:\n<err>\n  [exit code: N][terminated by SIG][timed out][output truncated]
 *
 * The trailer always follows the newline that closes the last section, so a
 * command printing the same text itself cannot forge it: its line would be
 * followed by that newline. The sandbox `bash_tool` never writes a trailer, so
 * its output parses to `null` and keeps the text heuristics.
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
   *  no-output notice), `stderr` the stderr section with its label. */
  head: string;
  stderr: string;
  trailer: string;
}

const TRAILER =
  /\n((?:\[(?:exit code: -?\d+|terminated by [\w+-]+|timed out|output truncated)\])+)$/;
const MARKER = /\[(exit code: (-?\d+)|terminated by ([\w+-]+)|timed out|output truncated)\]/g;
const STDOUT = 'stdout:\n';
const STDERR = 'stderr:\n';
const EMPTY = 'Command completed with no output.\n';

export function parseCommandOutput(output: string): CommandOutput | null {
  const match = TRAILER.exec(output);
  if (match == null) {
    return null;
  }
  const body = output.slice(0, match.index + 1);
  if (!body.startsWith(STDOUT) && !body.startsWith(STDERR) && body !== EMPTY) {
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
  const labelAt = body.startsWith(STDERR) ? 0 : body.lastIndexOf(`\n${STDERR}`) + 1;
  const split = labelAt > 0 || body.startsWith(STDERR) ? labelAt : body.length;
  return {
    exitCode,
    signal,
    timedOut,
    truncated,
    failed: (exitCode != null && exitCode !== 0) || signal != null || timedOut,
    head: body.slice(0, split),
    stderr: body.slice(split),
    trailer: match[1],
  };
}
