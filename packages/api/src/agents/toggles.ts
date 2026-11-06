/**
 * @fileoverview How an ephemeral or model-spec agent's tool toggles resolve.
 *
 * The chat badges seed from the model spec and the client sends the user's
 * resulting choice, including an explicit `false` for a badge switched off.
 * The spec is the default, not an override: a visible badge the user turned off
 * stays off. A spec that hides the badge row offers no badges to switch, so its
 * own flags decide.
 *
 * @module packages/api/src/agents/toggles
 */

import { Tools } from 'librechat-data-provider';
import type { AgentToolOptions, TEphemeralAgent, TModelSpec } from 'librechat-data-provider';
import { ASK_USER_QUESTION_TOOL_NAME } from './hitl/askUserQuestionTool';
import { synthesizeBackgroundToolOptions } from './background';
import { synthesizeDeferralToolOptions } from './deferral';
import { mergeSynthesizedToolOptions } from './selection';
import { synthesizeIntentToolOptions } from './intent';

type ToggleFields =
  | 'execute_code'
  | 'file_search'
  | 'web_search'
  | 'memory'
  | 'ask_user_question'
  | 'run_in_background'
  | 'describe_intent';

interface ToggleSources {
  ephemeralAgent?: Pick<TEphemeralAgent, ToggleFields> | null;
  modelSpec?: TModelSpec | null;
}

/** Resolves one tool toggle from the user's badge and the spec's default. */
export function resolveToolToggle(
  userValue: boolean | undefined,
  specValue: boolean | undefined,
  modelSpec?: Pick<TModelSpec, 'hideBadgeRow'> | null,
): boolean {
  if (modelSpec?.hideBadgeRow === true) {
    return (specValue ?? userValue) === true;
  }
  return (userValue ?? specValue) === true;
}

/** The tool entries an ephemeral or model-spec agent's toggles equip, in load order. */
export function getToggleToolNames({ ephemeralAgent, modelSpec }: ToggleSources): string[] {
  const toggles: Array<[string, boolean | undefined, boolean | undefined]> = [
    [Tools.execute_code, ephemeralAgent?.execute_code, modelSpec?.executeCode],
    [Tools.file_search, ephemeralAgent?.file_search, modelSpec?.fileSearch],
    [Tools.web_search, ephemeralAgent?.web_search, modelSpec?.webSearch],
    [Tools.memory, ephemeralAgent?.memory, modelSpec?.memory],
    [ASK_USER_QUESTION_TOOL_NAME, ephemeralAgent?.ask_user_question, modelSpec?.askUserQuestion],
  ];
  const tools: string[] = [];
  for (const [toolName, userValue, specValue] of toggles) {
    if (resolveToolToggle(userValue, specValue, modelSpec)) {
      tools.push(toolName);
    }
  }
  return tools;
}

/**
 * Per-tool options an ephemeral or model-spec agent carries in place of saved
 * `tool_options`: its background, intent and deferral selections, composed.
 */
export function synthesizeToggleToolOptions({
  ephemeralAgent,
  modelSpec,
}: ToggleSources): AgentToolOptions | undefined {
  const toolOptions = mergeSynthesizedToolOptions(
    synthesizeBackgroundToolOptions({ ephemeralAgent, modelSpec }),
    synthesizeIntentToolOptions({ ephemeralAgent, modelSpec }),
  );
  return mergeSynthesizedToolOptions(toolOptions, synthesizeDeferralToolOptions({ modelSpec }));
}
