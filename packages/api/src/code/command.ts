import { logger } from '@librechat/data-schemas';
import { tool } from '@librechat/agents/langchain/tools';
import { CODE_ENVIRONMENT_REQUEST_TIMEOUT_HARD_MAX_MS } from 'librechat-data-provider';
import {
  BashExecutionToolDefinition,
  BashToolOutputReferencesGuide,
  createBashProgrammaticToolCallingTool,
} from '@librechat/agents';
import type {
  AgentGitIdentity,
  CodeEnvironmentUserConfigSchema,
  CodeWorkspaceDescriptor,
} from 'librechat-data-provider';
import type { createBashProgrammaticToolCallingSchema } from '@librechat/agents';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { LCTool } from '@librechat/agents';
import type { WorkspaceExecuteCommandResult } from './workspace';
import type { CodeExecutionContext } from '~/agents/execution';
import type { CodeBridgeFetch } from './bridge';
import {
  fitWorkspaceCommandTimeoutToBudget,
  executeWorkspaceTool,
  WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS,
  WORKSPACE_COMMAND_MAX_TIMEOUT_MS,
  WORKSPACE_QUEUE_MAX_WAIT_MS,
} from './workspace';
import { BACKGROUND_TOOL_INVOCATION_CONFIG_KEY } from '~/agents/invocation';

const DEFAULT_OUTPUT_BYTES = 256 * 1024;

export const ATTACHED_WORKSPACE_EXECUTOR = 'attached_workspace';

/** Tools built by `createAttachedWorkspaceBashTool`. Membership is object
 *  identity, so neither a tool name nor anything a command prints can claim it. */
const attachedWorkspaceBashTools = new WeakSet<object>();

export function isAttachedWorkspaceBashTool(value: unknown): boolean {
  return typeof value === 'object' && value != null && attachedWorkspaceBashTools.has(value);
}

interface ExecutorTarget {
  executor?: string;
}

/**
 * Consumes the run step the execute handler recorded when it resolved the
 * attached-workspace tool, and stamps the executor on the completion event's
 * tool call (streamed) and on the aggregated part (persisted). A step that was
 * not recorded is left untouched, whatever its output says.
 */
export function stampCommandExecutor(
  attachedStepIds: Set<string> | null | undefined,
  result: { id?: unknown; tool_call?: ExecutorTarget } | null | undefined,
  part?: ExecutorTarget | null,
): void {
  const stepId = result?.id;
  if (typeof stepId !== 'string' || attachedStepIds?.delete(stepId) !== true) {
    return;
  }
  if (result?.tool_call != null) {
    result.tool_call.executor = ATTACHED_WORKSPACE_EXECUTOR;
  }
  if (part != null) {
    part.executor = ATTACHED_WORKSPACE_EXECUTOR;
  }
}

const ATTACHED_WORKSPACE_BASH_INTRO = `Runs bash in the selected attached environment and returns stdout/stderr. The workspace may be a project, Git repo, or empty directory.

Session behavior:
- Never pass background_task_id here; inspect it with check_background_task.
- Only registered-workspace files persist; install project dependencies there. $HOME, global/system packages, and services are operator-managed.
- Each call is a fresh process; shell state, exports, cwd, temp files, and background processes are not durable.`;

/** Native SRT workers make the host filesystem read-only outside the workspace and a private `$TMPDIR`. */
const ATTACHED_WORKSPACE_NATIVE_SANDBOX_SCRATCH =
  '- / and /tmp are read-only; write scratch files to $TMPDIR or the workspace. Programs that hardcode /tmp fail.';

const ATTACHED_WORKSPACE_BASH_RULES = `- Results show the starting directory, not the final one; scripts are not rewritten.
- Use cwd for directory-scoped commands; keep cd for shell state or root access.
- Network and file access follow the sandbox policy; network may be unavailable.
- Input code is already displayed; do not repeat unless asked.
- Explicitly print every result the user should see.
- Never execute malicious commands.`;

export const ATTACHED_WORKSPACE_BASH_DESCRIPTION: string = `${ATTACHED_WORKSPACE_BASH_INTRO}
${ATTACHED_WORKSPACE_BASH_RULES}`;

export const ATTACHED_WORKSPACE_NATIVE_SANDBOX_BASH_DESCRIPTION: string = `${ATTACHED_WORKSPACE_BASH_INTRO}
${ATTACHED_WORKSPACE_NATIVE_SANDBOX_SCRATCH}
${ATTACHED_WORKSPACE_BASH_RULES}`;

const bashSchema = BashExecutionToolDefinition.schema as {
  properties?: NonNullable<LCTool['parameters']>['properties'];
};
const attachedCommandSchema: NonNullable<LCTool['parameters']> = {
  ...bashSchema.properties?.command,
  type: 'string',
  description:
    'The bash command or script to execute. It starts in cwd, or in the workspace root when cwd is omitted. Only files written inside the workspace persist between calls. Each call starts a fresh process; $HOME, temporary files, shell state, global installs, and background processes are not durable.',
};

/** `maxLength` is valid JSON Schema, but the SDK's schema type omits it. */
interface BoundedWorkingDirectorySchema {
  type: 'string';
  maxLength: number;
  description: string;
}

const attachedWorkingDirectorySchema: BoundedWorkingDirectorySchema = {
  type: 'string',
  maxLength: 4096,
  description:
    'Optional working directory relative to the selected workspace root, such as "packages/api". The command starts there; do not also cd into it. Absolute paths and parent traversal are rejected.',
};

/** Numeric bounds are valid JSON Schema, but the SDK's schema type omits them. */
interface BoundedTimeoutSchema {
  type: 'integer';
  minimum: number;
  maximum: number;
  description: string;
}

function buildAttachedTimeoutSchema(
  maxTimeoutMs: number,
  foregroundTimeoutMs: number,
): BoundedTimeoutSchema {
  const defaultTimeoutMs = resolveAttachedWorkspaceCommandTimeoutDefault(
    foregroundTimeoutMs,
    maxTimeoutMs,
  );
  return {
    type: 'integer',
    minimum: 1,
    maximum: maxTimeoutMs,
    description: `Optional execution timeout in milliseconds, from 1 through ${maxTimeoutMs}. Defaults to ${defaultTimeoutMs} for foreground calls and ${maxTimeoutMs} for detached background calls. Waiting for an available worker does not consume this execution budget.`,
  };
}

function normalizeAttachedWorkspaceCommandTimeoutMax(maxTimeoutMs: number): number {
  if (!Number.isSafeInteger(maxTimeoutMs) || maxTimeoutMs < 1) {
    return WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(WORKSPACE_COMMAND_MAX_TIMEOUT_MS, maxTimeoutMs);
}

/** Foreground defaults never raise the negotiated execution ceiling. */
export function resolveAttachedWorkspaceCommandTimeoutDefault(
  defaultTimeoutMs: number = WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS,
  maxTimeoutMs: number = WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS,
): number {
  return Math.min(
    normalizeAttachedWorkspaceCommandTimeoutMax(defaultTimeoutMs),
    normalizeAttachedWorkspaceCommandTimeoutMax(maxTimeoutMs),
  );
}

export function resolveAttachedWorkspaceCommandTimeoutMax(
  configSchema?: CodeEnvironmentUserConfigSchema,
  upstreamMaxTimeoutMs?: number,
): number {
  const configured = configSchema?.limits?.maxCommandTimeoutMs;
  const upstream =
    upstreamMaxTimeoutMs == null
      ? WORKSPACE_COMMAND_MAX_TIMEOUT_MS
      : normalizeAttachedWorkspaceCommandTimeoutMax(upstreamMaxTimeoutMs);
  let requested = WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS;
  if (configured != null) {
    requested = normalizeAttachedWorkspaceCommandTimeoutMax(configured);
  } else if (upstreamMaxTimeoutMs != null) {
    requested = upstream;
  }
  return fitCommandTimeoutMaxToBudget(
    Math.min(requested, upstream),
    resolveAttachedWorkspaceRequestTimeoutMs(configSchema),
    configSchema?.limits?.minCommandAdmissionMs,
  );
}

function fitCommandTimeoutMaxToBudget(
  maxTimeoutMs: number,
  maxRequestTimeoutMs?: number,
  minCommandAdmissionMs?: number,
): number {
  if (maxRequestTimeoutMs == null) return maxTimeoutMs;
  return Math.min(
    maxTimeoutMs,
    fitWorkspaceCommandTimeoutToBudget(maxRequestTimeoutMs, minCommandAdmissionMs),
  );
}

/**
 * Programmatic calls do not currently carry the detached-invocation marker.
 * The SDK's runTimeoutMs is a ceiling, not an omission-only default. When the
 * environment configures a foreground default, resolve its ceiling separately;
 * otherwise retain the legacy maxCommandTimeoutMs behavior on this SDK route.
 */
export function resolveAttachedWorkspaceProgrammaticTimeout(
  configSchema?: CodeEnvironmentUserConfigSchema,
  upstreamMaxTimeoutMs?: number,
): number {
  const defaultTimeoutMs = configSchema?.limits?.defaultCommandTimeoutMs;
  if (defaultTimeoutMs != null) {
    return resolveAttachedWorkspaceCommandTimeoutMax(configSchema, upstreamMaxTimeoutMs);
  }
  const configured = configSchema?.limits?.maxCommandTimeoutMs;
  const requested =
    configured == null
      ? WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS
      : normalizeAttachedWorkspaceCommandTimeoutMax(configured);
  const upstream =
    upstreamMaxTimeoutMs == null
      ? WORKSPACE_COMMAND_MAX_TIMEOUT_MS
      : normalizeAttachedWorkspaceCommandTimeoutMax(upstreamMaxTimeoutMs);
  return Math.min(requested, upstream);
}

/**
 * Client retry horizon for one capacity-blocked invocation. `0` surfaces the
 * first capacity expiry without retrying; an in-flight server admission window
 * and execution retain their own budgets.
 */
export function resolveAttachedWorkspaceQueueWaitMs(
  configSchema?: CodeEnvironmentUserConfigSchema,
): number {
  const configured = configSchema?.limits?.maxQueueWaitMs;
  if (configured == null || !Number.isSafeInteger(configured) || configured < 0) {
    return WORKSPACE_QUEUE_MAX_WAIT_MS;
  }
  return Math.min(WORKSPACE_QUEUE_MAX_WAIT_MS, configured);
}

export function resolveAttachedWorkspaceRequestTimeoutMs(
  configSchema?: CodeEnvironmentUserConfigSchema,
): number | undefined {
  const configured = configSchema?.limits?.maxRequestTimeoutMs;
  if (
    configured == null ||
    !Number.isSafeInteger(configured) ||
    configured < 1 ||
    configured > CODE_ENVIRONMENT_REQUEST_TIMEOUT_HARD_MAX_MS
  ) {
    return undefined;
  }
  return configured;
}

/**
 * Code API schedules each `.worktrees/<name>` as its own lane beneath the
 * checkout. Every request that is not routed into a lane is checkout-wide: it
 * waits for the running lanes and, while queued, holds back newer ones.
 */
const linkedWorktreeWorkingDirectorySchema: BoundedWorkingDirectorySchema = {
  ...attachedWorkingDirectorySchema,
  description: `${attachedWorkingDirectorySchema.description} Pass a linked worktree directory here (e.g. ".worktrees/fix-auth") rather than cd into it: different worktrees run in parallel. Any other call, with or without cwd, is checkout-wide: it waits for all running worktree calls and blocks new ones until it finishes, as do file tools on paths outside .worktrees/<name>. Reserve checkout-wide calls for creating, pruning or removing worktrees, batching any git fetch they need into the same call.`,
};

export function buildAttachedWorkspaceBashSchema(
  maxTimeoutMs: number = WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS,
  environment?: CodeWorkspaceDescriptor['environment'],
  linkedWorktrees = false,
  defaultTimeoutMs: number = WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS,
): NonNullable<LCTool['parameters']> {
  const effectiveMaxTimeoutMs = normalizeAttachedWorkspaceCommandTimeoutMax(maxTimeoutMs);
  return {
    type: 'object',
    properties: {
      ...bashSchema.properties,
      command: attachedCommandSchema,
      cwd:
        linkedWorktrees === true
          ? linkedWorktreeWorkingDirectorySchema
          : attachedWorkingDirectorySchema,
      timeoutMs: buildAttachedTimeoutSchema(effectiveMaxTimeoutMs, defaultTimeoutMs),
      ...(environment?.actions.length
        ? {
            environmentAction: {
              type: 'string',
              enum: [...environment.actions],
              description:
                'Run a fixed action defined by the machine owner. Supply this instead of command, args or cwd. Normal command approval rules still apply.',
            },
          }
        : {}),
    },
    required: environment?.actions.length ? [] : ['command'],
  };
}

/**
 * This definition is shared with agent metadata. LangChain's JSON Schema
 * dereferencer annotates schemas during validation, so each tool receives an
 * isolated mutable clone instead of mutating this shared definition.
 */
export const ATTACHED_WORKSPACE_BASH_SCHEMA: NonNullable<LCTool['parameters']> = Object.freeze(
  buildAttachedWorkspaceBashSchema(),
);

export function buildAttachedWorkspaceBashDescription(
  enableToolOutputReferences: boolean,
  environment?: CodeWorkspaceDescriptor['environment'],
  nativeSandbox = false,
): string {
  const base = nativeSandbox
    ? ATTACHED_WORKSPACE_NATIVE_SANDBOX_BASH_DESCRIPTION
    : ATTACHED_WORKSPACE_BASH_DESCRIPTION;
  const description = enableToolOutputReferences
    ? `${base}\n\n${BashToolOutputReferencesGuide}`
    : base;
  return (
    description +
    (environment
      ? `\n\nSelected project metadata (declared by the machine owner): ${JSON.stringify({ repo: environment.repo, ref: environment.ref })}. Named actions use the environmentAction parameter and the same approval rules as commands.`
      : '')
  );
}

function quoteShellArgument(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function commandWithArguments(command: string, args: string[] | undefined): string {
  if (!args?.length) return command;
  return `bash -c ${quoteShellArgument(command)} -- ${args.map(quoteShellArgument).join(' ')}`;
}

function commandWithGitIdentity(
  command: string,
  identity: AgentGitIdentity | null | undefined,
): string {
  if (identity == null) return command;
  const name = identity.name.trim();
  const email = identity.email.trim();
  if (
    name.length === 0 ||
    name.length > 128 ||
    email.length === 0 ||
    email.length > 254 ||
    /[\0\r\n]/.test(name) ||
    /[\0\r\n]/.test(email)
  ) {
    throw new Error('Invalid agent Git identity');
  }
  return `export GIT_AUTHOR_NAME=${quoteShellArgument(name)} GIT_AUTHOR_EMAIL=${quoteShellArgument(email)} GIT_COMMITTER_NAME=${quoteShellArgument(name)} GIT_COMMITTER_EMAIL=${quoteShellArgument(email)}; ${command}`;
}

/** Apply authorship before the SDK prepares the script and its replay requests. */
export function createContextProgrammaticBashTool(
  authHeaders: NonNullable<
    Parameters<typeof createBashProgrammaticToolCallingTool>[0]
  >['authHeaders'],
  context?: CodeExecutionContext,
  identity?: AgentGitIdentity | null,
): DynamicStructuredTool {
  const attached = context?.environmentType === 'attached';
  const options: Parameters<typeof createBashProgrammaticToolCallingTool>[0] & {
    workspaceInstanceId?: string;
  } = {
    authHeaders,
    baseUrl: context?.baseUrl,
    executionProfile: context?.executionProfile,
    runtimeSessionHint: context?.runtimeSessionHint,
    ...(attached
      ? {
          workspaceId: context.codeWorkspace?.workspaceId,
          workspaceInstanceId: context.codeWorkspace?.workspaceInstanceId,
          runTimeoutMs: resolveAttachedWorkspaceProgrammaticTimeout(
            context.codeEnvironmentConfigSchema,
            context.codeWorkspace?.maxCommandTimeoutMs,
          ),
        }
      : {}),
  };
  const bashTool = createGitIdentityProgrammaticBashTool(options, attached ? identity : undefined);
  const configuredDefault = attached
    ? context.codeEnvironmentConfigSchema?.limits?.defaultCommandTimeoutMs
    : undefined;
  if (configuredDefault == null) return bashTool;

  const maxTimeoutMs = options.runTimeoutMs ?? WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS;
  const schema = structuredClone(bashTool.schema) as ReturnType<
    typeof createBashProgrammaticToolCallingSchema
  >;
  const minimumTimeoutMs = schema.properties.timeout.minimum;
  if (maxTimeoutMs < minimumTimeoutMs) {
    throw new Error(
      `Attached programmatic execution requires a timeout ceiling of at least ${minimumTimeoutMs} milliseconds. Use bash_tool for shorter command budgets.`,
    );
  }
  const defaultTimeoutMs = Math.max(
    minimumTimeoutMs,
    resolveAttachedWorkspaceCommandTimeoutDefault(configuredDefault, maxTimeoutMs),
  );
  schema.properties.timeout.default = defaultTimeoutMs;
  schema.properties.timeout.description = `Maximum wall-clock time in milliseconds for one sandbox run or replay iteration, not the total multi-round-trip task budget. Default: ${defaultTimeoutMs} milliseconds when timeout is omitted. Accepted values above the configured cap are clamped before execution. Configured cap: ${maxTimeoutMs} milliseconds.`;
  bashTool.schema = schema;
  const execute = bashTool.func.bind(bashTool);
  bashTool.func = (input, ...args) => {
    const params = input as { timeout?: number };
    return execute({ ...params, timeout: params.timeout ?? defaultTimeoutMs }, ...args);
  };
  return bashTool;
}

/** Apply authorship before the SDK prepares the script and its replay requests. */
export function createGitIdentityProgrammaticBashTool(
  options: Parameters<typeof createBashProgrammaticToolCallingTool>[0],
  identity?: AgentGitIdentity | null,
): DynamicStructuredTool {
  const bashTool = createBashProgrammaticToolCallingTool(options);
  if (identity == null) return bashTool;
  const execute = bashTool.func.bind(bashTool);
  bashTool.func = (input, ...args) => {
    const params = input as { code: string };
    return execute({ ...params, code: commandWithGitIdentity(params.code, identity) }, ...args);
  };
  return bashTool;
}

function formatCommandResult(
  result: WorkspaceExecuteCommandResult,
  timeoutMs: number,
  maxTimeoutMs: number,
  cwd?: string,
): string {
  let output = '';
  if (result.stdout.length > 0) output += `stdout:\n${result.stdout}\n`;
  if (result.stderr.length > 0) output += `stderr:\n${result.stderr}\n`;
  if (output.length === 0) output = 'Command completed with no output.\n';
  if (result.exitCode != null) output += `[exit code: ${result.exitCode}]`;
  if (result.signal != null) output += `[terminated by ${result.signal}]`;
  if (result.timedOut) output += '[timed out]';
  if (result.truncated) output += '[output truncated]';
  if (result.timedOut) {
    output += `\nCommand reached timeoutMs: ${timeoutMs}. Before retrying, check for partial side effects. Set timeoutMs explicitly up to ${maxTimeoutMs} milliseconds, or use run_in_background: true if available. Background execution uses the same timeout ceiling.`;
  }
  return `[starting directory: ${JSON.stringify(`workspace/${cwd ?? ''}`)}]\n${output}`;
}

export function createAttachedWorkspaceBashTool({
  baseUrl,
  authHeaders,
  workspaceId,
  workspaceInstanceId,
  environment,
  gitIdentity,
  maxTimeoutMs = WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS,
  defaultTimeoutMs = WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS,
  maxQueueWaitMs,
  codeApiMaxRetryWaitMs,
  maxRequestTimeoutMs,
  minCommandAdmissionMs,
  linkedWorktrees = false,
  nativeSandbox = false,
  fetchImpl,
}: {
  baseUrl: string;
  authHeaders: () => Promise<Record<string, string>> | Record<string, string>;
  workspaceId: string;
  workspaceInstanceId?: string;
  /** The worker runs each `.worktrees/<name>` in its own lane; a matching `cwd` is routed there. */
  linkedWorktrees?: boolean;
  /** The worker advertises its native SRT sandbox profile; describe its read-only filesystem. */
  nativeSandbox?: boolean;
  environment?: CodeWorkspaceDescriptor['environment'];
  gitIdentity?: AgentGitIdentity | null;
  /** Effective admin/upstream ceiling already intersected with the protocol hard cap. */
  maxTimeoutMs?: number;
  /** Foreground timeout when omitted by the model; bounded by the effective ceiling. */
  defaultTimeoutMs?: number;
  /** Retry horizon across typed queue expirations, not an admission budget. */
  maxQueueWaitMs?: number;
  codeApiMaxRetryWaitMs?: number;
  /** Verified total HTTP budget; omission keeps the legacy per-attempt timeout. */
  maxRequestTimeoutMs?: number;
  /** Minimum time for command admission inside an opted-in HTTP budget. */
  minCommandAdmissionMs?: number;
  fetchImpl?: CodeBridgeFetch;
}): DynamicStructuredTool {
  const effectiveMaxTimeoutMs = fitCommandTimeoutMaxToBudget(
    normalizeAttachedWorkspaceCommandTimeoutMax(maxTimeoutMs),
    maxRequestTimeoutMs,
    minCommandAdmissionMs,
  );
  const effectiveDefaultTimeoutMs = resolveAttachedWorkspaceCommandTimeoutDefault(
    defaultTimeoutMs,
    effectiveMaxTimeoutMs,
  );
  const schema = structuredClone(
    buildAttachedWorkspaceBashSchema(
      effectiveMaxTimeoutMs,
      environment,
      linkedWorktrees,
      effectiveDefaultTimeoutMs,
    ),
  );
  const actions = environment?.actions ?? [];
  const bashTool = tool(
    async (
      rawInput: {
        command?: string;
        environmentAction?: string;
        args?: string[];
        cwd?: string;
        timeoutMs?: number;
        intent?: string;
      },
      config,
    ): Promise<[string, Record<string, never>]> => {
      const action = rawInput.environmentAction;
      if (action !== undefined) {
        if (
          !environment ||
          !actions.includes(action) ||
          rawInput.command !== undefined ||
          rawInput.args !== undefined ||
          rawInput.cwd !== undefined
        ) {
          throw new Error('Choose an advertised environment action without command, args or cwd.');
        }
      } else if (typeof rawInput.command !== 'string' || rawInput.command.trim().length === 0) {
        throw new Error('Supply a command or an advertised environment action.');
      }
      if (rawInput.timeoutMs != null && rawInput.timeoutMs > effectiveMaxTimeoutMs) {
        throw new Error(
          `Command timeout exceeds the deployment limit of ${effectiveMaxTimeoutMs} milliseconds.`,
        );
      }
      const command =
        action ??
        commandWithGitIdentity(commandWithArguments(rawInput.command!, rawInput.args), gitIdentity);
      const timeoutMs =
        rawInput.timeoutMs ??
        (config?.configurable?.[BACKGROUND_TOOL_INVOCATION_CONFIG_KEY] === true
          ? effectiveMaxTimeoutMs
          : effectiveDefaultTimeoutMs);
      const signal = config?.signal;
      const trace = {
        runId: config?.metadata?.run_id,
        workspaceId,
        signalPresent: signal != null,
      };
      const onAbort = (): void => {
        logger.debug('[BYOMCommand] invocation signal aborted', trace);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      logger.debug('[BYOMCommand] dispatch', { ...trace, aborted: signal?.aborted === true });
      try {
        const result = await executeWorkspaceTool({
          baseURL: baseUrl,
          /** Passed as a supplier: a queued call outlives its minted token. */
          authHeaders,
          linkedWorktrees,
          request: {
            protocolVersion: 1,
            operation: 'execute_command',
            workspaceId,
            ...(workspaceInstanceId ? { workspaceInstanceId } : {}),
            command,
            ...(action && environment
              ? { environmentAction: { name: action, fingerprint: environment.fingerprint } }
              : {}),
            ...(rawInput.cwd ? { cwd: rawInput.cwd } : {}),
            timeoutMs,
            maxOutputBytes: DEFAULT_OUTPUT_BYTES,
          },
          signal,
          fetchImpl,
          ...(maxQueueWaitMs == null ? {} : { maxQueueWaitMs }),
          ...(codeApiMaxRetryWaitMs == null ? {} : { codeApiMaxRetryWaitMs }),
          ...(maxRequestTimeoutMs == null ? {} : { maxRequestTimeoutMs }),
        });
        if (result.operation !== 'execute_command') {
          throw new Error('Attached workspace returned an unexpected command result.');
        }
        logger.debug('[BYOMCommand] transport completed', trace);
        let content = formatCommandResult(result, timeoutMs, effectiveMaxTimeoutMs, rawInput.cwd);
        if (action === undefined && /^\s*cd(?:\s|$)/.test(rawInput.command!)) {
          content +=
            '\n[directory hint: For future commands scoped to a workspace subdirectory, pass cwd instead of a leading cd.' +
            (linkedWorktrees
              ? ' A cd inside the script does not select a linked-worktree lane, so this call ran checkout-wide.'
              : '') +
            ' Keep cd for scripts that depend on shell state or need root access. This command was not rewritten; do not rerun it just to change cwd.]';
        }
        return [content, {}];
      } finally {
        signal?.removeEventListener('abort', onAbort);
        logger.debug('[BYOMCommand] transport settled', {
          ...trace,
          aborted: signal?.aborted === true,
        });
      }
    },
    {
      name: BashExecutionToolDefinition.name,
      description: buildAttachedWorkspaceBashDescription(false, environment, nativeSandbox),
      schema,
      responseFormat: 'content_and_artifact',
    },
  ) as unknown as DynamicStructuredTool;
  attachedWorkspaceBashTools.add(bashTool);
  return bashTool;
}
