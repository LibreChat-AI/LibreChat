import type { OpenAPIV3 } from 'openapi-types';

export type Schema = OpenAPIV3.SchemaObject & { description?: string };
export type Reference = OpenAPIV3.ReferenceObject & { description?: string };

export enum Tools {
  execute_code = 'execute_code',
  code_interpreter = 'code_interpreter',
  file_search = 'file_search',
  web_search = 'web_search',
  retrieval = 'retrieval',
  function = 'function',
  memory = 'memory',
  ui_resources = 'ui_resources',
  skill = 'skill',
  read_file = 'read_file',
  bash_tool = 'bash_tool',
}

export enum EToolResources {
  code_interpreter = 'code_interpreter',
  execute_code = 'execute_code',
  file_search = 'file_search',
  image_edit = 'image_edit',
  context = 'context',
  ocr = 'ocr',
}

export type Tool = {
  [type: string]: Tools;
};

export type FunctionTool = {
  type: Tools;
  function?: {
    description: string;
    name: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
    additionalProperties?: boolean; // must be false if strict is true https://platform.openai.com/docs/guides/structured-outputs/some-type-specific-keywords-are-not-yet-supported
  };
};

/**
 * A set of resources that are used by the assistant's tools. The resources are
 * specific to the type of tool. For example, the `code_interpreter` tool requires
 * a list of file IDs, while the `file_search` tool requires a list of vector store
 * IDs.
 */
export interface ToolResources {
  code_interpreter?: CodeInterpreterResource;
  file_search?: FileSearchResource;
}
export interface CodeInterpreterResource {
  /**
   * A list of [file](https://platform.openai.com/docs/api-reference/files) IDs made
   * available to the `code_interpreter`` tool. There can be a maximum of 20 files
   * associated with the tool.
   */
  file_ids?: Array<string>;
}

export interface FileSearchResource {
  /**
   * The ID of the
   * [vector store](https://platform.openai.com/docs/api-reference/vector-stores/object)
   * attached to this assistant. There can be a maximum of 1 vector store attached to
   * the assistant.
   */
  vector_store_ids?: Array<string>;
}

/**
 * Specifies who can invoke a tool.
 * - 'direct': LLM can call directly
 * - 'code_execution': Only callable via programmatic tool calling (PTC)
 */
export type AllowedCaller = 'direct' | 'code_execution';

/**
 * Per-tool configuration options stored at the agent level.
 * Keyed by tool_id (e.g., "search_mcp_github").
 */
export type ToolOptions = {
  /**
   * If true, the tool uses deferred loading (discoverable via tool search).
   * @default false
   */
  defer_loading?: boolean;
  /**
   * Specifies who can invoke this tool.
   * - 'direct': LLM can call directly (default behavior)
   * - 'code_execution': Only callable via PTC sandbox
   * @default ['direct']
   */
  allowed_callers?: AllowedCaller[];
  /**
   * If true (and the `run_in_background` capability is enabled), the tool's
   * schema gains a `run_in_background` boolean so the model can dispatch the
   * call detached and poll its result via `check_background_task`.
   * @default false
   */
  run_in_background?: boolean;
  /**
   * If true (and the `tool_intents` capability is enabled), the tool's schema
   * gains an `intent` string as its FIRST property — one model-authored
   * sentence per call, rendered as the call's live status label. Native host
   * tools default on while the capability is enabled; `false` opts one out.
   * @default false
   */
  describe_intent?: boolean;
};

/**
 * Map of tool_id to its configuration options.
 * Used to customize tool behavior per agent.
 */
export type AgentToolOptions = Record<string, ToolOptions>;

export const actionDelimiter = '_action_';
export const actionDomainSeparator = '---';
/** Mirrors `Constants.mcp_delimiter`; duplicated here to avoid a circular import from `config.ts`. */
const mcpDelimiter = '_mcp_';

/**
 * Checks whether a tool name is an OpenAPI action tool.
 *
 * Action format: `operationId_action_normalizedDomain`
 * MCP format:    `toolName_mcp_serverName`
 *
 * Cross-delimiter collision: an MCP tool like `get_action_mcp_srv` contains
 * `_action_` as a false positive. Guarded by checking whether `_mcp_` appears
 * after `_action_`. In the collision case the `_mcp_` suffix always follows
 * `_action_`; in a valid action tool whose operationId contains `_mcp_`, the
 * `_mcp_` precedes `_action_`.
 *
 * Theoretical limitation: a non-RFC-compliant domain containing literal
 * underscores that form `_mcp_` (e.g. `api_mcp_internal.com`) would produce
 * a false negative. RFC 952/1123 prohibit underscores in hostnames, so this
 * is not expected in practice.
 */
export function isActionTool(toolName: string): boolean {
  const actionIdx = toolName.indexOf(actionDelimiter);
  if (actionIdx < 0) {
    return false;
  }
  const mcpIdx = toolName.indexOf(mcpDelimiter);
  return mcpIdx < 0 || mcpIdx < actionIdx;
}
