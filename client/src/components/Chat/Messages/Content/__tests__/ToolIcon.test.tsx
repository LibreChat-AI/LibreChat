import { Constants, actionDelimiter } from 'librechat-data-provider';
import { getToolIconType } from '../ToolOutput/ToolIcon';

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}));

describe('getToolIconType - ACTN-01: Action delimiter detection', () => {
  it('returns "action" for tool name containing actionDelimiter', () => {
    const toolName = `get_weather${actionDelimiter}weather---api---com`;
    expect(getToolIconType(toolName)).toBe('action');
  });

  it('returns "mcp" when name has both mcp_delimiter and actionDelimiter', () => {
    const toolName = `tool${Constants.mcp_delimiter}server`;
    expect(getToolIconType(toolName)).toBe('mcp');
  });

  it('returns "mcp" not "action" for MCP tool whose name ends with _action (cross-delimiter collision)', () => {
    const toolName = `get_action${Constants.mcp_delimiter}myserver`;
    expect(getToolIconType(toolName)).not.toBe('action');
    expect(getToolIconType(toolName)).toBe('mcp');
  });

  it('returns "generic" for plain tool name without delimiters', () => {
    expect(getToolIconType('some_plain_tool')).toBe('generic');
  });

  it('gives the native background-task tool its own icon while preserving MCP identity', () => {
    expect(getToolIconType(Constants.CHECK_BACKGROUND_TASK)).toBe('background_tasks');
    expect(
      getToolIconType(`${Constants.CHECK_BACKGROUND_TASK}${Constants.mcp_delimiter}remote`),
    ).toBe('mcp');
  });

  it('returns correct types for existing tool names', () => {
    expect(getToolIconType('execute_code')).toBe('execute_code');
    expect(getToolIconType(Constants.PROGRAMMATIC_TOOL_CALLING)).toBe('execute_code');
    expect(getToolIconType('web_search')).toBe('web_search');
    expect(getToolIconType('image_gen_oai')).toBe('image_gen');
    expect(getToolIconType('image_edit_oai')).toBe('image_gen');
    expect(getToolIconType('gemini_image_gen')).toBe('image_gen');
    expect(getToolIconType(`${Constants.LC_TRANSFER_TO_}agent1`)).toBe('agent_handoff');
  });
});

describe('getToolIconType - SKILL-01: Skill tool icon types', () => {
  it('returns "skill" for tool name "skill"', () => {
    expect(getToolIconType('skill')).toBe('skill');
  });

  it('returns "read_file" for tool name "read_file"', () => {
    expect(getToolIconType('read_file')).toBe('read_file');
  });

  it('returns "bash_tool" for tool name "bash_tool"', () => {
    expect(getToolIconType('bash_tool')).toBe('bash_tool');
  });

  it('returns "bash_tool" for bash PTC tool calls', () => {
    expect(getToolIconType(Constants.BASH_PROGRAMMATIC_TOOL_CALLING)).toBe('bash_tool');
  });

  it('skill types take priority over the "generic" fallback', () => {
    expect(getToolIconType('skill')).not.toBe('generic');
    expect(getToolIconType('read_file')).not.toBe('generic');
    expect(getToolIconType('bash_tool')).not.toBe('generic');
    expect(getToolIconType(Constants.BASH_PROGRAMMATIC_TOOL_CALLING)).not.toBe('generic');
  });

  it('skill types take priority over the "action" fallback', () => {
    expect(getToolIconType('skill')).not.toBe('action');
    expect(getToolIconType('read_file')).not.toBe('action');
    expect(getToolIconType('bash_tool')).not.toBe('action');
    expect(getToolIconType(Constants.BASH_PROGRAMMATIC_TOOL_CALLING)).not.toBe('action');
  });
});
