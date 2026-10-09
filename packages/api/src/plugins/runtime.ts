import { createHash } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import { matchesQuery } from '@librechat/agents';
import type { HookRegistry, HookOutput } from '@librechat/agents';
import type {
  PluginHookExecutionRequest,
  PluginHookRuntimeContext,
  PluginHookCapabilities,
  PluginHookExecutor,
  PluginHookHandler,
} from '~/agents/hooks';
import type { LoadedPlugin } from './types';
import {
  commandExecutorCapabilities,
  createCommandExecutor,
  registerPluginHooks,
} from '~/agents/hooks';
import { getDeploymentPluginRegistry } from './deployment';
import { DEPLOYMENT_PLUGIN_HOOKS_ENV } from './constants';
import { getPluginHookOnceStore } from './once';
import { isEnabled } from '~/utils/common';

const KEY_SEPARATOR = '\u0000';

/**
 * Compact stable digest of a handler declaration. The declaration indexes
 * already identify the handler positionally; this distinguishes an edited
 * handler at the same position without storing its full body — commands run
 * to 32 KB and may carry 256 similarly sized args, which would otherwise be
 * copied into every retained conversation scope.
 */
function handlerIdentity(handler: PluginHookHandler): string {
  const canonical = JSON.stringify(
    Object.entries(handler).sort(([left], [right]) => left.localeCompare(right)),
  );
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 22);
}

/** Conversation scope: caller-supplied session ids cannot collide across principals. */
function onceScope(userId: string | undefined, sessionId: string): string {
  return [userId ?? '', sessionId].join(KEY_SEPARATOR);
}

function onceKey(pluginId: string, request: PluginHookExecutionRequest): string {
  return [
    pluginId,
    request.sourceEvent,
    /** SessionStart dedupes per lifecycle source: startup must not suppress resume. */
    request.payload.source ?? '',
    String(request.groupIndex),
    String(request.handlerIndex),
    handlerIdentity(request.handler),
  ].join(KEY_SEPARATOR);
}

/**
 * Hook registration is per-run, so the runtime's own SessionStart and `once`
 * dedup only spans one run. The once store extends both across runs of the
 * same conversation (see `once.ts` for the store's ownership and eviction
 * contract). Keys carry the declaration position and handler identity so one
 * handler firing never suppresses a sibling declared on the same event.
 * Suppression happens in `shouldExecute` — before the runtime's per-input
 * dedup slot is claimed — so a spent declaration never shadows an identical
 * handler declared under an overlapping matcher.
 */
function withOnceDedup(
  pluginId: string,
  userId: string | undefined,
  executor: PluginHookExecutor,
): PluginHookExecutor {
  return {
    capabilities: executor.capabilities,
    shouldExecute(request): boolean | Promise<boolean> {
      const oncePerSession =
        request.sourceEvent === 'SessionStart' || request.handler.once === true;
      if (!oncePerSession) {
        return true;
      }
      const scope = onceScope(userId, request.payload.session_id);
      const first = getPluginHookOnceStore().markOnce(scope, onceKey(pluginId, request));
      if (first instanceof Promise) {
        return first.catch((error) => {
          /** A failed store lookup fails open — over-firing is the store's documented direction. */
          logger.warn(`[pluginHooks] Once-store lookup failed for plugin "${pluginId}"`, error);
          return true;
        });
      }
      return first;
    },
    execute(request, signal): HookOutput | Promise<HookOutput> {
      return executor.execute(request, signal);
    },
  };
}

/**
 * Capabilities handed to plugin loading when the operator has opted in to
 * hook execution via `DEPLOYMENT_PLUGIN_HOOKS`. Undefined (the default) keeps
 * hook documents parsed-but-inert, with the existing "not executed" warning.
 */
export function getDeploymentPluginHookCapabilities(
  env: NodeJS.ProcessEnv = process.env,
): PluginHookCapabilities | undefined {
  return isEnabled(env[DEPLOYMENT_PLUGIN_HOOKS_ENV]) ? commandExecutorCapabilities : undefined;
}

function getExecutableHookPlugins(): LoadedPlugin[] {
  return getDeploymentPluginRegistry()
    .list()
    .filter((plugin) => (plugin.hooks?.plan.summary.ready ?? 0) > 0);
}

export function hasDeploymentPluginHooks(): boolean {
  return getExecutableHookPlugins().length > 0;
}

/** Whether any executable deployment-plugin hook can return a tool decision. */
export function hasDeploymentPluginToolApprovalHooks(toolNames?: readonly string[]): boolean {
  return getExecutableHookPlugins().some((plugin) =>
    plugin.hooks?.plan.entries.some((entry) => {
      if (entry.status !== 'ready' || entry.targetEvent !== 'PreToolUse') {
        return false;
      }
      return toolNames == null || toolNames.some((name) => matchesQuery(entry.matcher, name));
    }),
  );
}

export interface RegisterDeploymentPluginHooksOptions {
  registry: HookRegistry;
  context?: PluginHookRuntimeContext;
  /**
   * Whether the run has a HITL approval surface (checkpointer + resume route).
   * Off by default: without it a plugin's `ask` decision is tightened to
   * `deny`, since an un-resumable interrupt would strand the run.
   */
  askDecisionSupported?: boolean;
}

/**
 * Registers every loaded deployment plugin's ready hooks onto a run's hook
 * registry. Called once per run from the run-construction seam; the registry
 * (and with it every registration) is garbage-collected with the run.
 * Returns the number of handlers registered.
 */
export function registerDeploymentPluginHooks(
  options: RegisterDeploymentPluginHooksOptions,
): number {
  const sessionId = options.context?.sessionId;
  if (sessionId !== undefined) {
    /**
     * Refreshes the conversation's once-state retention on every run, so even
     * rarely-matching `once` handlers keep their keys while the conversation
     * stays active. A failed refresh only risks earlier eviction, so an async
     * store's rejection is logged rather than failing run construction.
     */
    const touched = getPluginHookOnceStore().touch(onceScope(options.context?.userId, sessionId));
    if (touched instanceof Promise) {
      touched.catch((error) => logger.warn('[pluginHooks] Once-store touch failed', error));
    }
  }
  let registered = 0;
  for (const plugin of getExecutableHookPlugins()) {
    const document = plugin.hooks?.document;
    const plan = plugin.hooks?.plan;
    if (document === undefined || plan === undefined) {
      continue;
    }
    const pluginId = plugin.manifest.name;
    const executor = withOnceDedup(
      pluginId,
      options.context?.userId,
      createCommandExecutor({
        pluginRoot: plugin.root,
        pluginData: plugin.dataDirectory,
        allowAskDecision: options.askDecisionSupported === true,
      }),
    );
    try {
      const registration = registerPluginHooks({
        pluginId,
        registry: options.registry,
        document,
        /** Load-time plan, computed with the same static executor capabilities. */
        plan,
        executor,
        /**
         * The caller's working directory passes through untouched: payload
         * `cwd` reports the run's session context, which a guard may use to
         * resolve relative tool paths. The plugin's own installation path
         * reaches commands as `PLUGIN_ROOT`/`CLAUDE_PLUGIN_ROOT`, and the
         * executor separately runs each process from that directory.
         */
        context: options.context,
      });
      registered += registration.registered;
    } catch (error) {
      logger.error(`[pluginHooks] Failed to register hooks for plugin "${pluginId}"`, error);
    }
  }
  return registered;
}
