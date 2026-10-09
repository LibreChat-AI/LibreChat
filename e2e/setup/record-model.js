/**
 * Run hook for `E2E_MODEL_FIXTURES=record`: taps the REAL provider model's
 * stream instead of overriding it, writing each model invocation's chunks to
 * `e2e/fixtures/model-replay/$E2E_MODEL_FIXTURE_NAME.jsonl` for keyless replay
 * through `fake-model.js`. Set as `LIBRECHAT_TEST_RUN_HOOK` by the mock
 * Playwright config when recording; the server must be booted with a working
 * provider credential (`E2E_RECORD_PROVIDER_API_KEY`).
 */
const { installRecorder } = require('./model-replay');

/** @type {import('@librechat/api').TestRunHook} */
module.exports = function recordModelHook(run, context) {
  const graph = run?.Graph;
  if (!graph) {
    console.warn('[e2e model-replay] record hook: run.Graph unavailable');
    return;
  }
  installRecorder({
    graph,
    messages: context?.messages,
    conversationId: context?.conversationId,
  });
};
