/**
 * @fileoverview How an ephemeral or model-spec agent's tool toggles resolve.
 *
 * The chat badges seed from the model spec and the client sends the user's
 * resulting choice, including an explicit `false` for a badge switched off.
 * The spec is the default, not an override: a visible badge the user turned off
 * stays off.
 *
 * That only holds when the client could seed and show the spec's badges. A spec
 * that hides the badge row offers nothing to switch, and a `showInMenu: false`
 * spec never reaches the client's startup config, so whatever badge state it
 * sends was not chosen against this spec. Those keep combining both sources, so
 * a server-only spec still equips its tools.
 *
 * @module packages/api/src/agents/toggles
 */

import { Tools } from 'librechat-data-provider';
import type { TEphemeralAgent, TModelSpec } from 'librechat-data-provider';
import { ASK_USER_QUESTION_TOOL_NAME } from './hitl/askUserQuestionTool';

type ToggleFields = 'execute_code' | 'file_search' | 'web_search' | 'memory' | 'ask_user_question';

interface ToggleSources {
  ephemeralAgent?: Pick<TEphemeralAgent, ToggleFields> | null;
  modelSpec?: TModelSpec | null;
}

type BadgeVisibility = Pick<TModelSpec, 'hideBadgeRow' | 'showInMenu'>;

/** Whether the client seeded this spec's badges and showed them for the user to switch. */
export function hasUserControlledBadges(modelSpec: BadgeVisibility): boolean {
  return modelSpec.hideBadgeRow !== true && modelSpec.showInMenu !== false;
}

/** Resolves one tool toggle from the user's badge and the spec's default. */
export function resolveToolToggle(
  userValue: boolean | undefined,
  specValue: boolean | undefined,
  modelSpec?: BadgeVisibility | null,
): boolean {
  if (modelSpec != null && !hasUserControlledBadges(modelSpec)) {
    return userValue === true || specValue === true;
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
