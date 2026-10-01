import {
  HookRegistry,
  createToolPolicyHook,
  TOOL_APPROVAL_EXECUTION_SCOPE_CONFIG_KEY,
} from '@librechat/agents';
import type { TToolApprovalPolicy } from 'librechat-data-provider';
import type { HookCallback } from '@librechat/agents';
import type { ResolvedToolApprovalHook, ToolApprovalHookContext } from './hooks';
import type { MCPToolAlias } from '~/tools/classification';
import { isHITLEnabled, mapToolApprovalPolicy } from './policy';
import { buildToolApprovalHooks } from './hooks';
import { EDIT_FILE_TOOL_NAME } from '../tools';
import { normalizeEditArgs } from '../edits';

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
 * The policy hooks apply to every caller. Only callers that support pause/resume
 * also attach the `humanInTheLoop` switch and the durable checkpointer.
 * The checkpointer is resolved separately (it's an async, process-wide singleton)
 * and merged into `graphConfig.compileOptions` at the call site.
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
 * Assemble tool-approval policy hooks and optional interactive HITL wiring, or
 * `undefined` when the policy is disabled. Non-resumable callers attach only
 * `hooks`; the SDK denies `ask` rather than pausing without a resume surface.
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
  nativeEditFileAgentIds: ReadonlySet<string> = new Set(),
): HITLRunWiring | undefined {
  if (!isHITLEnabled(policy)) {
    return undefined;
  }

  const normalizeInput = (input: Parameters<HookCallback<'PreToolUse'>>[0]['toolInput']) => {
    if (typeof input.path !== 'string' || input.path.length === 0) return 'path is required';
    const edits = normalizeEditArgs(input);
    if (typeof edits === 'string') return edits;
    const normalized: typeof input = { ...input, edits };
    delete normalized.old_text;
    delete normalized.new_text;
    delete normalized.replace_all;
    return normalized;
  };
  const withNormalizedEdits =
    (hook: HookCallback<'PreToolUse'>): HookCallback<'PreToolUse'> =>
    async (input, signal) => {
      if (
        input.toolName !== EDIT_FILE_TOOL_NAME ||
        input.executingAgentId == null ||
        !nativeEditFileAgentIds.has(input.executingAgentId)
      ) {
        return hook(input, signal);
      }
      const normalized = normalizeInput(input.toolInput);
      if (typeof normalized === 'string') return { decision: 'deny', reason: normalized };
      /** A fresh updatedInput would supersede the checkpointed proposal on approval replay. */
      Object.assign(input.toolInput, normalized);
      delete input.toolInput.old_text;
      delete input.toolInput.new_text;
      delete input.toolInput.replace_all;
      const result = await hook(input, signal);
      if (result?.updatedInput == null) return result;
      const updatedInput = normalizeInput(result.updatedInput);
      if (typeof updatedInput === 'string') return { decision: 'deny', reason: updatedInput };
      return { ...result, updatedInput };
    };
  const registry = new HookRegistry();
  let activePolicy: TToolApprovalPolicy | undefined = policy;
  const aliases = [...mcpToolAliases];
  const registeredAliases = new Set(
    aliases.map(({ name, aliasName }) => `${name}\u0000${aliasName}`),
  );
  // Static config-driven policy (mode/allow/deny/ask) — the baseline.
  registry.register('PreToolUse', {
    hooks: [
      withNormalizedEdits(async (input, signal) =>
        createToolPolicyHook(mapToolApprovalPolicy(activePolicy) ?? {})(input, signal),
      ),
    ],
  });

  // Host-registered programmatic hooks — context-aware, layered after the static-policy hook.
  const programmaticHooks = resolvedProgrammaticHooks ?? buildToolApprovalHooks(context);
  for (const { hook, matcher } of programmaticHooks) {
    if (matcher == null) {
      registry.register('PreToolUse', { hooks: [withNormalizedEdits(hook)] });
      continue;
    }
    registry.register('PreToolUse', {
      hooks: [
        withNormalizedEdits(async (input, signal) => {
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
        }),
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
