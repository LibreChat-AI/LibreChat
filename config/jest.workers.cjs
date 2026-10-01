/**
 * Jest worker count shared by every workspace config.
 *
 * Jest runs in band as soon as it resolves to a single worker, and in band a test
 * file that leaves a server listening or a timer armed keeps the main process alive
 * after "Ran all test suites" until the CI job hits its timeout. `'50%'` resolves to
 * exactly one worker on the 2-vCPU GitHub-hosted runners that private repositories
 * (forks, mirrors) get, so CI keeps a floor of two workers: a leaked handle then
 * stays inside a worker process, which Jest terminates — the same shape the 4-vCPU
 * public runners already get from `'50%'`. Local runs keep the percentage so the
 * pool tracks the machine.
 */
const os = require('node:os');

const CI_MIN_WORKERS = 2;

function cpuCount() {
  return typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
}

function resolveMaxWorkers() {
  if (!process.env.CI) {
    return '50%';
  }
  return Math.max(CI_MIN_WORKERS, Math.floor(cpuCount() / 2));
}

module.exports = { maxWorkers: resolveMaxWorkers() };
