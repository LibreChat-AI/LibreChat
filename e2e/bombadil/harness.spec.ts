import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { expect, test } from '@playwright/test';
import { getE2EBaseURL } from '../setup/env';
import { getE2EUser } from '../setup/user';

const rootPath = path.resolve(__dirname, '../..');
const specificationPath = path.resolve(
  __dirname,
  process.env.BOMBADIL_SPECIFICATION ?? 'specification.ts',
);
const specificationStem = path.basename(specificationPath, '.ts').replace(/\.specification$/, '');
const defaultOutputPath = path.resolve(
  rootPath,
  specificationStem === 'specification'
    ? 'e2e/.generated/bombadil-output'
    : `e2e/.generated/bombadil-output-${specificationStem}`,
);
const defaultBinaryPath = path.resolve(rootPath, 'node_modules/.bin/bombadil');
const MAX_CAPTURED_OUTPUT = 100_000;
const DEFAULT_REPRODUCTION_TIMEOUT_MS = 30 * 60 * 1_000;
const LOGIN_EMAIL_PLACEHOLDER = '__BOMBADIL_E2E_USER_EMAIL__';
const LOGIN_PASSWORD_PLACEHOLDER = '__BOMBADIL_E2E_USER_PASSWORD__';

function durationMillis(value: string): number | null {
  const match = value.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    return null;
  }
  const factors = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(match[1]) * factors[match[2] as keyof typeof factors];
}

function positiveTimeoutMillis(value: string, variableName: string): number {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(
      `${variableName} must be a positive number of milliseconds; received "${value}".`,
    );
  }
  return timeout;
}

function archiveExistingOutput(outputPath: string): void {
  if (!fs.existsSync(outputPath)) {
    return;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = path.resolve(
    rootPath,
    'e2e/.generated/bombadil-history',
    `${path.basename(outputPath)}-${timestamp}`,
  );
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.cpSync(outputPath, archivePath, { recursive: true });
}

function materializeSpecification(): string {
  const user = getE2EUser();
  const generatedPath = path.resolve(
    rootPath,
    'e2e/.generated/bombadil-specifications',
    path.basename(specificationPath),
  );
  const replaceStringLiteral = (source: string, placeholder: string, value: string) =>
    source
      .replaceAll(`'${placeholder}'`, JSON.stringify(value))
      .replaceAll(`"${placeholder}"`, JSON.stringify(value));
  let source = fs.readFileSync(specificationPath, 'utf8');
  source = replaceStringLiteral(source, LOGIN_EMAIL_PLACEHOLDER, user.email);
  source = replaceStringLiteral(source, LOGIN_PASSWORD_PLACEHOLDER, user.password);
  fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
  fs.writeFileSync(generatedPath, source);
  return generatedPath;
}

function runBombadil(
  outputPath: string,
  runtimeSpecificationPath: string,
  childTimeoutMillis: number,
): Promise<{ code: number | null; output: string }> {
  const binaryPath = process.env.BOMBADIL_BIN ?? defaultBinaryPath;
  const reproducePath = process.env.BOMBADIL_REPRODUCE;
  const timeLimit = process.env.BOMBADIL_TIME_LIMIT ?? '90s';
  const args = [
    'browser',
    'test',
    '--headless',
    '--output-path',
    outputPath,
    '--output-path-overwrite',
    '--instrument-javascript',
    // Instrumenting LibreChat's full Vite bundle makes Bombadil's driver time out
    // under longer stateful runs. Full `files,inline` coverage remains opt-in.
    process.env.BOMBADIL_INSTRUMENT_JAVASCRIPT ?? 'inline',
  ];

  if (reproducePath) {
    args.push('--reproduce', reproducePath);
  } else {
    args.push('--exit-on-violation', '--time-limit', timeLimit);
  }

  args.push(getE2EBaseURL(), runtimeSpecificationPath);

  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      cwd: rootPath,
      env: {
        ...process.env,
        RUST_LOG: process.env.BOMBADIL_RUST_LOG ?? 'error',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const childTimer = setTimeout(() => {
      timedOut = true;
      output = `${output}\nBombadil exceeded the ${childTimeoutMillis}ms child-process timeout.`;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, childTimeoutMillis);
    const append = (chunk: Buffer) => {
      const text = chunk.toString();
      output = `${output}${text}`.slice(-MAX_CAPTURED_OUTPUT);
      process.stdout.write(text);
    };

    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error) => {
      clearTimeout(childTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(childTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      resolve({ code: timedOut ? null : code, output });
    });
  });
}

test('Bombadil explores core, branching, multi-conversation, and lifecycle flows', async () => {
  const timeLimitMillis = durationMillis(process.env.BOMBADIL_TIME_LIMIT ?? '90s') ?? 90_000;
  const defaultHarnessTimeout = process.env.BOMBADIL_REPRODUCE
    ? DEFAULT_REPRODUCTION_TIMEOUT_MS
    : timeLimitMillis + 120_000;
  const harnessTimeout = process.env.BOMBADIL_HARNESS_TIMEOUT_MS
    ? positiveTimeoutMillis(process.env.BOMBADIL_HARNESS_TIMEOUT_MS, 'BOMBADIL_HARNESS_TIMEOUT_MS')
    : defaultHarnessTimeout;
  test.setTimeout(harnessTimeout);
  const outputPath = process.env.BOMBADIL_REPRODUCE
    ? path.resolve(rootPath, 'e2e/.generated/bombadil-reproduction')
    : defaultOutputPath;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  archiveExistingOutput(outputPath);
  const runtimeSpecificationPath = materializeSpecification();

  const result = await runBombadil(
    outputPath,
    runtimeSpecificationPath,
    Math.max(harnessTimeout - 10_000, 10_000),
  );

  expect(
    result.code,
    `Bombadil exited with ${result.code}. Inspect or reproduce the trace at ${outputPath}.\n${result.output}`,
  ).toBe(0);
});
