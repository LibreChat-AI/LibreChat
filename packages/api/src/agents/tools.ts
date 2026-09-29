import {
  Tools,
  Constants,
  normalizeActionToolName,
  normalizeServerName,
  splitMCPToolKey,
} from 'librechat-data-provider';
import {
  Constants as AgentConstants,
  CODE_EXECUTION_TOOLS,
  BashExecutionToolDefinition,
  ReadFileToolDefinition,
  SkillToolDefinition,
  buildBashExecutionToolDescription,
} from '@librechat/agents';
import type {
  AgentToolOptions,
  CodeWorkspaceOperation,
  CodeWorkspaceDescriptor,
  GraphEdge,
} from 'librechat-data-provider';
import type { LCTool, LCToolRegistry } from '@librechat/agents';
import type { ReachableAgent } from './traversal';
import {
  buildAttachedWorkspaceBashSchema,
  buildAttachedWorkspaceBashDescription,
} from '~/code/command';
import { toolkitExpansion } from '~/tools/toolkits/mapping';
import { normalizeAgentToolKeys } from '~/mcp/utils';
import { collectReachableAgents } from './traversal';

export const CREATE_FILE_TOOL_NAME = 'create_file';
export const EDIT_FILE_TOOL_NAME = 'edit_file';
export const SEARCH_WORKSPACE_TOOL_NAME = 'search_workspace';
export const LIST_WORKSPACE_FILES_TOOL_NAME = 'list_workspace_files';
export const HOST_FILE_AUTHORING_ARTIFACT_KEY = '__librechat_file_authoring';
export const FILE_AUTHORING_TOOL_NAMES: ReadonlySet<string> = new Set([
  CREATE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
]);

/**
 * Every tool that reads or writes the code environment. Eligibility and provisioning both
 * consult this: a turn starting with any of them needs its files in the sandbox already,
 * and an agent that has any of them wants code-file provisioning built even when it never
 * names the `execute_code` marker itself.
 */
export const CODE_FILE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...CODE_EXECUTION_TOOLS,
  ...FILE_AUTHORING_TOOL_NAMES,
  AgentConstants.READ_FILE,
  AgentConstants.WRITE_FILE,
]);

export function isCodeFileToolName(name: string): boolean {
  return CODE_FILE_TOOL_NAMES.has(name);
}

export function isCodeSessionToolName(
  name: string,
  hostFileAuthoringToolNames?: ReadonlySet<string>,
): boolean {
  return (
    CODE_EXECUTION_TOOLS.has(name) ||
    name === SEARCH_WORKSPACE_TOOL_NAME ||
    name === LIST_WORKSPACE_FILES_TOOL_NAME ||
    hostFileAuthoringToolNames?.has(name) === true
  );
}

/** Tools that consume shared code, search, or image resources need current file records. */
export function isFileResourceToolName(name: string): boolean {
  return (
    isCodeFileToolName(name) ||
    isCodeSessionToolName(name) ||
    name === Tools.file_search ||
    name === 'image_gen_oai' ||
    name === 'image_edit_oai' ||
    name === 'gemini_image_gen'
  );
}

/** File-authoring artifacts opt in explicitly; other tool artifacts keep their normal delivery. */
export function isCodeArtifactToolOutput(output: { name: string; artifact?: unknown }): boolean {
  const artifact = output.artifact;
  return (
    isCodeSessionToolName(output.name) ||
    (artifact != null &&
      typeof artifact === 'object' &&
      HOST_FILE_AUTHORING_ARTIFACT_KEY in artifact &&
      artifact[HOST_FILE_AUTHORING_ARTIFACT_KEY] === true)
  );
}

interface ToolDefLike {
  name: string;
  [key: string]: unknown;
}

interface ToolInstanceLike {
  name: string;
  [key: string]: unknown;
}

export interface BuildToolSetConfig {
  toolDefinitions?: ToolDefLike[];
  tools?: (ToolInstanceLike | null | undefined)[];
  /** Tool names retained on unresolved agent descriptors for history replay. */
  historicalToolNames?: readonly string[];
}

export interface BuildHistoricalToolNamesConfig {
  configuredToolNames?: readonly string[];
  alwaysApplyToolNames?: readonly string[];
  toolOptions?: AgentToolOptions;
  rawMcpServerNames?: readonly string[];
  codeExecutionAvailable?: boolean;
  memoryAvailable?: boolean;
  skillsAvailable?: boolean;
  skillFileAccessAvailable?: boolean;
  skillAuthoringAvailable?: boolean;
  deferredToolsAvailable?: boolean;
  programmaticToolsAvailable?: boolean;
  backgroundToolsAvailable?: boolean;
}

export interface SkillToolAvailabilityConfig {
  /** True when at least one catalog-visible (model-invocable) skill resolved for the run. */
  modelInvocableSkillsAvailable?: boolean;
  /** True when the model may create or edit skill files during the run. */
  skillAuthoringAvailable?: boolean;
}

/**
 * Single rule for whether the `skill` tool reaches the model, shared by live
 * registration (`injectSkillCatalog`) and the lazy-history prediction below so
 * the two cannot disagree about a run's tool names.
 *
 * Authoring runs register it even with an empty catalog: a skill the model
 * creates mid-run becomes a valid invocation target, and tool definitions bind
 * at initialization, so a run that only learned about the skill afterwards
 * would have no way to invoke what it just wrote.
 */
export function isSkillToolAvailable(config: SkillToolAvailabilityConfig): boolean {
  return config.modelInvocableSkillsAvailable === true || config.skillAuthoringAvailable === true;
}

/** Derives the model-facing names an unresolved lazy agent can expose without loading it. */
export function buildHistoricalToolNames(config: BuildHistoricalToolNamesConfig): Set<string> {
  const configuredToolNames = [
    ...(config.configuredToolNames ?? []),
    ...(config.alwaysApplyToolNames ?? []),
  ];
  const normalized = normalizeAgentToolKeys({
    tools: configuredToolNames,
    toolOptions: config.toolOptions,
    rawServerNames: config.rawMcpServerNames ?? [],
  });
  const toolNames = new Set((normalized.tools ?? []).map(normalizeActionToolName));

  const normalizedOptions: AgentToolOptions = {};
  for (const [name, options] of Object.entries(normalized.toolOptions ?? {})) {
    const normalizedName = normalizeActionToolName(name);
    normalizedOptions[normalizedName] =
      normalizedName !== name
        ? { ...options, ...normalizedOptions[normalizedName] }
        : { ...normalizedOptions[name], ...options };
  }

  for (const name of [...toolNames]) {
    for (const child of toolkitExpansion[name as keyof typeof toolkitExpansion] ?? []) {
      toolNames.add(child);
    }
  }

  if (config.codeExecutionAvailable === true) {
    toolNames.add('bash_tool');
    toolNames.add('read_file');
    toolNames.add(CREATE_FILE_TOOL_NAME);
    toolNames.add(EDIT_FILE_TOOL_NAME);
    toolNames.add(SEARCH_WORKSPACE_TOOL_NAME);
    toolNames.add(LIST_WORKSPACE_FILES_TOOL_NAME);
  }
  if (config.memoryAvailable === true) {
    toolNames.add('set_memory');
    toolNames.add('delete_memory');
  }
  if (
    isSkillToolAvailable({
      modelInvocableSkillsAvailable: config.skillsAvailable,
      skillAuthoringAvailable: config.skillAuthoringAvailable,
    })
  ) {
    toolNames.add(SkillToolDefinition.name);
  }
  if ((config.skillFileAccessAvailable ?? config.skillsAvailable) === true) {
    toolNames.add('read_file');
  }
  if (config.skillAuthoringAvailable === true) {
    toolNames.add('read_file');
    toolNames.add(CREATE_FILE_TOOL_NAME);
    toolNames.add(EDIT_FILE_TOOL_NAME);
  }

  const options = normalizedOptions;
  const hasDeferredTool = [...toolNames].some((name) => options[name]?.defer_loading === true);
  if (config.deferredToolsAvailable === true && hasDeferredTool) {
    toolNames.add('tool_search');
  }
  const hasProgrammaticTool = [...toolNames].some((name) =>
    options[name]?.allowed_callers?.includes('code_execution'),
  );
  if (
    config.programmaticToolsAvailable === true &&
    config.codeExecutionAvailable === true &&
    hasProgrammaticTool
  ) {
    toolNames.add('run_tools_with_bash');
  }
  const hasBackgroundTool =
    config.codeExecutionAvailable === true ||
    [...toolNames].some((name) => options[name]?.run_in_background === true);
  if (config.backgroundToolsAvailable === true && hasBackgroundTool) {
    toolNames.add(`${Constants.CHECK_BACKGROUND_TASK}`);
  }

  return toolNames;
}

/**
 * Builds a Set of tool names for use with formatAgentMessages.
 *
 * In event-driven mode, tools are defined via toolDefinitions (which includes
 * deferred tools like tool_search). In legacy mode, tools come from loaded
 * tool instances.
 *
 * This ensures tool_search and other deferred tools are included in the toolSet,
 * allowing their ToolMessages to be preserved in conversation history.
 */
export function buildToolSet(agentConfig: BuildToolSetConfig | null | undefined): Set<string> {
  if (!agentConfig) {
    return new Set();
  }

  const { toolDefinitions, tools, historicalToolNames } = agentConfig;

  const toolNames =
    toolDefinitions && toolDefinitions.length > 0
      ? toolDefinitions.map((def) => def.name)
      : (tools ?? []).map((tool) => tool?.name);

  return new Set(
    [...toolNames, ...(historicalToolNames ?? [])].filter((name): name is string => Boolean(name)),
  );
}

export interface RunToolSetConfig extends BuildToolSetConfig, ReachableAgent<RunToolSetConfig> {
  readonly edges?: readonly GraphEdge[];
  readonly accessibleMcpServerNames?: readonly string[];
  readonly historicalMcpServerNames?: readonly string[];
}

interface HistoricalToolCallIdentity {
  name: string;
  mcpServerName?: string;
}

function collectHistoricalToolCalls(
  messages?: Iterable<unknown> | null,
): HistoricalToolCallIdentity[] {
  const calls: HistoricalToolCallIdentity[] = [];
  const addCall = (value: unknown) => {
    if (value == null || typeof value !== 'object') {
      return;
    }
    const call = value as {
      name?: unknown;
      mcpServerName?: unknown;
      function?: { name?: unknown };
      tool_call?: { name?: unknown; mcpServerName?: unknown; subagent_content?: unknown };
      subagent_content?: unknown;
    };
    const name = call.name ?? call.function?.name ?? call.tool_call?.name;
    if (typeof name === 'string') {
      const mcpServerName = call.mcpServerName ?? call.tool_call?.mcpServerName;
      calls.push({
        name,
        ...(typeof mcpServerName === 'string' ? { mcpServerName } : {}),
      });
    }
    const nested = call.tool_call?.subagent_content ?? call.subagent_content;
    if (Array.isArray(nested)) {
      nested.forEach(addCall);
    }
  };

  for (const value of messages ?? []) {
    if (value == null || typeof value !== 'object') {
      continue;
    }
    const message = value as {
      content?: unknown;
      tool_calls?: unknown;
      additional_kwargs?: { tool_calls?: unknown };
    };
    if (Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach(addCall);
    }
    if (Array.isArray(message.additional_kwargs?.tool_calls)) {
      message.additional_kwargs.tool_calls.forEach(addCall);
    }
    if (Array.isArray(message.content)) {
      message.content.forEach(addCall);
    }
  }
  return calls;
}

/** Builds the historical tool allowlist for the complete effective run topology. */
export function buildRunToolSet(
  primaryConfig: RunToolSetConfig | null | undefined,
  additionalConfigs?: Iterable<RunToolSetConfig | null | undefined> | null,
  hostGeneratedToolNames?: Iterable<string> | null,
  historicalMessages?: Iterable<unknown> | null,
  allowAmbiguousMcpToolNamesWithoutIdentity = false,
): Set<string> {
  const roots = [primaryConfig];
  if (additionalConfigs) {
    roots.push(...additionalConfigs);
  }

  const agents = collectReachableAgents(roots);
  if (agents.length === 0) {
    return new Set();
  }

  const toolSet = new Set<string>([`${Constants.SUBAGENT}`, 'conditional_transfer']);
  const wildcardServerNames = new Set<string>();
  const knownServerNames = new Set<string>();
  for (const name of hostGeneratedToolNames ?? []) {
    toolSet.add(name);
  }
  for (const agent of agents) {
    for (const rawName of [
      ...(agent.accessibleMcpServerNames ?? []),
      ...(agent.historicalMcpServerNames ?? []),
    ]) {
      knownServerNames.add(rawName);
      knownServerNames.add(normalizeServerName(rawName));
    }
    for (const name of buildToolSet(agent)) {
      toolSet.add(name);
      const wildcardPrefix = `${Constants.mcp_all}${Constants.mcp_delimiter}`;
      if (name.startsWith(wildcardPrefix)) {
        const rawServerName = name.slice(wildcardPrefix.length);
        if (rawServerName) {
          wildcardServerNames.add(normalizeServerName(rawServerName));
          knownServerNames.add(rawServerName);
          knownServerNames.add(normalizeServerName(rawServerName));
        }
      }
    }
  }

  if (wildcardServerNames.size > 0) {
    /** A wildcard authorizes every callable under one exact normalized server identity.
     * Resolve the longest known boundary so delimiter-bearing tool names remain valid
     * while a distinct longer server identity cannot masquerade as a selected suffix. */
    const boundaryNames = [...knownServerNames];
    for (const call of collectHistoricalToolCalls(historicalMessages)) {
      const { name, mcpServerName } = call;
      if (mcpServerName != null) {
        if (wildcardServerNames.has(normalizeServerName(mcpServerName))) {
          toolSet.add(name);
        }
        continue;
      }
      const [toolName, serverName] = splitMCPToolKey(name, boundaryNames);
      if (
        serverName != null &&
        toolName.length > 0 &&
        (allowAmbiguousMcpToolNamesWithoutIdentity ||
          !toolName.includes(Constants.mcp_delimiter)) &&
        wildcardServerNames.has(normalizeServerName(serverName))
      ) {
        toolSet.add(name);
      }
    }
  }

  for (const edge of primaryConfig?.edges ?? []) {
    if (edge.edgeType === 'direct') {
      continue;
    }
    const destinations = Array.isArray(edge.to) ? edge.to : [edge.to];
    for (const destination of destinations) {
      if (destination) {
        toolSet.add(`${Constants.LC_TRANSFER_TO_}${destination}`);
      }
    }
  }

  return toolSet;
}

export interface RegisterCodeExecutionToolsParams {
  toolRegistry: LCToolRegistry | undefined;
  toolDefinitions: LCTool[] | undefined;
  /**
   * When `true`, register `bash_tool` alongside `read_file`. When `false`,
   * register `read_file` only — manually-primed skills still need it to
   * load `references/*` files from storage even without a sandbox.
   *
   * Callers:
   * - `initializeAgent` passes `true` iff the `execute_code` capability
   *   is enabled for the run.
   * - `injectSkillCatalog` passes whatever `codeEnvAvailable` resolved to
   *   for the run.
   *
   * Both callers reach this helper in the same `initializeAgent` run
   * sequentially; the registry `.has()` check keeps the second call a
   * no-op so there is exactly one copy of each tool in `toolDefinitions`.
   */
  includeBash: boolean;
  /**
   * When `true`, `read_file` tells the model about skill-file paths
   * (`{skillName}/{path}`). When `false`, it is described only as a
   * code-execution sandbox reader so execute-code-only agents don't get
   * prompted to discover skills that are not enabled for the run.
   */
  includeSkillFileInstructions?: boolean;
  /**
   * When `true`, `read_file` advertises the explicit `workspace/` namespace
   * backed by the selected attached worker, including bounded line pagination.
   */
  workspaceTools?: boolean;
  /** Live operation ceiling for the selected workspace. Omitted for managed runtimes. */
  workspaceOperations?: ReadonlySet<CodeWorkspaceOperation>;
  /** Deployment ceiling advertised on attached Bash tool definitions. */
  workspaceCommandTimeoutMaxMs?: number;
  workspaceEnvironment?: CodeWorkspaceDescriptor['environment'];
  /**
   * When `true`, the registered `bash_tool` description includes the
   * LLM-facing `{{tool<idx>turn<turn>}}` reference syntax guide so the
   * model knows it can substitute prior tool outputs in subsequent
   * commands. Paired with `RunConfig.toolOutputReferences` in `createRun`.
   */
  enableToolOutputReferences?: boolean;
  /**
   * When `true`, the registered `bash_tool` description is the hedged
   * stateful-session variant (workspace usually persists across calls, may
   * reset at any time). Transport routing is resolved independently from the
   * actually executing agent at tool-load time.
   */
  statefulSessions?: boolean;
}

export interface RegisterCodeExecutionToolsResult {
  toolDefinitions: LCTool[];
  /** Tool names newly registered (skipped names that already existed). */
  registered: string[];
  /**
   * Every tool name this registration manages, whether newly registered or
   * already present. `initializeAgent` records these under the capability
   * marker that triggered the call, so a `tool_options` entry keyed by the
   * marker projects onto exactly the definitions the capability produced —
   * the registrar itself is the source of truth, not a hand-maintained map.
   */
  toolNames: string[];
}

export type RegisterFileAuthoringToolsResult = RegisterCodeExecutionToolsResult;

export interface RegisterFileAuthoringToolsParams {
  toolRegistry: LCToolRegistry | undefined;
  toolDefinitions: LCTool[] | undefined;
  /**
   * When true, descriptions point the model at the skill file namespace
   * (`skills/{skillName}/...`) in addition to sandbox paths. When false,
   * descriptions stay focused on code-execution sandbox files.
   */
  includeSkillFileInstructions?: boolean;
  /** When true, non-skill paths use the attached worker's workspace/ namespace. */
  workspaceTools?: boolean;
  /** Live operation ceiling for the selected workspace. Omitted for managed runtimes. */
  workspaceOperations?: ReadonlySet<CodeWorkspaceOperation>;
}

/**
 * Hoisted module-level definition for skill-aware `read_file` so
 * `registerCodeExecutionTools` doesn't re-allocate on every call. The
 * shape is derived from a static `@librechat/agents` export — no
 * per-request state — so a single frozen object is safe to share across
 * every agent init.
 */
const SKILL_READ_FILE_DESCRIPTION = `${ReadFileToolDefinition.description}

Also accepts authored skill file paths using "skills/{skillName}/...", including "skills/{skillName}/SKILL.md".`;

const READ_FILE_DEF: LCTool = Object.freeze({
  name: ReadFileToolDefinition.name,
  toolType: 'builtin',
  description: SKILL_READ_FILE_DESCRIPTION,
  parameters: ReadFileToolDefinition.parameters as unknown as LCTool['parameters'],
  responseFormat: ReadFileToolDefinition.responseFormat,
}) as LCTool;

const CODE_READ_FILE_DESCRIPTION = `Read a known code-sandbox file. Text is line-numbered and truncates around 256KB; png, jpeg, gif, and webp images return as visual content.

Use paths returned by tool output, just written, or under /mnt/data/. Do not run ls/find to rediscover known paths. Use bash_tool for binary or large files, transforms, metadata, and filesystem discovery.

For managed execution, only retained files under /mnt/data reach later calls. $HOME, /tmp, $TMPDIR, shell/environment state, cwd, global installs, and background processes are call-local.`;

const ATTACHED_WORKSPACE_READ_FILE_INSTRUCTIONS = `For an attached environment, read registered files as "workspace/{relativePath}". Use a canonical relative path without empty, ".", or ".." segments; the worker's host path stays private. Only the registered workspace persists for attached commands. Project dependencies stored there persist, while $HOME and global/system packages are operator-managed. Use start_line and max_lines for bounded pagination.`;

const CODE_READ_FILE_PARAMETERS: LCTool['parameters'] = Object.freeze({
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'Path to a file from code execution output, such as "/mnt/data/result.csv" or another path returned by the execution tool.',
    },
  },
  required: ['path'],
}) as LCTool['parameters'];

const ATTACHED_WORKSPACE_READ_FILE_PARAMETERS: LCTool['parameters'] = Object.freeze({
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'Use "workspace/{relativePath}" with a canonical relative path (no empty, ".", or ".." segments) for a file in the attached worker workspace directory, or a code-execution sandbox path such as "/mnt/data/result.csv".',
    },
    start_line: {
      type: 'integer',
      minimum: 1,
      description: 'Optional one-based line at which to start reading a workspace text file.',
    },
    max_lines: {
      type: 'integer',
      minimum: 1,
      maximum: 500,
      description: 'Optional maximum number of workspace text-file lines to return.',
    },
  },
  required: ['path'],
}) as LCTool['parameters'];

const CODE_READ_FILE_DEF: LCTool = Object.freeze({
  name: ReadFileToolDefinition.name,
  toolType: 'builtin',
  description: CODE_READ_FILE_DESCRIPTION,
  parameters: CODE_READ_FILE_PARAMETERS,
  responseFormat: ReadFileToolDefinition.responseFormat,
}) as LCTool;

function createAttachedWorkspaceReadFileDef(includeSkillFileInstructions: boolean): LCTool {
  const baseDescription = includeSkillFileInstructions
    ? SKILL_READ_FILE_DESCRIPTION
    : CODE_READ_FILE_DESCRIPTION;
  return Object.freeze({
    name: ReadFileToolDefinition.name,
    toolType: 'builtin',
    description: `${baseDescription}\n\n${ATTACHED_WORKSPACE_READ_FILE_INSTRUCTIONS}`,
    parameters: ATTACHED_WORKSPACE_READ_FILE_PARAMETERS,
    responseFormat: ReadFileToolDefinition.responseFormat,
  }) as LCTool;
}

const ATTACHED_CODE_READ_FILE_DEF = createAttachedWorkspaceReadFileDef(false);
const ATTACHED_SKILL_READ_FILE_DEF = createAttachedWorkspaceReadFileDef(true);

/**
 * The SDK constraint the authoring variant rewrites. Left alone it tells the
 * model that catalog names are the only legal `skillName`, which is false for a
 * run that can author skills, and worst when the catalog is empty and the only
 * reachable skill is the one the model just created.
 */
const CATALOG_ONLY_SKILL_CONSTRAINT =
  '- Skill names come from the catalog only. Do not guess names.';

const AUTHORED_SKILL_CONSTRAINTS = `- Skill names come from the catalog, or from a skill you created in this conversation with create_file at "skills/{skillName}/SKILL.md". Do not guess any other name.
- Creating a skill does not load it. Invoke it here when you want to follow its instructions.`;

const AUTHORED_SKILL_NAME_DESCRIPTION =
  'The kebab-case identifier of the skill to invoke (e.g. "financial-analyzer", "meeting-notes"). Must match a name from the "Available Skills" section, or the name of a skill you created in this conversation.';

/**
 * Rewrites in place while the SDK still ships the catalog-only constraint, so
 * every other constraint it declares survives; appends otherwise, so the
 * authored-skill guidance reaches the model even if that text moves.
 *
 * Exported for the drift tests: appending leaves a reworded catalog-only
 * sentence standing next to guidance that contradicts it, so both branches have
 * to be pinned rather than inferred. `tools.spec.ts` also asserts the real SDK
 * export still carries the sentence, which fails CI on the bump that would
 * quietly move this onto the append branch.
 */
export function buildAuthoringSkillToolDescription(baseDescription: string): string {
  return baseDescription.includes(CATALOG_ONLY_SKILL_CONSTRAINT)
    ? baseDescription.replace(CATALOG_ONLY_SKILL_CONSTRAINT, AUTHORED_SKILL_CONSTRAINTS)
    : `${baseDescription}\n${AUTHORED_SKILL_CONSTRAINTS}`;
}

/** The shape the authoring variant needs from the SDK's `skill` schema. */
interface SkillToolParametersView {
  properties?: Record<string, { description?: string } | undefined>;
}

/**
 * Retargets the SDK's `skillName` guidance at skills authored this run, leaving
 * the rest of the schema alone.
 *
 * Takes the schema rather than reading the module import so both branches are
 * reachable from a test. The property is non-optional in the SDK's types, so
 * this reads it through a widened view: an installed package can disagree with
 * the types it shipped, and this definition is built at module load, where an
 * unguarded dereference would fail the whole `packages/api` import rather than
 * one tool's wording.
 */
export function buildAuthoringSkillToolParameters(
  baseParameters: LCTool['parameters'],
): LCTool['parameters'] {
  const view = baseParameters as unknown as SkillToolParametersView;
  const skillName = view.properties?.skillName;
  if (skillName == null) {
    return baseParameters;
  }
  return {
    ...view,
    properties: {
      ...view.properties,
      skillName: { ...skillName, description: AUTHORED_SKILL_NAME_DESCRIPTION },
    },
  } as unknown as LCTool['parameters'];
}

const SKILL_TOOL_DEF: LCTool = Object.freeze({
  name: SkillToolDefinition.name,
  description: SkillToolDefinition.description,
  parameters: SkillToolDefinition.parameters as unknown as LCTool['parameters'],
}) as LCTool;

const AUTHORING_SKILL_TOOL_DEF: LCTool = Object.freeze({
  name: SkillToolDefinition.name,
  description: buildAuthoringSkillToolDescription(SkillToolDefinition.description),
  parameters: buildAuthoringSkillToolParameters(
    SkillToolDefinition.parameters as unknown as LCTool['parameters'],
  ),
}) as LCTool;

/**
 * Model-facing `skill` definition for the run. Authoring runs get the variant
 * whose guidance accepts a name the model created during the run; every other
 * run gets the SDK definition untouched.
 */
export function getSkillToolDefinition(skillAuthoringAvailable: boolean): LCTool {
  return skillAuthoringAvailable ? AUTHORING_SKILL_TOOL_DEF : SKILL_TOOL_DEF;
}

const SEARCH_WORKSPACE_TOOL_DEF: LCTool = Object.freeze({
  name: SEARCH_WORKSPACE_TOOL_NAME,
  toolType: 'builtin',
  description:
    'Search for literal text within the attached worker workspace directory. Git is not required. Respects normal ignore files, does not follow symlinks, and returns bounded path, line, column, and text matches. Use path to limit the search to a relative file or directory.',
  parameters: Object.freeze({
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Non-empty literal text to find. This is not a regular expression.',
      },
      path: {
        type: 'string',
        description:
          'Optional canonical relative file or directory within the attached workspace; do not use empty, ".", or ".." segments.',
      },
      max_results: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        description: 'Optional maximum number of matches to return. Defaults to 50.',
      },
    },
    required: ['query'],
  }) as LCTool['parameters'],
}) as LCTool;

const LIST_WORKSPACE_FILES_TOOL_DEF: LCTool = Object.freeze({
  name: LIST_WORKSPACE_FILES_TOOL_NAME,
  toolType: 'builtin',
  description:
    'List relative file paths in the attached worker workspace directory. Use this to discover files in an existing project, Git repository, or empty directory before reading or searching them. Respects normal ignore files, does not follow symlinks, and returns a bounded deterministic listing. When a result supplies an after_path continuation, pass it unchanged with the same path to fetch the next page.',
  parameters: Object.freeze({
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Optional canonical relative file or directory within the attached workspace; do not use empty, ".", or ".." segments.',
      },
      max_results: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        description: 'Optional maximum number of relative file paths to return. Defaults to 100.',
      },
      after_path: {
        type: 'string',
        description:
          'Optional canonical continuation path from the preceding truncated result. Pass it back unchanged with the same path.',
      },
    },
  }) as LCTool['parameters'],
}) as LCTool;

const SKILL_CREATE_FILE_PARAMETERS: LCTool['parameters'] = Object.freeze({
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'Path to write. Use "skills/{skillName}/..." for skill files when available, or a code-execution sandbox path such as "/mnt/data/result.txt" when code execution is enabled. For SKILL.md, the YAML frontmatter name must match {skillName}.',
    },
    content: {
      type: 'string',
      description:
        'Complete file contents. Keep a single call well under the streamed tool-argument limit (64 KB by default); build larger files incrementally with edit_file.',
    },
    overwrite: {
      type: 'boolean',
      description: 'Must be true to replace an existing file. Refuses otherwise.',
      default: false,
    },
  },
  required: ['path', 'content'],
}) as LCTool['parameters'];

const CODE_CREATE_FILE_PARAMETERS: LCTool['parameters'] = Object.freeze({
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'Path to write in the code-execution sandbox, such as "/mnt/data/result.txt". Prefer /mnt/data/{file} for files that should remain available to later sandbox calls.',
    },
    content: {
      type: 'string',
      description:
        'Complete file contents. Keep a single call well under the streamed tool-argument limit (64 KB by default); build larger files incrementally with edit_file.',
    },
    overwrite: {
      type: 'boolean',
      description: 'Must be true to replace an existing file. Refuses otherwise.',
      default: false,
    },
  },
  required: ['path', 'content'],
}) as LCTool['parameters'];

const SKILL_EDIT_FILE_PARAMETERS: LCTool['parameters'] = Object.freeze({
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'Path to edit. Use "skills/{skillName}/..." for skill files when available, or a code-execution sandbox path such as "/mnt/data/result.txt" when code execution is enabled. edit_file cannot rename skills; keep SKILL.md frontmatter name equal to {skillName}.',
    },
    old_text: {
      type: 'string',
      description: 'Exact text to find. Must match exactly one location in the file.',
    },
    new_text: {
      type: 'string',
      description: 'Replacement text.',
    },
    edits: {
      type: 'array',
      description: 'Optional batch of replacements. Each old_text must match exactly once.',
      items: {
        type: 'object',
        properties: {
          old_text: { type: 'string' },
          new_text: { type: 'string' },
        },
        required: ['old_text', 'new_text'],
      },
    },
  },
  required: ['path'],
}) as LCTool['parameters'];

const CODE_EDIT_FILE_PARAMETERS: LCTool['parameters'] = Object.freeze({
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Path to edit in the code-execution sandbox, such as "/mnt/data/result.txt".',
    },
    old_text: {
      type: 'string',
      description: 'Exact text to find. Must match exactly one location in the file.',
    },
    new_text: {
      type: 'string',
      description: 'Replacement text.',
    },
    edits: {
      type: 'array',
      description: 'Optional batch of replacements. Each old_text must match exactly once.',
      items: {
        type: 'object',
        properties: {
          old_text: { type: 'string' },
          new_text: { type: 'string' },
        },
        required: ['old_text', 'new_text'],
      },
    },
  },
  required: ['path'],
}) as LCTool['parameters'];

const SKILL_CREATE_FILE_DESCRIPTION = `Create a new file, or overwrite an existing file with explicit intent.

Use for new files and full rewrites. Requires overwrite: true to replace existing files.

Paths starting with "skills/" write skill files:
- skills/{skillName}/SKILL.md - main instructions; keep it lean with YAML frontmatter, trigger-friendly description, workflow steps, and short snippets.
- skills/{skillName}/references/{file} - long docs, schemas, examples, large templates, HTML/CSS/JS dashboards.
- skills/{skillName}/scripts/{file} - helper scripts.
- skills/{skillName}/assets/{file} - static assets.
- skills/{skillName}/templates/{file} - reusable output templates.

For SKILL.md, frontmatter name must match {skillName}; create skills/{newName}/SKILL.md to rename. Put large runnable artifacts in bundled files such as references/template.html, and have SKILL.md tell the agent when to read or reuse them.

Non-skills paths target the code-execution sandbox when enabled. Prefer /mnt/data/{file}.`;

const CODE_CREATE_FILE_DESCRIPTION = `Create a new file, or overwrite an existing file with explicit intent.

Use for new files and full rewrites where the change is larger than half the file. Requires overwrite: true to replace existing files. Refuses otherwise.

Targets code-execution sandbox paths. Prefer /mnt/data/{file} for files that should remain available to later sandbox calls.

Very long content can exceed the streamed tool-argument limit (64 KB by default) and fail the call. For large files, create the file with its first section, then extend it with edit_file.`;

const SKILL_EDIT_FILE_DESCRIPTION = `Apply targeted text replacements to an existing file.

Use for small, precise changes. Each old_text must match exactly one location. Tries exact match first; falls back to whitespace-tolerant matching if needed. Reports which matching strategy was used. Returns a unified diff.

For skills/{skillName}/SKILL.md, edit description, title, or body content, but keep YAML frontmatter name equal to {skillName}. edit_file cannot rename skills; create a new skills/{newName}/SKILL.md for a different skill name. Keep SKILL.md concise; move large templates, HTML/CSS/JS dashboards, examples, schemas, and long docs into references/, scripts/, assets/, or templates/ files and point to them from SKILL.md.

Paths starting with "skills/" target the skill file system. When code execution is enabled, non-skills paths target the code-execution sandbox.`;

const CODE_EDIT_FILE_DESCRIPTION = `Apply targeted text replacements to an existing file.

Use for small, precise changes. Each old_text must match exactly one location. Tries exact match first; falls back to whitespace-tolerant matching if needed. Reports which matching strategy was used. Returns a unified diff.

Targets code-execution sandbox paths, such as /mnt/data/result.txt.`;

const SKILL_CREATE_FILE_DEF: LCTool = Object.freeze({
  name: CREATE_FILE_TOOL_NAME,
  toolType: 'builtin',
  description: SKILL_CREATE_FILE_DESCRIPTION,
  parameters: SKILL_CREATE_FILE_PARAMETERS,
  responseFormat: 'content_and_artifact' as LCTool['responseFormat'],
}) as LCTool;

const CODE_CREATE_FILE_DEF: LCTool = Object.freeze({
  name: CREATE_FILE_TOOL_NAME,
  toolType: 'builtin',
  description: CODE_CREATE_FILE_DESCRIPTION,
  parameters: CODE_CREATE_FILE_PARAMETERS,
  responseFormat: 'content_and_artifact' as LCTool['responseFormat'],
}) as LCTool;

const SKILL_EDIT_FILE_DEF: LCTool = Object.freeze({
  name: EDIT_FILE_TOOL_NAME,
  toolType: 'builtin',
  description: SKILL_EDIT_FILE_DESCRIPTION,
  parameters: SKILL_EDIT_FILE_PARAMETERS,
  responseFormat: 'content_and_artifact' as LCTool['responseFormat'],
}) as LCTool;

const CODE_EDIT_FILE_DEF: LCTool = Object.freeze({
  name: EDIT_FILE_TOOL_NAME,
  toolType: 'builtin',
  description: CODE_EDIT_FILE_DESCRIPTION,
  parameters: CODE_EDIT_FILE_PARAMETERS,
  responseFormat: 'content_and_artifact' as LCTool['responseFormat'],
}) as LCTool;

const ATTACHED_CODE_CREATE_FILE_DESCRIPTION = `Create a new file in the selected attached environment, or overwrite one with explicit intent.

Use a path in the form "workspace/{relativePath}". Requires overwrite: true to replace an existing file and refuses otherwise. The workspace may be an existing project, a Git repository, or an empty directory.

Very long content can exceed the streamed tool-argument limit (64 KB by default). The attached workspace also limits each write to 1 MiB. Keep each call bounded.`;

const ATTACHED_CODE_EDIT_FILE_DESCRIPTION = `Apply one or more ordered exact text replacements to an existing file in the selected attached environment.

Use a path in the form "workspace/{relativePath}". Every old_text must match exactly one location at its step in the batch. Up to 100 replacements and 1 MiB of edit text are allowed; the entire batch commits atomically or makes no change.`;

const ATTACHED_SKILL_CREATE_FILE_DESCRIPTION = `${SKILL_CREATE_FILE_DESCRIPTION.replace(
  'Non-skills paths target the code-execution sandbox when enabled. Prefer /mnt/data/{file}.',
  'For the selected attached environment, non-skill paths must use "workspace/{relativePath}".',
)}`;

const ATTACHED_SKILL_EDIT_FILE_DESCRIPTION = `Apply targeted text replacements to an existing file.

For skills/{skillName}/... paths, exact matching falls back to whitespace-tolerant matching when needed and the result includes a unified diff. Keep SKILL.md YAML frontmatter name equal to {skillName}; create a new skills/{newName}/SKILL.md to rename a skill.

For workspace/{relativePath} paths in the selected attached environment, every old_text must match exactly one location at its step. There is no whitespace-tolerant fallback. Up to 100 replacements and 1 MiB of edit text commit atomically, and the result is a write summary rather than a unified diff.`;

function attachedFileAuthoringParameters(
  parameters: LCTool['parameters'],
  includeSkillFileInstructions: boolean,
): LCTool['parameters'] {
  const properties = parameters?.properties ?? {};
  return Object.freeze({
    ...parameters,
    properties: {
      ...properties,
      path: {
        type: 'string',
        description: includeSkillFileInstructions
          ? 'Use "skills/{skillName}/..." for a LibreChat skill file, or "workspace/{relativePath}" for a file in the selected attached environment.'
          : 'Use "workspace/{relativePath}" for a file in the selected attached environment.',
      },
    },
  }) as LCTool['parameters'];
}

const ATTACHED_CODE_CREATE_FILE_DEF: LCTool = Object.freeze({
  ...CODE_CREATE_FILE_DEF,
  description: ATTACHED_CODE_CREATE_FILE_DESCRIPTION,
  parameters: attachedFileAuthoringParameters(CODE_CREATE_FILE_PARAMETERS, false),
}) as LCTool;

const ATTACHED_CODE_EDIT_FILE_DEF: LCTool = Object.freeze({
  ...CODE_EDIT_FILE_DEF,
  description: ATTACHED_CODE_EDIT_FILE_DESCRIPTION,
  parameters: attachedFileAuthoringParameters(CODE_EDIT_FILE_PARAMETERS, false),
}) as LCTool;

const ATTACHED_SKILL_CREATE_FILE_DEF: LCTool = Object.freeze({
  ...SKILL_CREATE_FILE_DEF,
  description: ATTACHED_SKILL_CREATE_FILE_DESCRIPTION,
  parameters: attachedFileAuthoringParameters(SKILL_CREATE_FILE_PARAMETERS, true),
}) as LCTool;

const ATTACHED_SKILL_EDIT_FILE_DEF: LCTool = Object.freeze({
  ...SKILL_EDIT_FILE_DEF,
  description: ATTACHED_SKILL_EDIT_FILE_DESCRIPTION,
  parameters: attachedFileAuthoringParameters(SKILL_EDIT_FILE_PARAMETERS, true),
}) as LCTool;

function buildReadFileDef(includeSkillFileInstructions: boolean, workspaceTools: boolean): LCTool {
  if (workspaceTools) {
    return includeSkillFileInstructions
      ? ATTACHED_SKILL_READ_FILE_DEF
      : ATTACHED_CODE_READ_FILE_DEF;
  }
  return includeSkillFileInstructions ? READ_FILE_DEF : CODE_READ_FILE_DEF;
}

function buildFileAuthoringDefs(
  includeSkillFileInstructions: boolean,
  workspaceTools: boolean,
): LCTool[] {
  if (workspaceTools) {
    return includeSkillFileInstructions
      ? [ATTACHED_SKILL_CREATE_FILE_DEF, ATTACHED_SKILL_EDIT_FILE_DEF]
      : [ATTACHED_CODE_CREATE_FILE_DEF, ATTACHED_CODE_EDIT_FILE_DEF];
  }
  return includeSkillFileInstructions
    ? [SKILL_CREATE_FILE_DEF, SKILL_EDIT_FILE_DEF]
    : [CODE_CREATE_FILE_DEF, CODE_EDIT_FILE_DEF];
}

function isCodeOnlyReadFileDef(def: LCTool | undefined): boolean {
  return (
    def?.name === ReadFileToolDefinition.name &&
    (def?.description === CODE_READ_FILE_DESCRIPTION ||
      def?.description === ATTACHED_CODE_READ_FILE_DEF.description)
  );
}

function isCodeOnlyFileAuthoringDef(def: LCTool | undefined): boolean {
  if (def?.name === CREATE_FILE_TOOL_NAME) {
    return (
      def.description === CODE_CREATE_FILE_DESCRIPTION ||
      def.description === ATTACHED_CODE_CREATE_FILE_DESCRIPTION
    );
  }
  if (def?.name === EDIT_FILE_TOOL_NAME) {
    return (
      def.description === CODE_EDIT_FILE_DESCRIPTION ||
      def.description === ATTACHED_CODE_EDIT_FILE_DESCRIPTION
    );
  }
  return false;
}

export function isFileAuthoringToolDefinition(def: LCTool | undefined): boolean {
  if (def?.name === CREATE_FILE_TOOL_NAME) {
    return (
      def.description === CODE_CREATE_FILE_DESCRIPTION ||
      def.description === SKILL_CREATE_FILE_DESCRIPTION ||
      def.description === ATTACHED_CODE_CREATE_FILE_DESCRIPTION ||
      def.description === ATTACHED_SKILL_CREATE_FILE_DESCRIPTION
    );
  }
  if (def?.name === EDIT_FILE_TOOL_NAME) {
    return (
      def.description === CODE_EDIT_FILE_DESCRIPTION ||
      def.description === SKILL_EDIT_FILE_DESCRIPTION ||
      def.description === ATTACHED_CODE_EDIT_FILE_DESCRIPTION ||
      def.description === ATTACHED_SKILL_EDIT_FILE_DESCRIPTION
    );
  }
  return false;
}

/**
 * The `bash_tool` description varies along exactly one axis — whether
 * the LLM-facing `{{tool<idx>turn<turn>}}` reference syntax guide is
 * appended — so two frozen module-level singletons cover every call
 * site. Both are shaped identically to the legacy `BASH_TOOL_DEF`
 * constant; only `description` differs. Sharing references across
 * every agent init avoids per-call `Object.freeze` + SDK
 * `buildBashExecutionToolDescription` work, matching the no-allocation
 * intent of the original constant while keeping the per-agent gate
 * behavior introduced for tool-output references.
 */
function createBashToolDef(
  enableToolOutputReferences: boolean,
  statefulSessions = false,
  workspaceTools = false,
  workspaceCommandTimeoutMaxMs?: number,
  workspaceEnvironment?: CodeWorkspaceDescriptor['environment'],
): LCTool {
  /* Passed as a variable (not an inline literal) so the extra
   * `statefulSessions` key stays assignable against pinned SDK versions
   * whose builder predates it (ignored at runtime there). */
  const descriptionOpts = { enableToolOutputReferences, statefulSessions };
  return Object.freeze({
    name: BashExecutionToolDefinition.name,
    toolType: 'builtin',
    description: workspaceTools
      ? buildAttachedWorkspaceBashDescription(enableToolOutputReferences, workspaceEnvironment)
      : buildBashExecutionToolDescription(descriptionOpts),
    parameters: (workspaceTools
      ? buildAttachedWorkspaceBashSchema(workspaceCommandTimeoutMaxMs, workspaceEnvironment)
      : BashExecutionToolDefinition.schema) as unknown as LCTool['parameters'],
  }) as LCTool;
}

const BASH_TOOL_DEF_WITH_OUTPUT_REFS = createBashToolDef(true);
const BASH_TOOL_DEF_WITHOUT_OUTPUT_REFS = createBashToolDef(false);

function buildBashToolDef(opts: {
  enableToolOutputReferences: boolean;
  statefulSessions?: boolean;
  workspaceTools?: boolean;
  workspaceCommandTimeoutMaxMs?: number;
  workspaceEnvironment?: CodeWorkspaceDescriptor['environment'];
}): LCTool {
  /* Stateful defs are built on demand: the stateless pair covers the
   * default path, and per-run construction is negligible next to init. */
  if (opts.statefulSessions === true || opts.workspaceTools === true) {
    return createBashToolDef(
      opts.enableToolOutputReferences,
      opts.statefulSessions === true,
      opts.workspaceTools === true,
      opts.workspaceCommandTimeoutMaxMs,
      opts.workspaceEnvironment,
    );
  }
  return opts.enableToolOutputReferences
    ? BASH_TOOL_DEF_WITH_OUTPUT_REFS
    : BASH_TOOL_DEF_WITHOUT_OUTPUT_REFS;
}

/**
 * Idempotently registers the code-execution tool pair (`bash_tool` +
 * `read_file`) into the run's tool registry and tool-definition list.
 * `read_file` can be registered with a code-only description first and
 * upgraded to the skill-aware description later in the same run if
 * skills are actually injected.
 *
 * Replaces the legacy `CodeExecutionToolDefinition` / `execute_code`
 * registration. `execute_code` as a capability name and as an
 * `agent.tools` entry is preserved — it just expands into this tool
 * pair at load time so there is only one code-execution tool path
 * end-to-end (no same-run dedupe surprises for agents with both
 * `execute_code` capability AND skills active).
 */
export function registerCodeExecutionTools(
  params: RegisterCodeExecutionToolsParams,
): RegisterCodeExecutionToolsResult {
  const {
    toolRegistry,
    toolDefinitions,
    includeBash,
    includeSkillFileInstructions = true,
    workspaceTools = false,
    workspaceOperations,
    workspaceCommandTimeoutMaxMs,
    workspaceEnvironment,
    enableToolOutputReferences = false,
    statefulSessions = false,
  } = params;

  const supportsWorkspaceOperation = (operation: CodeWorkspaceOperation): boolean =>
    !workspaceTools || workspaceOperations?.has(operation) === true;
  const candidates: LCTool[] = [];
  if (!workspaceTools || supportsWorkspaceOperation('read_file')) {
    candidates.push(buildReadFileDef(includeSkillFileInstructions, workspaceTools));
  } else if (includeSkillFileInstructions) {
    candidates.push(buildReadFileDef(true, false));
  }
  if (includeBash && supportsWorkspaceOperation('execute_command')) {
    candidates.push(
      buildBashToolDef({
        enableToolOutputReferences,
        statefulSessions,
        workspaceTools,
        workspaceCommandTimeoutMaxMs,
        workspaceEnvironment,
      }),
    );
  }
  if (workspaceTools && supportsWorkspaceOperation('search_text')) {
    candidates.push(SEARCH_WORKSPACE_TOOL_DEF);
  }
  if (workspaceTools && supportsWorkspaceOperation('list_files')) {
    candidates.push(LIST_WORKSPACE_FILES_TOOL_DEF);
  }
  const toolNames = candidates.map((def) => def.name);

  const inputDefinitions = toolDefinitions ?? [];
  let workingDefinitions = inputDefinitions;

  const registered: string[] = [];
  const newDefs: LCTool[] = [];
  for (const def of candidates) {
    const existingIndex = workingDefinitions.findIndex((d) => d.name === def.name);
    const existingDef = existingIndex >= 0 ? workingDefinitions[existingIndex] : undefined;
    const registryDef = toolRegistry?.get(def.name);
    if (
      def.name === ReadFileToolDefinition.name &&
      includeSkillFileInstructions &&
      (isCodeOnlyReadFileDef(existingDef) || isCodeOnlyReadFileDef(registryDef))
    ) {
      if (isCodeOnlyReadFileDef(existingDef)) {
        workingDefinitions =
          workingDefinitions === inputDefinitions ? [...inputDefinitions] : workingDefinitions;
        workingDefinitions[existingIndex] = def;
      }
      if (isCodeOnlyReadFileDef(registryDef)) {
        toolRegistry?.set(def.name, def);
      }
      continue;
    }

    const inRegistry = toolRegistry?.has(def.name) === true;
    const inDefs = existingIndex >= 0;
    if (inRegistry || inDefs) {
      continue;
    }
    toolRegistry?.set(def.name, def);
    newDefs.push(def);
    registered.push(def.name);
  }

  /**
   * Skip the array spread on the common second-call path when no tools were
   * newly registered. Returns the input array by reference unless an existing
   * code-only `read_file` definition was upgraded above.
   */
  if (newDefs.length === 0) {
    return { toolDefinitions: workingDefinitions, registered, toolNames };
  }
  return {
    toolDefinitions: [...workingDefinitions, ...newDefs],
    registered,
    toolNames,
  };
}

export function registerFileAuthoringTools(
  params: RegisterFileAuthoringToolsParams,
): RegisterFileAuthoringToolsResult {
  const {
    toolRegistry,
    toolDefinitions,
    includeSkillFileInstructions = true,
    workspaceTools = false,
    workspaceOperations,
  } = params;

  const supportsWorkspaceOperation = (operation: CodeWorkspaceOperation): boolean =>
    !workspaceTools || workspaceOperations?.has(operation) === true;
  let candidates = buildFileAuthoringDefs(includeSkillFileInstructions, false);
  if (workspaceTools) {
    candidates = [];
    if (includeSkillFileInstructions) {
      candidates.push(
        supportsWorkspaceOperation('write_file')
          ? ATTACHED_SKILL_CREATE_FILE_DEF
          : SKILL_CREATE_FILE_DEF,
        supportsWorkspaceOperation('edit_file')
          ? ATTACHED_SKILL_EDIT_FILE_DEF
          : SKILL_EDIT_FILE_DEF,
      );
    } else {
      if (supportsWorkspaceOperation('write_file')) candidates.push(ATTACHED_CODE_CREATE_FILE_DEF);
      if (supportsWorkspaceOperation('edit_file')) candidates.push(ATTACHED_CODE_EDIT_FILE_DEF);
    }
  }
  const toolNames = candidates.map((def) => def.name);
  const inputDefinitions = toolDefinitions ?? [];
  let workingDefinitions = inputDefinitions;

  const registered: string[] = [];
  const newDefs: LCTool[] = [];
  for (const def of candidates) {
    const existingIndex = workingDefinitions.findIndex((d) => d.name === def.name);
    const existingDef = existingIndex >= 0 ? workingDefinitions[existingIndex] : undefined;
    const registryDef = toolRegistry?.get(def.name);

    if (
      includeSkillFileInstructions &&
      (isCodeOnlyFileAuthoringDef(existingDef) || isCodeOnlyFileAuthoringDef(registryDef))
    ) {
      if (isCodeOnlyFileAuthoringDef(existingDef)) {
        workingDefinitions =
          workingDefinitions === inputDefinitions ? [...inputDefinitions] : workingDefinitions;
        workingDefinitions[existingIndex] = def;
      }
      if (isCodeOnlyFileAuthoringDef(registryDef)) {
        toolRegistry?.set(def.name, def);
      }
      continue;
    }

    const inRegistry = toolRegistry?.has(def.name) === true;
    const inDefs = existingIndex >= 0;
    if (inRegistry || inDefs) {
      continue;
    }

    toolRegistry?.set(def.name, def);
    newDefs.push(def);
    registered.push(def.name);
  }

  if (newDefs.length === 0) {
    return { toolDefinitions: workingDefinitions, registered, toolNames };
  }
  return {
    toolDefinitions: [...workingDefinitions, ...newDefs],
    registered,
    toolNames,
  };
}
