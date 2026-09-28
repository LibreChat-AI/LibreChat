import {
  HookRegistry,
  createToolPolicyHook,
  TOOL_APPROVAL_EXECUTION_SCOPE_CONFIG_KEY,
} from '@librechat/agents';
import type { TToolApprovalPolicy } from 'librechat-data-provider';
import type { ResolvedToolApprovalHook, ToolApprovalHookContext } from './hooks';
import type { MCPToolAlias } from '~/tools/classification';
import { isHITLEnabled, mapToolApprovalPolicy } from './policy';
import { buildToolApprovalHooks } from './hooks';

/** Stable across resumes; the job epoch separates edits that reuse a response id. */
export function buildToolApprovalExecutionConfig(
  responseMessageId: string,
  jobCreatedAt?: number,
): { [TOOL_APPROVAL_EXECUTION_SCOPE_CONFIG_KEY]: string } {
  return {
    [TOOL_APPROVAL_EXECUTION_SCOPE_CONFIG_KEY]: JSON.stringify([
      responseMessageId,
      jobCreatedAt ?? null,
    ]),
  };
}

/**
 * The HITL fragment spread onto a `RunConfig` when tool approval is enabled.
 *
 * Kept as one object so the run seam attaches the opt-in switch and the policy
 * hook together — they're meaningless apart. The checkpointer is resolved
 * separately (it's an async, process-wide singleton) and merged into
 * `graphConfig.compileOptions` at the call site.
 */
export interface HITLRunWiring {
  humanInTheLoop: { enabled: true };
  hooks: HookRegistry;
  /** Adds aliases discovered while a lazy subagent resolves. */
  addMCPToolAliases: (
    aliases: readonly MCPToolAlias[],
    policy: TToolApprovalPolicy | undefined,
  ) => void;
}

/**
 * Assemble the run-level HITL wiring for a tool-approval policy, or `undefined`
 * when HITL is disabled (the default) — in which case the run attaches nothing
 * and behaves exactly as it did before this feature.
 *
 * The returned `hooks` registry carries the static-config `PreToolUse` policy hook built
 * from {@link mapToolApprovalPolicy} (an enabled policy with no allow/deny/ask lists falls
 * through to `mode: 'default'`, i.e. every tool prompts — the safe default for "HITL on,
 * nothing else specified"), PLUS any host-registered programmatic hooks
 * ({@link registerToolApprovalHook}) resolved against `context`. The static hook is
 * registered first as the baseline; host hooks layer after it. Decisions fold in the SDK
 * as `deny` > `ask` > `allow`, so a host hook can only TIGHTEN the configured policy.
 */
export function buildHITLRunWiring(
  policy: TToolApprovalPolicy | undefined,
  context: ToolApprovalHookContext = {},
  mcpToolAliases: readonly MCPToolAlias[] = [],
  resolvedProgrammaticHooks?: readonly ResolvedToolApprovalHook[],
): HITLRunWiring | undefined {
  if (!isHITLEnabled(policy)) {
    return undefined;
  }

  const registry = new HookRegistry();
  let activePolicy: TToolApprovalPolicy | undefined = policy;
  const aliases = [...mcpToolAliases];
  const registeredAliases = new Set(
    aliases.map(({ name, aliasName }) => `${name}\u0000${aliasName}`),
  );
  // Static config-driven policy (mode/allow/deny/ask) — the baseline.
  registry.register('PreToolUse', {
    hooks: [
      async (input, signal) =>
        createToolPolicyHook(mapToolApprovalPolicy(activePolicy) ?? {})(input, signal),
    ],
  });

  // Host-registered programmatic hooks — context-aware, layered after the static-policy hook.
  const programmaticHooks = resolvedProgrammaticHooks ?? buildToolApprovalHooks(context);
  for (const { hook, matcher } of programmaticHooks) {
    if (matcher == null) {
      registry.register('PreToolUse', { hooks: [hook] });
      continue;
    }
    registry.register('PreToolUse', {
      hooks: [
        async (input, signal) => {
          let regex: RegExp;
          try {
            regex = new RegExp(matcher);
          } catch {
            return {};
          }
          regex.lastIndex = 0;
          if (regex.test(input.toolName)) {
            return hook(input, signal);
          }
          for (const { name, aliasName } of aliases) {
            if (name !== input.toolName) {
              continue;
            }
            regex.lastIndex = 0;
            if (regex.test(aliasName)) {
              return hook(input, signal);
            }
          }
          return {};
        },
      ],
    });
  }

  return {
    humanInTheLoop: { enabled: true },
    hooks: registry,
    addMCPToolAliases(newAliasCandidates, updatedPolicy) {
      const newAliases = newAliasCandidates.filter(({ name, aliasName }) => {
        const key = `${name}\u0000${aliasName}`;
        if (registeredAliases.has(key)) {
          return false;
        }
        registeredAliases.add(key);
        return true;
      });
      if (newAliases.length === 0) {
        return;
      }
      aliases.push(...newAliases);
      activePolicy = updatedPolicy;
    },
  };
}
