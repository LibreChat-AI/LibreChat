import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const exec = promisify(execFile);
const RUN_ATTEMPTS = 2;

function failureMessage(error: unknown): string {
  const details: string[] = [];
  if (error && typeof error === 'object') {
    if (
      'code' in error &&
      typeof error.code === 'number' &&
      Number.isInteger(error.code) &&
      error.code >= 0 &&
      error.code <= 255
    ) {
      details.push(`exit ${error.code}`);
    }
    if ('stderr' in error && typeof error.stderr === 'string') {
      if (error.stderr.includes('(NO_NAVSTART)')) {
        details.push('NO_NAVSTART');
      }
      if (error.stderr.includes('Unable to connect to Chrome')) {
        details.push('CHROME_CONNECTION_FAILED');
      }
      if (error.stderr.includes('Debugger protocol timed out while connecting to Chrome.')) {
        details.push('CHROME_PROTOCOL_TIMEOUT');
      }
    }
  }
  return `Lighthouse process failed${details.length ? ` (${details.join(', ')})` : ''}.`;
}

export async function runLighthouse({
  cli,
  flags,
  output,
  run,
  runs,
}: {
  cli: string;
  flags: string[];
  output: string;
  run: number;
  runs: number;
}): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await exec(process.execPath, [cli, ...flags, `--output-path=${output}`]);
      console.log(`Lighthouse run ${run}/${runs} wrote ${output}.report.json`);
      return;
    } catch (error) {
      // Child errors embed CLI arguments, stdout and stderr, including session cookies.
      const message = failureMessage(error);
      if (attempt >= RUN_ATTEMPTS) {
        throw new Error(message);
      }
      console.log(
        `Lighthouse run ${run}/${runs} attempt ${attempt} did not complete, retrying: ${message}`,
      );
    }
  }
}
