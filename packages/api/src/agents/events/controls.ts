import type { Subscription, Watch, WatchPause } from 'librechat-data-provider';

/** The tool that has the conversation follow a pull request. */
export const WATCH_TOOL = 'watch';
/** The tool that stops following one. */
export const UNWATCH_TOOL = 'unwatch';

/**
 * Host controls, not grantable tools: they are offered only when the owner let the agent's
 * subscription watch, act only on this conversation's own watches, and are bounded by the
 * per-conversation limit. A run's grant does not list them and does not refuse them.
 */
export const WATCH_TOOLS: readonly string[] = [WATCH_TOOL, UNWATCH_TOOL];

/**
 * Why the subscription does not let the watch continue its conversation now, or `undefined`
 * when it does: it must be the same one, for the same owner, agent, connection and tenant
 * (`unbound` otherwise), on (`subscription_off`), and still allow watching (`watching_off`).
 */
export function pauseOf(
  watch: Watch,
  subscription: Subscription | null | undefined,
): WatchPause | undefined {
  if (
    subscription == null ||
    subscription.id !== watch.subscription ||
    subscription.user !== watch.user ||
    subscription.agentId !== watch.agentId ||
    subscription.connection !== watch.connection ||
    (subscription.tenantId ?? null) !== (watch.tenantId ?? null)
  )
    return 'unbound';
  if (!subscription.enabled) return 'subscription_off';
  if (!subscription.watch) return 'watching_off';
  return undefined;
}

/**
 * True when the subscription still lets the watch continue its conversation. Read where an
 * event is routed, again when its turn is dispatched, and where the owner lists the watch.
 */
export function governs(
  watch: Watch,
  subscription: Subscription | null | undefined,
): subscription is Subscription {
  return pauseOf(watch, subscription) === undefined;
}
