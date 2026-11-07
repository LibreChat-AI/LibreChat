import { Tools } from 'librechat-data-provider';
import { Constants } from '@librechat/agents';
import type { LCTool } from '@librechat/agents';
import {
  EDIT_FILE_TOOL_NAME,
  CREATE_FILE_TOOL_NAME,
  SEARCH_WORKSPACE_TOOL_NAME,
  LIST_WORKSPACE_FILES_TOOL_NAME,
} from '../tools';
import { CHECK_BACKGROUND_TASK_NAME, RUN_IN_BACKGROUND_ARG } from '../background';
import { DELETE_MEMORY_TOOL_NAME, SET_MEMORY_TOOL_NAME } from '../memory';
import { ASK_USER_QUESTION_TOOL_NAME } from '../hitl/askUserQuestionTool';
import { INTENT_ARG } from '../intent';

/**
 * Built-in capabilities in the order a new anchor binds them, with the tool names
 * and `agent.tools` markers each owns.
 */
const BUILTIN_GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [Tools.web_search, [Tools.web_search]],
  [Tools.file_search, [Tools.file_search]],
  [
    Tools.execute_code,
    [
      Tools.execute_code,
      Constants.BASH_TOOL,
      Constants.READ_FILE,
      Constants.WRITE_FILE,
      CREATE_FILE_TOOL_NAME,
      EDIT_FILE_TOOL_NAME,
      SEARCH_WORKSPACE_TOOL_NAME,
      LIST_WORKSPACE_FILES_TOOL_NAME,
    ],
  ],
  ['programmatic', [Constants.PROGRAMMATIC_TOOL_CALLING, Constants.BASH_PROGRAMMATIC_TOOL_CALLING]],
  ['skills', [Constants.SKILL_TOOL]],
  [Tools.memory, [Tools.memory, SET_MEMORY_TOOL_NAME, DELETE_MEMORY_TOOL_NAME]],
  [ASK_USER_QUESTION_TOOL_NAME, [ASK_USER_QUESTION_TOOL_NAME]],
  ['background', [CHECK_BACKGROUND_TASK_NAME]],
  ['tool_search', [Constants.TOOL_SEARCH]],
];

/** File tools the skills capability registers when the agent has no code environment. */
const SKILL_FILE_TOOL_NAMES = new Set<string>([
  Constants.READ_FILE,
  CREATE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
]);

/** Run as in-graph tools, which the dispatcher cannot reach: enabling one mid-segment resets. */
const UNDISPATCHABLE = new Set<string>([ASK_USER_QUESTION_TOOL_NAME]);

/** Parameters that schema-profile options add to many tools at once. */
const PROFILE_PARAMETERS = [INTENT_ARG, RUN_IN_BACKGROUND_ARG];

const owners = new Map(
  BUILTIN_GROUPS.flatMap(([capability, names]) =>
    names.map((name): [string, string] => [name, capability]),
  ),
);
const ranks = new Map(BUILTIN_GROUPS.map(([capability], index) => [capability, index]));

/** The built-in capability that owns a tool or marker; undefined for any other tool. */
export function builtinCapability(name: string, codeEnvAvailable?: boolean): string | undefined {
  if (SKILL_FILE_TOOL_NAMES.has(name) && codeEnvAvailable === false) {
    return 'skills';
  }
  return owners.get(name);
}

export const builtinRank = (capability: string): number => ranks.get(capability) ?? 0;

export const isUndispatchable = (capability: string): boolean => UNDISPATCHABLE.has(capability);

/** The schema-profile parameters a tool schema carries, as a comparable string. */
export function schemaProfile(parameters: LCTool['parameters']): string {
  const properties = (parameters as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  return PROFILE_PARAMETERS.filter((name) => properties?.[name] != null).join(',');
}
