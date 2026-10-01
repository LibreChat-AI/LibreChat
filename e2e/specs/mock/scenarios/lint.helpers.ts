import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from '@playwright/test';

/**
 * Shared plumbing for the scenarios whose observable behaviour is what the
 * configured tooling does rather than what the app paints. They run the real
 * binaries from the repository root, the way a contributor and the Static
 * Checks lane do, and they never write into the tree.
 */

/** The repository root: this file sits in e2e/specs/mock/scenarios. */
export const repoRoot = resolve(__dirname, '../../../..');

/**
 * A lint gate has no viewport. These scenarios spawn ESLint and the static-checks
 * runner over the checkout itself, so a second project would repeat minutes of
 * subprocess work for the same verdict and two of them would share one
 * `packages/client/dist` and one scratch tree. The repository's mock lane defines
 * a single project; a harness that adds colour-scheme or device projects runs
 * these in the first one.
 */
export function inOneProject(): void {
  const info = test.info();
  const primary = info.config.projects[0]?.name;
  test.skip(
    primary !== undefined && info.project.name !== primary,
    `the lint gate has no viewport; it runs in ${primary ?? 'the first project'}`,
  );
}

export type LintMessage = {
  ruleId: string | null;
  message: string;
  line: number;
};

export type CommandResult = {
  status: number;
  stdout: string;
  /** Both streams, for assertion messages: a failure is rarely on one of them. */
  output: string;
};

/**
 * Run a command from the repository root and collect both streams. `cwd` names
 * another root when the command under test derives the repository from where it
 * is invoked: the static-checks runner relativizes its file arguments against
 * the working directory, so a copy of it asked about `eslint.config.mjs` from
 * elsewhere sees a path outside its own tree and selects nothing.
 */
export function run(
  command: string,
  args: string[],
  options: { input?: string; cwd?: string } = {},
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  return {
    status: result.status ?? 1,
    stdout,
    output: `${stdout}${result.stderr ?? ''}`,
  };
}

const ESLINT = resolve(repoRoot, 'node_modules/.bin/eslint');

function parseMessages(result: CommandResult): LintMessage[] {
  /** `--format json` writes the report to stdout; ESLint's own notices go to
   *  stderr, so the report is sliced out of stdout alone. */
  const start = result.stdout.indexOf('[');
  if (start === -1) {
    throw new Error(`ESLint printed no JSON report:\n${result.output}`);
  }
  const report = JSON.parse(result.stdout.slice(start)) as { messages: LintMessage[] }[];
  return report.flatMap((file) => file.messages);
}

/**
 * Lint `source` as though it were `relativePath`, without creating the file.
 * `--stdin-filename` is what decides which config block applies, so this asks
 * the real flat config which rules reach that path.
 */
export function lintStdin(relativePath: string, source: string): LintMessage[] {
  return parseMessages(
    run(
      ESLINT,
      [
        '--stdin',
        '--stdin-filename',
        relativePath,
        '--format',
        'json',
        '--config',
        'eslint.config.mjs',
        '--no-warn-ignored',
      ],
      { input: source },
    ),
  );
}

/** Lint a file that exists, the way the changed-file lint does. */
export function lintFile(relativePath: string): LintMessage[] {
  return parseMessages(
    run(ESLINT, [
      '--config',
      'eslint.config.mjs',
      '--no-warn-ignored',
      '--format',
      'json',
      relativePath,
    ]),
  );
}

/** Only the design-system rules; the probes carry no other interesting output. */
export function designMessages(messages: LintMessage[]): LintMessage[] {
  return messages.filter((message) => message.ruleId?.startsWith('shadcn/'));
}

export const messagesFor = (messages: LintMessage[], ruleId: string): string[] =>
  messages.filter((message) => message.ruleId === ruleId).map((message) => message.message);

/**
 * The severity the resolved flat config gives each design rule at every path,
 * which is what says whether the rules are asked about a path at all — a report
 * cannot, since a file with nothing to report looks the same either way. The
 * paths need not exist; ESLint resolves a configuration for a name.
 *
 * Asked through ESLint's own API in one process: `--print-config` answers for
 * one path per run, and a directory-by-directory sweep of both roots is more
 * than a thousand of them — eleven minutes of subprocesses against under a
 * second in here.
 */
export function designRuleSeverities(paths: string[]): Record<string, Record<string, number>> {
  const query = `
    const { ESLint } = require('eslint');
    (async () => {
      const eslint = new ESLint({ overrideConfigFile: 'eslint.config.mjs' });
      const answer = {};
      for (const path of process.argv.slice(1)) {
        const config = await eslint.calculateConfigForFile(path);
        const severities = {};
        for (const [rule, setting] of Object.entries(config.rules ?? {})) {
          if (rule.startsWith('shadcn/')) {
            severities[rule] = Array.isArray(setting) ? setting[0] : setting;
          }
        }
        answer[path] = severities;
      }
      process.stdout.write(JSON.stringify(answer));
    })();
  `;
  const answered = run(process.execPath, ['-e', query, '--', ...paths]);
  if (answered.status !== 0) throw new Error(`no resolved config: ${answered.output}`);
  return JSON.parse(answered.stdout) as Record<string, Record<string, number>>;
}

/**
 * `root` and every directory under it that holds a source file, so a coverage
 * assertion reaches the subtree a narrowing config would drop rather than a
 * list someone remembered to update.
 */
export function sourceDirectories(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    const entries = readdirSync(resolve(repoRoot, directory), { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name))) {
      found.push(directory);
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) walk(`${directory}/${entry.name}`);
    }
  };
  walk(root);
  return found;
}

/** The local mirror of the Static Checks lane, invoked as `package.json` does. */
export function staticChecks(args: string[]): CommandResult {
  return run(process.execPath, [resolve(repoRoot, 'scripts/static-checks.mts'), ...args]);
}
