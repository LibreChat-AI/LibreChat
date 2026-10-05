import type { AppConfig } from '@librechat/data-schemas';
import type { HookCallback } from '@librechat/agents';

/**
 * Per-run context handed to a {@link ToolApprovalHookFactory} when a run is built. It carries
 * the request-scoped facts the SDK's `PreToolUse` hook input does NOT include — the user, the
 * conversation, the tenant, and the resolved app config — so a process-wide hook can
 * specialize its decision per request (e.g. "auto-approve for admins", "stricter for tenant
 * X"). The SDK input already provides the per-call facts (tool name, args, agent, thread,
 * turn); this fills the request-identity gap.
 */
export interface ToolApprovalHookContext {
  /** The requesting user's id, when authenticated. */
  userId?: string;
  /** The conversation (== LangGraph `thread_id`) the run belongs to. */
  conversationId?: string;
  /** Tenant id, in multi-tenant deployments. */
  tenantId?: string;
  /** The resolved app config for the request. */
  appConfig?: AppConfig;
}

/**
 * A programmatic tool-approval hook: a `PreToolUse` callback that decides `allow` / `ask` /
 * `deny` (and may rewrite the tool args via `updatedInput` or restrict the offered decisions
 * via `allowedDecisions`) from the FULL live call — tool name, args, executing agent, thread,
 * turn — not just the static name lists in `endpoints.agents.toolApproval`. Return an empty
 * object (`{}`) to abstain and fall through to the configured policy / other hooks.
 *
 * Hooks COMPOSE with the static policy through the SDK's `PreToolUse` fold, which resolves
 * decisions `deny` > `ask` > `allow`. A hook can therefore only ever TIGHTEN a configured
 * `ask` / `deny` — it can never silently auto-approve past policy. To loosen, change the
 * static policy. (The SDK's own `createWorkspacePolicyHook` is this exact shape.)
 */
export type ToolApprovalHook = HookCallback<'PreToolUse'>;

/**
 * Builds a {@link ToolApprovalHook} for one run from its {@link ToolApprovalHookContext}.
 * Return `undefined` to opt out of this run entirely (e.g. the policy doesn't apply to this
 * user, or the app config disables the hook) — cheaper and clearer than a hook that always
 * abstains. Registered process-wide via {@link registerToolApprovalHook}.
 */
export type ToolApprovalHookFactory = (
  context: ToolApprovalHookContext,
) => ToolApprovalHook | undefined;

export interface ResolvedToolApprovalHook {
  hook: ToolApprovalHook;
  matcher?: string;
  /** Optional admission-only scope for hooks that inspect the executing agent at runtime. */
  agentIds?: ReadonlySet<string>;
  /** Complete set of tool names this hook can ask about; omission means unresolved. */
  toolNames?: readonly string[];
}

interface RegisteredHook {
  factory: ToolApprovalHookFactory;
  /** Optional regex matched against the tool name (the `PreToolUse` matcher `pattern`). */
  matcher?: string;
}

/**
 * Process-wide registry of tool-approval hook factories. Populated once at startup by host
 * code / plugins; read per run by {@link buildToolApprovalHooks}. Kept module-private so the
 * only mutations go through the register/clear API (registration order is preserved, which
 * the SDK's last-writer-wins precedence for `updatedInput` / `allowedDecisions` relies on).
 */
const registeredHooks: RegisteredHook[] = [];

/**
 * Register a programmatic tool-approval hook (process-wide). Call once at startup. Returns an
 * unregister function that removes exactly this registration.
 *
 * Inert unless tool approval is enabled. Hooks run in the `PreToolUse` fold of
 * both interactive and headless runs (see {@link buildToolApprovalHooks} /
 * `buildHITLRunWiring`). Headless `ask` decisions are denied without pausing.
 * They compose with, and can only tighten, the static policy.
 *
 * @param factory Builds the per-run hook from its context; return `undefined` to opt out.
 * @param options.matcher Optional regex string matched against the tool name — omit to run for
 *   every tool. Patterns are compiled with `new RegExp` by the SDK without a sandbox, so only
 *   register trusted / length-bounded patterns.
 */
export function registerToolApprovalHook(
  factory: ToolApprovalHookFactory,
  options: { matcher?: string } = {},
): () => void {
  const entry: RegisteredHook = { factory, matcher: options.matcher };
  registeredHooks.push(entry);
  return () => {
    const index = registeredHooks.indexOf(entry);
    if (index >= 0) {
      registeredHooks.splice(index, 1);
    }
  };
}

/** Number of currently-registered hook factories (diagnostics / tests). */
export function getRegisteredToolApprovalHookCount(): number {
  return registeredHooks.length;
}

/** Remove every registered hook. Test/teardown helper. */
export function clearToolApprovalHooks(): void {
  registeredHooks.length = 0;
}

/**
 * Resolve the registered hook factories against a run's {@link ToolApprovalHookContext} into
 * concrete `PreToolUse` hooks (each with its optional tool-name matcher). Factories that
 * return `undefined` (opt out for this run) are dropped. Registration order is preserved.
 *
 * Consumed by `buildHITLRunWiring`, which registers these AFTER the static-policy hook so a
 * host hook's `updatedInput` / `allowedDecisions` win the SDK's last-writer-wins precedence.
 */
export function buildToolApprovalHooks(
  context: ToolApprovalHookContext,
): ResolvedToolApprovalHook[] {
  const built: ResolvedToolApprovalHook[] = [];
  for (const { factory, matcher } of registeredHooks) {
    const hook = factory(context);
    if (hook) {
      built.push({ hook, matcher });
    }
  }
  return built;
}

/** Whether any resolved hook matcher can run for one of the supplied tool names. */
export function resolvedToolApprovalHooksCanMatch(
  hooks: readonly ResolvedToolApprovalHook[],
  toolNames: readonly string[],
  agentId?: string,
): boolean {
  return hooks.some(({ matcher, agentIds }) => {
    if (agentIds != null && (agentId == null || !agentIds.has(agentId))) {
      return false;
    }
    if (matcher == null) {
      return toolNames.length > 0;
    }
    let regex: RegExp;
    try {
      regex = new RegExp(matcher);
    } catch {
      return false;
    }
    return toolNames.some((name) => {
      regex.lastIndex = 0;
      return regex.test(name);
    });
  });
}
