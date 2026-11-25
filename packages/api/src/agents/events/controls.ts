import type { Subscription, Watch } from 'librechat-data-provider';

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
 * True when the subscription still lets the watch continue its conversation: the same one,
 * on, still allowing watching, and the same owner, agent, connection and tenant. Read where
 * an event is routed and again when its turn is dispatched.
 */
export function governs(
  watch: Watch,
  subscription: Subscription | null | undefined,
): subscription is Subscription {
  return (
    subscription != null &&
    subscription.id === watch.subscription &&
    subscription.enabled &&
    subscription.watch &&
    subscription.user === watch.user &&
    subscription.agentId === watch.agentId &&
    subscription.connection === watch.connection &&
    (subscription.tenantId ?? null) === (watch.tenantId ?? null)
  );
}
