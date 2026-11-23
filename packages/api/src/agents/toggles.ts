/**
 * @fileoverview Model-spec ↔ user-toggle reconciliation for ephemeral agents.
 *
 * A model spec's tool flags (`webSearch`, `executeCode`, `mcpServers`, …) are
 * DEFAULTS the chat badge row is seeded from, not mandatory additions: once
 * the client sends an explicit toggle for a capability, that toggle decides.
 * A spec that gives the user no control over its tools (`hideBadgeRow`, or
 * `showInMenu: false`) keeps authority over every capability it configures.
 *
 * Shared by both ephemeral loaders — `loadEphemeralAgent` (primary) and
 * `loadAddedAgent` (multi-convo) — so the two resolve identically.
 *
 * @module packages/api/src/agents/toggles
 */

import {
  Tools,
  SPEC_TOOL_TOGGLES,
  resolveSpecToolFlag,
  resolveSpecMcpServers,
} from 'librechat-data-provider';
import type { AgentToolOptions, TEphemeralAgent, TModelSpec } from 'librechat-data-provider';
import type { ChatSelectableLookup } from '~/mcp/utils';
import { ASK_USER_QUESTION_TOOL_NAME } from '~/agents/hitl/askUserQuestionTool';
import { synthesizeBackgroundToolOptions } from '~/agents/background';
import { synthesizeDeferralToolOptions } from '~/agents/deferral';
import { mergeSynthesizedToolOptions } from '~/agents/selection';
import { synthesizeIntentToolOptions } from '~/agents/intent';
import { filterChatSelectableMCPServers } from '~/mcp/utils';

/** Tool id equipped for each spec-configurable capability. */
const TOOL_NAMES: Record<string, string> = {
  web_search: Tools.web_search,
  file_search: Tools.file_search,
  execute_code: Tools.execute_code,
  memory: Tools.memory,
  ask_user_question: ASK_USER_QUESTION_TOOL_NAME,
};

export type EphemeralToolSource = Pick<
  TEphemeralAgent,
  'web_search' | 'file_search' | 'execute_code' | 'memory' | 'ask_user_question'
>;

export type SpecToolSource = Pick<
  TModelSpec,
  'webSearch' | 'fileSearch' | 'executeCode' | 'memory' | 'askUserQuestion'
>;

/**
 * Resolves the tool ids an ephemeral agent is equipped with, taking the model
 * spec as the default for each capability and the request's explicit toggle as
 * the decision. Downstream gating (admin capabilities, `createRun`'s HITL and
 * subagent filters) still applies to every id returned here.
 */
export function resolveEphemeralTools(
  ephemeralAgent: EphemeralToolSource | null | undefined,
  modelSpec: SpecToolSource | null | undefined,
): string[] {
  const tools: string[] = [];
  for (const [toggleKey, specKey] of SPEC_TOOL_TOGGLES) {
    if (resolveSpecToolFlag(ephemeralAgent?.[toggleKey], modelSpec?.[specKey])) {
      tools.push(TOOL_NAMES[toggleKey]);
    }
  }
  return tools;
}

export interface EphemeralMCPServerSources extends ChatSelectableLookup {
  /** The request's MCP picker selection, after spec authority was applied. */
  selected: string[] | null | undefined;
  /** The spec's configured servers. */
  specServers: string[] | null | undefined;
}

/**
 * Resolves the MCP servers an ephemeral agent is equipped with. The picker's
 * selection is narrowed to what the picker may offer and, whenever the request
 * sends one, decides among those servers: an empty selection is a deselection.
 * Spec servers the picker cannot offer were never the user's to deselect, so
 * they stay pinned. One accessibility lookup covers both lists.
 */
export async function resolveEphemeralMCPServers({
  selected,
  specServers,
  ...lookup
}: EphemeralMCPServerSources): Promise<string[]> {
  const requested = Array.isArray(selected) ? selected : undefined;
  const spec = specServers ?? [];
  const selectable = new Set(
    await filterChatSelectableMCPServers([...(requested ?? []), ...spec], lookup),
  );
  const pinned = spec.filter((server) => !selectable.has(server));
  const chosen = resolveSpecMcpServers(
    requested?.filter((server) => selectable.has(server)),
    spec.filter((server) => selectable.has(server)),
  );
  return [...new Set([...chosen, ...pinned])];
}

interface ToolOptionSources {
  ephemeralAgent?: Pick<TEphemeralAgent, 'run_in_background' | 'describe_intent'> | null;
  modelSpec?: Pick<TModelSpec, 'runInBackground' | 'describeIntent' | 'deferLoading'> | null;
}

/**
 * Per-tool options an ephemeral or model-spec agent carries in place of saved
 * `tool_options`: its background, intent and deferral selections, composed.
 */
export function synthesizeToggleToolOptions({
  ephemeralAgent,
  modelSpec,
}: ToolOptionSources): AgentToolOptions | undefined {
  const toolOptions = mergeSynthesizedToolOptions(
    synthesizeBackgroundToolOptions({ ephemeralAgent, modelSpec }),
    synthesizeIntentToolOptions({ ephemeralAgent, modelSpec }),
  );
  return mergeSynthesizedToolOptions(toolOptions, synthesizeDeferralToolOptions({ modelSpec }));
}
