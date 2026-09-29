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
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { LCTool } from '@librechat/agents';
import type { WorkspaceExecuteCommandResult } from './workspace';
import type { CodeExecutionContext } from '~/agents/execution';
import type { CodeBridgeFetch } from './bridge';
import {
  executeWorkspaceTool,
  WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS,
  WORKSPACE_COMMAND_MAX_TIMEOUT_MS,
  WORKSPACE_QUEUE_MAX_WAIT_MS,
} from './workspace';
import { BACKGROUND_TOOL_INVOCATION_CONFIG_KEY } from '~/agents/invocation';

const DEFAULT_OUTPUT_BYTES = 256 * 1024;

export const ATTACHED_WORKSPACE_BASH_DESCRIPTION = `Runs bash commands inside the selected attached environment and returns stdout/stderr. Its workspace may be an existing project, Git repository, or empty directory.

Session behavior:
- This starts a new command, not an existing background task. Inspect a background_task_id with check_background_task when available; never send it to bash_tool.
- Only registered-workspace files persist between calls. Install project dependencies there.
- Every call is a fresh process. Shell and exported variables, cwd, /tmp, $TMPDIR, and background processes do not survive.
- $HOME, global/system packages, and machine services are operator-managed. Do not change or rely on them as session storage.
- Network access follows the sandbox policy configured on the worker and may be unavailable. File access follows the same worker policy.
- Input code is already displayed to the user; do not repeat it unless asked.
- Explicitly print every result the user should see.
- Never use this tool to execute malicious commands.`;

const bashSchema = BashExecutionToolDefinition.schema as {
  properties?: NonNullable<LCTool['parameters']>['properties'];
};
const attachedCommandSchema: NonNullable<LCTool['parameters']> = {
  ...bashSchema.properties?.command,
  type: 'string',
  description:
    'The bash command or script to execute from the attached workspace root. Only files written inside the workspace persist between calls. Each call starts a fresh process; $HOME, temporary files, shell state, global installs, and background processes are not durable.',
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
    'Optional working directory relative to the selected workspace root, such as "packages/api". Absolute paths and parent traversal are rejected.',
};

/** Numeric bounds are valid JSON Schema, but the SDK's schema type omits them. */
interface BoundedTimeoutSchema {
  type: 'integer';
  minimum: number;
  maximum: number;
  description: string;
}

function buildAttachedTimeoutSchema(maxTimeoutMs: number): BoundedTimeoutSchema {
  const defaultTimeoutMs = Math.min(WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS, maxTimeoutMs);
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
  return Math.min(requested, upstream);
}

/**
 * Programmatic calls do not currently carry the detached-invocation marker.
 * Preserve their historical foreground default while still enforcing both an
 * explicit administrator override and the live upstream ceiling.
 */
export function resolveAttachedWorkspaceProgrammaticTimeout(
  configSchema?: CodeEnvironmentUserConfigSchema,
  upstreamMaxTimeoutMs?: number,
): number {
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

export function buildAttachedWorkspaceBashSchema(
  maxTimeoutMs: number = WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS,
  environment?: CodeWorkspaceDescriptor['environment'],
): NonNullable<LCTool['parameters']> {
  const effectiveMaxTimeoutMs = normalizeAttachedWorkspaceCommandTimeoutMax(maxTimeoutMs);
  return {
    type: 'object',
    properties: {
      ...bashSchema.properties,
      command: attachedCommandSchema,
      cwd: attachedWorkingDirectorySchema,
      timeoutMs: buildAttachedTimeoutSchema(effectiveMaxTimeoutMs),
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
): string {
  const description = enableToolOutputReferences
    ? `${ATTACHED_WORKSPACE_BASH_DESCRIPTION}\n\n${BashToolOutputReferencesGuide}`
    : ATTACHED_WORKSPACE_BASH_DESCRIPTION;
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
  return createGitIdentityProgrammaticBashTool(options, attached ? identity : undefined);
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

function formatCommandResult(result: WorkspaceExecuteCommandResult): string {
  let output = '';
  if (result.stdout.length > 0) output += `stdout:\n${result.stdout}\n`;
  if (result.stderr.length > 0) output += `stderr:\n${result.stderr}\n`;
  if (output.length === 0) output = 'Command completed with no output.\n';
  if (result.exitCode != null) output += `[exit code: ${result.exitCode}]`;
  if (result.signal != null) output += `[terminated by ${result.signal}]`;
  if (result.timedOut) output += '[timed out]';
  if (result.truncated) output += '[output truncated]';
  return output;
}

export function createAttachedWorkspaceBashTool({
  baseUrl,
  authHeaders,
  workspaceId,
  workspaceInstanceId,
  environment,
  gitIdentity,
  maxTimeoutMs = WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS,
  maxQueueWaitMs,
  codeApiMaxRetryWaitMs,
  maxRequestTimeoutMs,
  fetchImpl,
}: {
  baseUrl: string;
  authHeaders: () => Promise<Record<string, string>> | Record<string, string>;
  workspaceId: string;
  workspaceInstanceId?: string;
  environment?: CodeWorkspaceDescriptor['environment'];
  gitIdentity?: AgentGitIdentity | null;
  /** Effective admin/upstream ceiling already intersected with the protocol hard cap. */
  maxTimeoutMs?: number;
  /** Retry horizon across typed queue expirations, not an admission budget. */
  maxQueueWaitMs?: number;
  codeApiMaxRetryWaitMs?: number;
  /** Verified total HTTP budget; omission keeps the legacy per-attempt timeout. */
  maxRequestTimeoutMs?: number;
  fetchImpl?: CodeBridgeFetch;
}): DynamicStructuredTool {
  const effectiveMaxTimeoutMs = normalizeAttachedWorkspaceCommandTimeoutMax(maxTimeoutMs);
  const schema = structuredClone(
    buildAttachedWorkspaceBashSchema(effectiveMaxTimeoutMs, environment),
  );
  const actions = environment?.actions ?? [];
  return tool(
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
          : Math.min(WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS, effectiveMaxTimeoutMs));
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
        return [formatCommandResult(result), {}];
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
      description: buildAttachedWorkspaceBashDescription(false, environment),
      schema,
      responseFormat: 'content_and_artifact',
    },
  ) as unknown as DynamicStructuredTool;
}
