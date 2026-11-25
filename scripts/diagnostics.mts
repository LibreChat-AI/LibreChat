/**
 * The comparison behind the design-suppression swap check in
 * `scripts/static-checks.mts`: given one changed file's head report, its base
 * report and the record at both ends, which design-rule violations this change
 * introduced beyond what the record grew to cover. Kept apart from the runner,
 * which owns git and ESLint, so the comparison can be specified on its own.
 */

/**
 * ESLint's on-disk suppressions shape, which the recorded baseline claims to be:
 * a count per file, per rule. `validateSuppressions` is what checks the claim, so
 * the leaf stays `unknown`: a string or a float there is one of the failures.
 */
export type SuppressionsFile = Record<string, Record<string, { count?: unknown }>>;

/**
 * One file's entry in ESLint's JSON report, as the checks here read it. A
 * suppressed message carries its text too: the swap check compares messages,
 * and what the baseline silences is exactly what it has to see.
 */
export type LintReport = {
  filePath: string;
  /** `message` also carries ESLint's unused-directive text, where `ruleId` is null. */
  messages: { ruleId: string | null; message?: string }[];
  suppressedMessages?: {
    ruleId: string | null;
    message?: string;
    suppressions?: { kind: string; justification?: string }[];
  }[];
};

/** The design rules are `@shadcn/lint`'s and the local `design` plugin's
 *  (`scripts/eslint/design.mjs`); both are recorded in the same backlog. */
export const isDesignRule = (ruleId: string | null | undefined): boolean =>
  ruleId?.startsWith('shadcn/') === true || ruleId?.startsWith('design/') === true;

/** A diagnostic is compared by its first sentence, the violation itself. What follows is the
 *  remedy, and it depends on where the file sits: a client path is offered the app's own
 *  compositions (`PanelContent`), a package path is not, so the same violation reads differently
 *  on either side of a move. */
export const diagnosis = (message: string): string =>
  /^.*?\.(?=\s|$)/.exec(message)?.[0] ?? message;

export const signatures = (reports: LintReport[]): string[] =>
  reports
    .flatMap((file) => [...file.messages, ...(file.suppressedMessages ?? [])])
    .filter((message) => isDesignRule(message.ruleId))
    .map((message) => `${message.ruleId}: ${diagnosis(message.message ?? '')}`);

const countOf = (record: SuppressionsFile, file: string, rule: string): number => {
  const entry = record[file]?.[rule]?.count;
  return typeof entry === 'number' ? entry : 0;
};

export type ChangedFile = {
  /** The file's path at the head, as the repository names it. */
  path: string;
  /** What ESLint reports for the head version. */
  head: LintReport;
  /** The base version linted under the path it had there; absent for a file this change adds. */
  base?: { path: string; reports: LintReport[] };
};

/**
 * The violations a changed file carries beyond what its base version held and
 * beyond what its record entry grew by. A file the change adds owes everything
 * in it: the record may not grow to cover a violation written in the same
 * commit as its entry, or the rules would police nothing but the tree they
 * landed on. A file that existed at the base, renamed or not, brings its
 * allowance and may grow it, and a rename's allowance is the one recorded under
 * the name it had, or the move itself would read as room to spend.
 */
export function introducedViolations(
  file: ChangedFile,
  recorded: SuppressionsFile,
  recordedBefore: SuppressionsFile,
): string[] {
  const { path, base } = file;
  const had = new Map<string, number>();
  for (const signature of base ? signatures(base.reports) : []) {
    had.set(signature, (had.get(signature) ?? 0) + 1);
  }
  const allowed = new Map<string, number>();
  const problems: string[] = [];
  for (const signature of signatures([file.head])) {
    const remaining = had.get(signature) ?? 0;
    if (remaining > 0) {
      had.set(signature, remaining - 1);
      continue;
    }
    const rule = signature.slice(0, signature.indexOf(':'));
    const grew = countOf(recorded, path, rule) - countOf(recordedBefore, base?.path ?? path, rule);
    const spent = allowed.get(rule) ?? 0;
    if (base && spent < grew) {
      allowed.set(rule, spent + 1);
      continue;
    }
    problems.push(
      base
        ? `${path}: ${signature} is new here and the record did not grow to cover it; fix it, or record what this change owes with \`npm run lint:design:suppress\` so the count says so`
        : `${path}: ${signature} is in a file this change adds; the backlog records what the tree owed when the rules landed, not what a new file brings, so fix it`,
    );
  }
  return problems;
}
