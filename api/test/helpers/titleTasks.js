/**
 * Stands in for `~/server/services/Endpoints/agents/titles` in controller specs that mock
 * `@librechat/api` wholesale. An admitted attempt runs the controller's generator right away,
 * with a signal `stop` and `discard` abort, and records the row gate it was handed.
 *
 *   jest.mock('~/server/services/Endpoints/agents/titles', () => require('~/test/helpers/titleTasks'));
 */
const attempts = [];

const titleTasks = {
  admit: jest.fn(async (owner) => {
    const controller = new AbortController();
    const attempt = {
      owner,
      ready: undefined,
      signal: controller.signal,
      run: jest.fn(async ({ generate, ready }) => {
        attempt.ready = ready;
        await generate(controller.signal);
        await ready;
      }),
      stop: jest.fn(() => controller.abort()),
      discard: jest.fn(() => controller.abort()),
      release: jest.fn(async () => undefined),
    };
    attempts.push(attempt);
    return attempt;
  }),
  cancel: jest.fn(async () => undefined),
};

module.exports = {
  titleTasks,
  titleStreamHandler: jest.fn(),
  configureTitleStream: jest.fn(),
  /** Every attempt admitted since the module loaded, oldest first. */
  titleAttempts: attempts,
};
