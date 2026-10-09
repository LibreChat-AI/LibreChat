/**
 * Quiet framework logging in unit tests, shared by every backend workspace.
 *
 * Sets env only — each logger reads these at first module load inside a test
 * file, so nothing is eagerly required here. Requiring the logger from a setup
 * file would freeze env-dependent module state (e.g. `CREDS_KEY`) before a spec
 * gets to set it.
 *
 * Set TEST_VERBOSE_LOGS=true to get the logs back while debugging locally.
 */
if (process.env.TEST_VERBOSE_LOGS !== 'true') {
  process.env.CONSOLE_LOG_LEVEL = 'silent';
  process.env.LOG_TO_FILE = 'false';
}
