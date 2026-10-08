import { logger } from '@librechat/data-schemas';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { Run, IState } from '@librechat/agents';

/**
 * Context handed to a test run hook so it can shape fake-model behavior from
 * the conversation and the agents' advertised tools.
 */
export interface TestRunHookContext {
  messages?: BaseMessage[];
  /**
   * Identifies the conversation this run belongs to. A resumed run rebuilds
   * `createRun` with no messages because state is rehydrated from the
   * checkpoint, so message history alone cannot tell a resume apart from a
   * fresh attempt; this is the stable identity across both.
   */
  conversationId?: string;
  agents: ReadonlyArray<{ tools?: ReadonlyArray<{ name: string }> }>;
  /** Opaque model-client handlers forwarded to the fake model by the e2e harness. */
  modelCallbacks?: readonly object[];
}

export type TestRunHook = (run: Run<IState>, context: TestRunHookContext) => void;

/**
 * Env-gated extension point used only by the e2e harness. When
 * `LIBRECHAT_TEST_RUN_HOOK` points at a module, it is loaded and invoked with
 * the freshly created run so a test can swap in a fake model via
 * `run.Graph.overrideTestModel(...)` instead of reaching a live provider. A
 * no-op (returns immediately) in normal operation since the env var is unset.
 */
export function applyTestRunHook(run: Run<IState>, context: TestRunHookContext): void {
  const hookPath = process.env.LIBRECHAT_TEST_RUN_HOOK;
  if (!hookPath) {
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require(hookPath) as TestRunHook | { default?: TestRunHook };
    const hook = typeof loaded === 'function' ? loaded : loaded.default;
    if (typeof hook !== 'function') {
      logger.warn(`[applyTestRunHook] ${hookPath} did not export a function`);
      return;
    }
    hook(run, context);
  } catch (error) {
    logger.error(`[applyTestRunHook] Failed to apply hook from ${hookPath}`, error);
  }
}
