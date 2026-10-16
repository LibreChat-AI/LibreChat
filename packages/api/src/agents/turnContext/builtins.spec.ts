import { Constants } from '@librechat/agents';
import { builtinCapability, schemaProfile, isUndispatchable } from './builtins';

/** Tool-name constants of the agents SDK that are not names of provider-bound tools or not grouped. */
const NOT_NAMES_OF_TOOLS = new Set([
  'OFFICIAL_CODE_BASEURL',
  'CONTENT_AND_ARTIFACT',
  'LC_TRANSFER_TO_',
  'HANDOFF_PARALLEL_BATCH',
  'HANDOFF_GROUP_ID',
  'MCP_DELIMITER',
  'ANTHROPIC_SERVER_TOOL_PREFIX',
  'INVOKED_PROVIDER',
  'INVOKED_MODEL',
]);

/**
 * Tools of the SDK's local engine and the subagent tool: they are bound by the SDK itself
 * or by features outside the capability toggles, so they stay live and ungrouped.
 */
const UNGROUPED = new Set([
  'SUBAGENT',
  'EDIT_FILE',
  'GREP_SEARCH',
  'GLOB_SEARCH',
  'LIST_DIRECTORY',
  'COMPILE_CHECK',
]);

describe('built-in capability groups', () => {
  it('place every tool-name constant of the SDK in a group, or list it as ungrouped', () => {
    const unknown = Object.entries(Constants)
      .filter(([key]) => !NOT_NAMES_OF_TOOLS.has(key) && !UNGROUPED.has(key))
      .filter(([, name]) => builtinCapability(name as string) == null)
      .map(([key]) => key);
    expect(unknown).toEqual([]);
  });

  it('moves the skill file tools to the skills group only without a code environment', () => {
    expect(builtinCapability(Constants.READ_FILE, true)).toBe('execute_code');
    expect(builtinCapability(Constants.READ_FILE, false)).toBe('skills');
    expect(builtinCapability(Constants.READ_FILE)).toBe('execute_code');
  });

  it('cannot reach the question tool through the dispatcher', () => {
    expect(isUndispatchable('ask_user_question')).toBe(true);
    expect(isUndispatchable('web_search')).toBe(false);
  });

  it('reads the schema-profile parameters a tool carries', () => {
    expect(schemaProfile(undefined)).toBe('');
    expect(
      schemaProfile({ type: 'object', properties: { intent: { type: 'string' }, q: {} } } as never),
    ).toBe('intent');
  });
});
