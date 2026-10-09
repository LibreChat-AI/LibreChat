import { spawn } from 'node:child_process';
import { Tools } from 'librechat-data-provider';
import { logger } from '@librechat/data-schemas';
import { BashExecutionToolDefinition, ReadFileToolDefinition } from '@librechat/agents';
import type { HookEvent, HookOutput, ToolDecision, StopDecision } from '@librechat/agents';
import type { PluginHookExecutor, PluginHookExecutionRequest } from './runtime';
import type { PluginHookCapabilities } from './compatibility';
import type { PluginHookHandler } from './schema';
import { CREATE_FILE_TOOL_NAME, EDIT_FILE_TOOL_NAME } from '~/agents/tools';
import { createReaper } from './reaper';

const MAX_CAPTURED_STREAM_BYTES = 1_048_576;
const MAX_REASON_LENGTH = 2_000;
const MAX_ADDITIONAL_CONTEXT_LENGTH = 32_768;
const KILL_GRACE_MS = 5_000;
const BLOCKING_EXIT_CODE = 2;

const TOOL_DECISIONS: ReadonlySet<string> = new Set<ToolDecision>(['allow', 'deny', 'ask']);
const STOP_DECISIONS: ReadonlySet<string> = new Set<StopDecision>(['continue', 'block']);
/**
 * Decision tokens accepted as INPUT per channel: the channel's native set
 * plus the Claude legacy spellings that map into it. A token valid for the
 * other channel (`continue` on a tool event) is malformed here and must not
 * suppress a valid Claude decision.
 */
const TOOL_INPUT_DECISIONS: ReadonlySet<string> = new Set([...TOOL_DECISIONS, 'approve', 'block']);
const STOP_INPUT_DECISIONS: ReadonlySet<string> = STOP_DECISIONS;
const STDOUT_CONTEXT_EVENTS: ReadonlySet<string> = new Set(['SessionStart', 'UserPromptSubmit']);
const PASSTHROUGH_ENV_VARS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'] as const;

interface EventTraits {
  /** Whether the matcher queries a runtime tool name, enabling alias translation. */
  toolMatcher: boolean;
  /** Decision vocabulary a hook output may use for this event. */
  decisions: 'tool' | 'stop';
  /** Blocking output shape produced by the exit-code-2 contract. */
  exitTwo: 'deny' | 'block' | 'prevent';
}

/**
 * Exhaustive per-event semantics. `satisfies Record<HookEvent, ...>` makes the
 * compiler demand an answer for every current and future engine event, so a
 * new event can never silently inherit an unconsidered default.
 */
const EVENT_TRAITS = {
  RunStart: { toolMatcher: false, decisions: 'tool', exitTwo: 'prevent' },
  UserPromptSubmit: { toolMatcher: false, decisions: 'tool', exitTwo: 'deny' },
  PreToolUse: { toolMatcher: true, decisions: 'tool', exitTwo: 'deny' },
  PostToolUse: { toolMatcher: true, decisions: 'tool', exitTwo: 'prevent' },
  PostToolUseFailure: { toolMatcher: true, decisions: 'tool', exitTwo: 'prevent' },
  PostToolBatch: { toolMatcher: false, decisions: 'tool', exitTwo: 'prevent' },
  PreemptBoundary: { toolMatcher: false, decisions: 'tool', exitTwo: 'prevent' },
  PermissionDenied: { toolMatcher: true, decisions: 'tool', exitTwo: 'prevent' },
  SubagentStart: { toolMatcher: false, decisions: 'tool', exitTwo: 'deny' },
  SubagentStop: { toolMatcher: false, decisions: 'tool', exitTwo: 'prevent' },
  Stop: { toolMatcher: false, decisions: 'stop', exitTwo: 'block' },
  StopFinalize: { toolMatcher: false, decisions: 'stop', exitTwo: 'block' },
  StopFailure: { toolMatcher: false, decisions: 'tool', exitTwo: 'prevent' },
  PreCompact: { toolMatcher: false, decisions: 'tool', exitTwo: 'prevent' },
  PostCompact: { toolMatcher: false, decisions: 'tool', exitTwo: 'prevent' },
} as const satisfies Record<HookEvent, EventTraits>;

function renameFields(
  input: Record<string, unknown>,
  fields: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    output[fields[key] ?? key] = value;
  }
  return output;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const FILE_FIELDS: Readonly<Record<string, string>> = Object.freeze({ path: 'file_path' });
const EDIT_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  path: 'file_path',
  old_text: 'old_string',
  new_text: 'new_string',
});
const EDIT_BATCH_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  old_text: 'old_string',
  new_text: 'new_string',
});

function toClaudeFileInput(toolInput: Record<string, unknown>): Record<string, unknown> {
  return renameFields(toolInput, FILE_FIELDS);
}

function toClaudeEditInput(toolInput: Record<string, unknown>): Record<string, unknown> {
  const renamed = renameFields(toolInput, EDIT_FIELDS);
  if (Array.isArray(renamed.edits)) {
    renamed.edits = renamed.edits.map((edit) =>
      isPlainObject(edit) ? renameFields(edit, EDIT_BATCH_FIELDS) : edit,
    );
  }
  return renamed;
}

interface ClaudeToolAlias {
  claudeName: string;
  runtimeName: string;
  /** Presents the runtime tool arguments under Claude's field names. */
  toPluginInput?: (toolInput: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Claude-compatible tool aliases, with runtime names imported from their
 * canonical definitions rather than restated as literals — a hand-maintained
 * parallel table is how the `WebSearch` mapping was originally missed.
 * Without this table a plugin authored against Claude's namespace (`Bash`,
 * `Write`) would plan as ready yet register a matcher that never fires — a
 * silently bypassed guard. `bash_tool` and `web_search` share Claude's
 * load-bearing field names (`command`, `query`), so only the file tools
 * need input translation.
 */
const CLAUDE_TOOL_ALIASES: readonly ClaudeToolAlias[] = [
  { claudeName: 'Bash', runtimeName: BashExecutionToolDefinition.name },
  { claudeName: 'Write', runtimeName: CREATE_FILE_TOOL_NAME, toPluginInput: toClaudeFileInput },
  { claudeName: 'Edit', runtimeName: EDIT_FILE_TOOL_NAME, toPluginInput: toClaudeEditInput },
  {
    claudeName: 'Read',
    runtimeName: ReadFileToolDefinition.name,
    toPluginInput: toClaudeFileInput,
  },
  { claudeName: 'WebSearch', runtimeName: Tools.web_search },
];
const ALIAS_BY_CLAUDE: ReadonlyMap<string, ClaudeToolAlias> = new Map(
  CLAUDE_TOOL_ALIASES.map((alias) => [alias.claudeName, alias]),
);
const ALIAS_BY_RUNTIME: ReadonlyMap<string, ClaudeToolAlias> = new Map(
  CLAUDE_TOOL_ALIASES.map((alias) => [alias.runtimeName, alias]),
);
/**
 * Alias tokens count only when delimited by characters that cannot appear in
 * a runtime tool name (word characters and hyphens). A `\b` boundary is not
 * enough: action tool names preserve hyphens, so `deploy-Bash-v2_...` is one
 * literal tool name whose embedded alias must never be rewritten — the
 * rewritten matcher would silently stop matching the real tool. Dots are
 * deliberately NOT name characters: runtime names never contain them (action
 * ids underscore domain dots), while regex forms like `^Bash.*$` put a
 * metacharacter directly after the alias and must still translate.
 */
const TOOL_NAME_BOUNDARY_BEFORE = '(?<![\\w-])';
const TOOL_NAME_BOUNDARY_AFTER = '(?![\\w-])';
const ALIAS_TOKEN_PATTERN = new RegExp(
  `${TOOL_NAME_BOUNDARY_BEFORE}(${CLAUDE_TOOL_ALIASES.map((alias) => alias.claudeName).join(
    '|',
  )})${TOOL_NAME_BOUNDARY_AFTER}`,
  'g',
);
/** Character classes and escapes where token substitution could corrupt regex semantics. */
const UNSAFE_ALIAS_CONTEXT = /[\\[\]]/;

/**
 * Claude built-ins with no LibreChat runtime equivalent. A tool matcher naming
 * one is rejected as unmapped at plan time: passing it through would register
 * a guard that plans ready and never fires — the same silent-bypass failure
 * mode the alias table exists to prevent.
 */
const UNSUPPORTED_CLAUDE_TOOLS = [
  'Task',
  'Glob',
  'Grep',
  'MultiEdit',
  'NotebookEdit',
  'TodoWrite',
  'WebFetch',
  'BashOutput',
  'KillShell',
  'ExitPlanMode',
  'AskUserQuestion',
  'SlashCommand',
] as const;
const UNSUPPORTED_TOOL_PATTERN = new RegExp(
  `${TOOL_NAME_BOUNDARY_BEFORE}(?:${UNSUPPORTED_CLAUDE_TOOLS.join(
    '|',
  )})${TOOL_NAME_BOUNDARY_AFTER}`,
);

function containsAliasToken(matcher: string): boolean {
  ALIAS_TOKEN_PATTERN.lastIndex = 0;
  return ALIAS_TOKEN_PATTERN.test(matcher);
}

/**
 * Plan-time gate for handlers the executor cannot run on the current host.
 * Windows has no portable `bash`, so a command handler must declare
 * `commandWindows` or `shell: "powershell"` to be executable there; POSIX
 * hosts run the portable `command` with bash, so a handler declaring
 * `shell: "powershell"` without a separate `commandWindows` variant marks
 * its only command as PowerShell syntax that bash would fail open on.
 * Exported with an explicit platform parameter for direct testing.
 */
export function getShellHandlerIssue(
  handler: PluginHookHandler,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (handler.type !== 'command') {
    return undefined;
  }
  if (platform === 'win32') {
    if (handler.shell === 'powershell' || handler.commandWindows !== undefined) {
      return undefined;
    }
    return 'Windows hosts run command hooks with PowerShell; declare commandWindows or shell "powershell"';
  }
  if (handler.shell === 'powershell' && handler.commandWindows === undefined) {
    return 'This host runs command hooks with bash; shell "powershell" requires a commandWindows variant so the portable command stays bash-compatible';
  }
  return undefined;
}

/**
 * Capabilities of the command executor, shared by plan time (plugin loading)
 * and run time (hook registration) so a handler the loader marked `ready` is
 * always executable. Alias tokens translate in exact matchers ("Bash|Write")
 * and in regex matchers ("^(Write|Edit)$") via word-bounded substitution; a
 * regex whose alias sits in a character class or escape — or any matcher
 * naming a Claude built-in with no runtime equivalent — is rejected as
 * unmapped, a loud plan-time diagnostic instead of a guard that never fires.
 * Payloads are presented entirely in the plugin's namespace: `tool_name`
 * maps back to the Claude alias and `tool_input` fields are renamed to
 * Claude's schema, so one hook script works unchanged across both.
 */
export const commandExecutorCapabilities: PluginHookCapabilities = {
  handlerTypes: new Set(['command']),
  translateMatcher: ({ matcher, targetEvent }) => {
    if (EVENT_TRAITS[targetEvent].toolMatcher !== true) {
      return matcher;
    }
    if (UNSUPPORTED_TOOL_PATTERN.test(matcher)) {
      return undefined;
    }
    if (!containsAliasToken(matcher)) {
      return matcher;
    }
    if (UNSAFE_ALIAS_CONTEXT.test(matcher)) {
      return undefined;
    }
    ALIAS_TOKEN_PATTERN.lastIndex = 0;
    const translatedToolNames = new Set<string>();
    const mapped = matcher.replace(ALIAS_TOKEN_PATTERN, (claudeName) => {
      const alias = ALIAS_BY_CLAUDE.get(claudeName);
      if (alias === undefined) {
        return claudeName;
      }
      translatedToolNames.add(alias.runtimeName);
      return alias.runtimeName;
    });
    /**
     * The produced names scope reverse payload translation per invocation:
     * a mixed matcher like "Bash|create_file" translates payloads only for
     * `bash_tool`, keeping the natively-authored alternative native.
     */
    return {
      matcher: mapped,
      requiresToolNameTranslation: true,
      translatedToolNames: Array.from(translatedToolNames),
    };
  },
  toPluginToolName: ({ toolName }) => ALIAS_BY_RUNTIME.get(toolName)?.claudeName ?? toolName,
  toPluginToolInput: ({ toolName, toolInput }) =>
    ALIAS_BY_RUNTIME.get(toolName)?.toPluginInput?.(toolInput) ?? toolInput,
  supportsHandler: ({ handler }) => getShellHandlerIssue(handler),
  sessionLifecycle: true,
};

export interface CommandExecutorOptions {
  /** Filesystem-resolved plugin root; becomes the command's cwd and `PLUGIN_ROOT`. */
  pluginRoot: string;
  /** Persistent per-plugin data directory; becomes `PLUGIN_DATA`. */
  pluginData: string;
  /** Environment source for the allowlist (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /**
   * Whether `ask` decisions can raise a resumable approval interrupt. Off by
   * default: without a HITL surface an `ask` is tightened to `deny` so a
   * plugin's confirmation intent still blocks rather than stranding the run.
   */
  allowAskDecision?: boolean;
  /** SIGTERM-to-SIGKILL escalation delay after an abort (defaults to 5s). */
  killGraceMs?: number;
}

interface CommandCompletion {
  code: number | null;
  stdout: string;
  stderr: string;
}

function buildCommandEnv(
  options: CommandExecutorOptions,
  allowedEnvVars: string[] | undefined,
): NodeJS.ProcessEnv {
  const source = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASSTHROUGH_ENV_VARS) {
    if (source[name] !== undefined) {
      env[name] = source[name];
    }
  }
  for (const name of allowedEnvVars ?? []) {
    if (source[name] !== undefined) {
      env[name] = source[name];
    }
  }
  /** Reserved names win last so an allowlist entry can never override them. */
  env.PLUGIN_ROOT = options.pluginRoot;
  env.PLUGIN_DATA = options.pluginData;
  env.CLAUDE_PLUGIN_ROOT = options.pluginRoot;
  return env;
}

/**
 * Agent Plugins §9.2 expansion applied to hook commands: one literal,
 * non-recursive pass. `CLAUDE_PLUGIN_ROOT` is Claude Code's spelling of the
 * plugin root — hooks authored for Claude use it in every standard command —
 * and it is also exported in the child environment for unbraced references.
 */
function expandVariables(value: string, options: CommandExecutorOptions): string {
  return value.replace(
    /\$\{(PLUGIN_ROOT|PLUGIN_DATA|CLAUDE_PLUGIN_ROOT)\}/g,
    (_match, name: string) => (name === 'PLUGIN_DATA' ? options.pluginData : options.pluginRoot),
  );
}

interface ShellInvocation {
  executable: string;
  argv: string[];
}

/**
 * POSIX hosts run `bash -c <command>` with `args` bound to `$1..$n`. Windows
 * hosts run PowerShell and require `commandWindows` or `shell: powershell`.
 * Both directions are enforced at plan time via `supportsHandler` and again
 * here, so a command never silently runs through a shell it was not written
 * for: a PowerShell-only handler is skipped on POSIX, while a handler with
 * both variants runs its portable `command` there.
 */
function buildInvocation(
  request: PluginHookExecutionRequest,
  options: CommandExecutorOptions,
): ShellInvocation | undefined {
  const { handler } = request;
  const isWindows = process.platform === 'win32';
  const rawCommand = isWindows ? (handler.commandWindows ?? handler.command) : handler.command;
  if (!rawCommand?.trim()) {
    return undefined;
  }
  const command = expandVariables(rawCommand, options);
  const args = (handler.args ?? []).map((arg) => expandVariables(arg, options));
  if (isWindows) {
    if (handler.shell !== 'powershell' && handler.commandWindows === undefined) {
      return undefined;
    }
    const quotedArgs = args.map((arg) => `'${arg.replace(/'/g, "''")}'`);
    return {
      executable: 'powershell.exe',
      argv: ['-NoLogo', '-NoProfile', '-Command', [command, ...quotedArgs].join(' ')],
    };
  }
  if (handler.shell === 'powershell' && handler.commandWindows === undefined) {
    return undefined;
  }
  return { executable: 'bash', argv: ['-c', command, 'bash', ...args] };
}

interface CapturedStream {
  chunks: Buffer[];
  bytes: number;
}

function appendCapped(stream: CapturedStream, chunk: Buffer): void {
  const remaining = MAX_CAPTURED_STREAM_BYTES - stream.bytes;
  if (remaining <= 0) {
    return;
  }
  const kept = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
  stream.chunks.push(kept);
  stream.bytes += kept.byteLength;
}

function capturedText(stream: CapturedStream): string {
  return Buffer.concat(stream.chunks).toString('utf8');
}

function runCommand(
  invocation: ShellInvocation,
  payload: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  signal: AbortSignal,
  killGraceMs: number,
): Promise<CommandCompletion> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.argv, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: CapturedStream = { chunks: [], bytes: 0 };
    const stderr: CapturedStream = { chunks: [], bytes: 0 };
    const reaper = createReaper(child, killGraceMs);
    const onAbort = (): void => reaper.reap();
    signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      appendCapped(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      appendCapped(stderr, chunk);
    });
    child.on('error', (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    /**
     * Swept at `exit` as well as `close`: a backgrounded descendant holding
     * the captured pipes delays `close` until it dies, so the exit-time
     * sweep is what keeps a successful hook from stalling on its own
     * unsupported worker.
     */
    child.on('exit', () => {
      reaper.sweep();
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      reaper.sweep();
      resolve({ code, stdout: capturedText(stdout), stderr: capturedText(stderr) });
    });
    child.stdin.on('error', () => {
      /* A handler that never reads stdin closes the pipe early; EPIPE is not a failure. */
    });
    child.stdin.end(payload);
  });
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

/**
 * Accepts only the SDK output fields a plugin command may set. Decisions are
 * validated against the target event's legal set; message-injection fields
 * (`injectedMessages`, `allowedDecisions`) stay host-only. `updatedInput` is
 * also host-only: hooks in one dispatch all receive the original arguments,
 * so a plugin rewrite would reach the tool without the approval policy ever
 * re-evaluating it.
 */
function sanitizeOutput(
  raw: Record<string, unknown>,
  request: PluginHookExecutionRequest,
  options: CommandExecutorOptions,
): HookOutput {
  const output: Record<string, unknown> = {};
  const decisions =
    EVENT_TRAITS[request.targetEvent].decisions === 'stop' ? STOP_DECISIONS : TOOL_DECISIONS;
  if (typeof raw.decision === 'string' && decisions.has(raw.decision)) {
    output.decision =
      raw.decision === 'ask' && options.allowAskDecision !== true ? 'deny' : raw.decision;
  }
  if (typeof raw.reason === 'string') {
    output.reason = truncate(raw.reason, MAX_REASON_LENGTH);
  }
  if (typeof raw.additionalContext === 'string') {
    output.additionalContext = truncate(raw.additionalContext, MAX_ADDITIONAL_CONTEXT_LENGTH);
  }
  if (request.targetEvent === 'PostToolUse' && 'updatedOutput' in raw) {
    output.updatedOutput = raw.updatedOutput;
  }
  if (typeof raw.preventContinuation === 'boolean') {
    output.preventContinuation = raw.preventContinuation;
  }
  if (typeof raw.stopReason === 'string') {
    output.stopReason = truncate(raw.stopReason, MAX_REASON_LENGTH);
  }
  if (raw.async === true) {
    output.async = true;
  }
  return output as HookOutput;
}

/**
 * Normalizes Claude Code's structured hook-output dialect into the engine's
 * native field names before sanitizing, so a stock Claude guard works
 * unchanged: `hookSpecificOutput.permissionDecision`/`…Reason` become
 * `decision`/`reason`, `hookSpecificOutput.additionalContext` surfaces,
 * `continue: false` becomes `preventContinuation`, and the legacy decisions
 * map (`approve` → `allow`; `block` → `deny` on events that block by
 * denying, or into `preventContinuation` where the event has no decision
 * channel at all). Native fields win when both dialects appear — but only
 * when valid for THIS event: a malformed value (`"decision": null`) or one
 * from the other channel's vocabulary (`"continue"` on a tool event) is
 * stripped before the dialect merge, so it cannot suppress a valid Claude
 * decision into a silent allow.
 */
function normalizeOutput(
  raw: Record<string, unknown>,
  request: PluginHookExecutionRequest,
): Record<string, unknown> {
  const traits = EVENT_TRAITS[request.targetEvent];
  const acceptedDecisions =
    traits.decisions === 'stop' ? STOP_INPUT_DECISIONS : TOOL_INPUT_DECISIONS;
  const output: Record<string, unknown> = { ...raw };
  if (typeof output.decision !== 'string' || !acceptedDecisions.has(output.decision)) {
    delete output.decision;
  }
  if (typeof output.reason !== 'string') {
    delete output.reason;
  }
  if (typeof output.additionalContext !== 'string') {
    delete output.additionalContext;
  }
  if (raw.continue === false && output.preventContinuation === undefined) {
    output.preventContinuation = true;
  }
  const hookSpecific = isPlainObject(raw.hookSpecificOutput) ? raw.hookSpecificOutput : undefined;
  if (hookSpecific !== undefined) {
    if (output.decision === undefined && typeof hookSpecific.permissionDecision === 'string') {
      output.decision = hookSpecific.permissionDecision;
      if (
        output.reason === undefined &&
        typeof hookSpecific.permissionDecisionReason === 'string'
      ) {
        output.reason = hookSpecific.permissionDecisionReason;
      }
    }
    if (
      output.additionalContext === undefined &&
      typeof hookSpecific.additionalContext === 'string'
    ) {
      output.additionalContext = hookSpecific.additionalContext;
    }
  }
  if (output.decision === 'approve') {
    output.decision = 'allow';
  } else if (output.decision === 'block' && traits.decisions === 'tool') {
    if (traits.exitTwo === 'deny') {
      output.decision = 'deny';
    } else {
      /**
       * Post-tool and other prevent-trait events have no deny channel, so a
       * structured `block` controls the run the only way it can: by stopping
       * the next model turn, carrying its reason as the stop reason.
       */
      delete output.decision;
      output.preventContinuation = true;
      if (output.stopReason === undefined && typeof output.reason === 'string') {
        output.stopReason = output.reason;
      }
    }
  }
  return output;
}

function parseCompletion(
  completion: CommandCompletion,
  request: PluginHookExecutionRequest,
  options: CommandExecutorOptions,
): HookOutput {
  const label = `[pluginHooks] ${request.pluginId} ${request.sourceEvent}`;
  if (completion.code === BLOCKING_EXIT_CODE) {
    const reason = truncate(completion.stderr.trim(), MAX_REASON_LENGTH);
    const exitTwo = EVENT_TRAITS[request.targetEvent].exitTwo;
    if (exitTwo === 'block') {
      return { decision: 'block', ...(reason && { reason }) };
    }
    if (exitTwo === 'deny') {
      return { decision: 'deny', ...(reason && { reason }) };
    }
    /** Events with no decision channel block by preventing the next model turn. */
    return { preventContinuation: true, ...(reason && { stopReason: reason }) };
  }
  if (completion.code !== 0) {
    logger.warn(
      `${label}: command exited with code ${completion.code}: ${truncate(
        completion.stderr.trim(),
        MAX_REASON_LENGTH,
      )}`,
    );
    return {};
  }
  const stdout = completion.stdout.trim();
  if (!stdout) {
    return {};
  }
  if (stdout.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (isPlainObject(parsed)) {
        return sanitizeOutput(normalizeOutput(parsed, request), request, options);
      }
    } catch (error) {
      logger.warn(`${label}: stdout is not valid JSON and was ignored`, error);
      return {};
    }
  }
  if (STDOUT_CONTEXT_EVENTS.has(request.sourceEvent)) {
    return { additionalContext: truncate(stdout, MAX_ADDITIONAL_CONTEXT_LENGTH) };
  }
  return {};
}

/**
 * Runs `command` hook handlers as child processes outside the LibreChat API
 * process, mirroring Claude Code's contract: the event payload arrives as
 * JSON on stdin, exit 0 with JSON stdout returns a (sanitized) hook output,
 * exit 2 blocks with stderr as the reason, and any other exit is logged and
 * ignored. Commands run from the plugin root with a minimal allowlisted
 * environment plus `PLUGIN_ROOT`/`PLUGIN_DATA`.
 *
 * SECURITY: deployment plugins are operator-installed code, the same trust
 * level as `toolApproval.hooks` modules. Execution is additionally gated on
 * the `DEPLOYMENT_PLUGIN_HOOKS` environment opt-in (see `plugins/runtime`).
 */
export function createCommandExecutor(options: CommandExecutorOptions): PluginHookExecutor {
  return {
    capabilities: commandExecutorCapabilities,
    async execute(request, signal) {
      const invocation = buildInvocation(request, options);
      if (invocation === undefined || signal.aborted) {
        return {};
      }
      const env = buildCommandEnv(options, request.handler.allowedEnvVars);
      let payload: string;
      try {
        payload = JSON.stringify(request.payload);
      } catch (error) {
        logger.warn(
          `[pluginHooks] ${request.pluginId} ${request.sourceEvent}: payload could not be serialized`,
          error,
        );
        return {};
      }
      try {
        const completion = await runCommand(
          invocation,
          payload,
          env,
          options.pluginRoot,
          signal,
          options.killGraceMs ?? KILL_GRACE_MS,
        );
        if (signal.aborted) {
          logger.warn(`[pluginHooks] ${request.pluginId} ${request.sourceEvent}: command aborted`);
          return {};
        }
        return parseCompletion(completion, request, options);
      } catch (error) {
        if (signal.aborted) {
          logger.warn(`[pluginHooks] ${request.pluginId} ${request.sourceEvent}: command aborted`);
          return {};
        }
        logger.warn(
          `[pluginHooks] ${request.pluginId} ${request.sourceEvent}: command failed to run`,
          error,
        );
        return {};
      }
    },
  };
}
