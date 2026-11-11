/**
 * Playwright reporter that explains a run failed by a retried pass.
 *
 * With `failOnFlakyTests`, a test that fails and then passes on a retry fails the run. Playwright
 * still prints it under "N flaky" beside the passed count and exits 1, which reads as noise to
 * re-run. This names each such test in the job log and in the job summary
 * (`$GITHUB_STEP_SUMMARY`) and says that the retried pass is what failed. It reports nothing when
 * the option is off, as in a local run, or when no test needed a retry.
 */
import { appendFileSync } from 'node:fs';
import { basename, relative, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

const ERROR_LIMIT = 240;

const REASON =
  'Each test below failed on an earlier attempt and passed on a retry. In CI a retried pass ' +
  'fails the run (`failOnFlakyTests`): a test that needs a retry fails some of the time, so fix ' +
  'it like any other failure instead of re-running the job.';
const ONLY_CAUSE = 'No test failed every attempt, so these retried passes are why the run failed.';
const OTHER_CAUSES = 'The run failed for other reasons as well; the job log has them.';

/** Inline code that a backtick or a line break in the text cannot close early. */
const code = (text) => `\`${text.replace(/\s+/g, ' ').replaceAll('`', "'")}\``;

/** The first line of an attempt's error, without colors, short enough for one list item. */
function firstLine(message = '') {
  const line =
    stripVTControlCharacters(message)
      .split('\n')
      .find((text) => text.trim() !== '') ?? '';
  const text = line.trim();
  return text.length > ERROR_LIMIT ? `${text.slice(0, ERROR_LIMIT)}…` : text;
}

function describe(test, root) {
  const [, project, , ...titles] = test.titlePath();
  const file = relative(root, test.location.file).split(sep).join('/');
  const location = `${file}:${test.location.line}`;
  return {
    name: [...(project ? [`[${project}]`] : []), location, ...titles].join(' › '),
    attempts: test.results.map((result) => result.status),
    error: firstLine(test.results.find((result) => result.error)?.error.message),
  };
}

/** The tests that passed only on a retry, and how many failed every attempt. */
export function collect(tests, root = process.cwd()) {
  const retried = [];
  let failed = 0;
  for (const test of tests) {
    const outcome = test.outcome();
    if (outcome === 'flaky') {
      retried.push(describe(test, root));
    } else if (outcome === 'unexpected') {
      failed += 1;
    }
  }
  return { retried, failed };
}

/** Markdown that also reads as plain text, so the job log and the job summary share it. */
export function render({ config, retried, only }) {
  const count = `${retried.length} test${retried.length === 1 ? '' : 's'}`;
  const items = retried.map(({ name, attempts, error }) => {
    const cause = error ? ` First error: ${code(error)}` : '';
    return `- ${code(name)}: ${attempts.join(', ')}.${cause}`;
  });
  return [
    `### Playwright: ${count} passed only on a retry (${config})`,
    '',
    `${REASON} ${only ? ONLY_CAUSE : OTHER_CAUSES}`,
    '',
    ...items,
    '',
  ].join('\n');
}

export default class RetriedReporter {
  #config;
  #suite;
  #errors = 0;

  onBegin(config, suite) {
    this.#config = config;
    this.#suite = suite;
  }

  onError() {
    this.#errors += 1;
  }

  onEnd(result) {
    if (!this.#config?.failOnFlakyTests) {
      return;
    }
    const { retried, failed } = collect(this.#suite.allTests());
    if (retried.length === 0) {
      return;
    }
    const text = render({
      config: basename(this.#config.configFile ?? 'playwright'),
      retried,
      only: result.status === 'failed' && failed === 0 && this.#errors === 0,
    });
    console.log(`\n${text}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    }
  }

  /** Playwright adds its own terminal reporter to a run whose reporters all answer false. */
  printsToStdio() {
    return false;
  }
}
