import fs from 'fs';
import os from 'os';
import path from 'path';
import type { HookInput, HookEvent } from '@librechat/agents';
import type { PluginHookExecutionRequest } from './runtime';
import type { PluginHookHandler } from './schema';
import {
  commandExecutorCapabilities,
  createCommandExecutor,
  getShellHandlerIssue,
} from './executor';

let pluginRoot: string;
let pluginData: string;

const PRE_TOOL_INPUT: HookInput = {
  hook_event_name: 'PreToolUse',
  runId: 'run-1',
  threadId: 'thread-1',
  toolName: 'write_file',
  toolInput: { path: '/workspace/file.ts' },
  toolUseId: 'tool-1',
};

function request(
  handler: PluginHookHandler,
  overrides: Partial<Omit<PluginHookExecutionRequest, 'handler'>> = {},
): PluginHookExecutionRequest {
  return {
    pluginId: 'demo',
    sourceEvent: 'PreToolUse',
    targetEvent: 'PreToolUse' as HookEvent,
    groupIndex: 0,
    handlerIndex: 0,
    handler,
    input: PRE_TOOL_INPUT,
    payload: {
      hook_event_name: 'PreToolUse',
      session_id: 'conversation-1',
      run_id: 'run-1',
      tool_name: 'write_file',
      tool_input: { path: '/workspace/file.ts' },
      tool_use_id: 'tool-1',
    },
    ...overrides,
  };
}

function execute(
  handler: PluginHookHandler,
  overrides: Partial<Omit<PluginHookExecutionRequest, 'handler'>> = {},
  env: NodeJS.ProcessEnv = { PATH: process.env.PATH },
  executorOptions: { allowAskDecision?: boolean } = {},
) {
  const executor = createCommandExecutor({ pluginRoot, pluginData, env, ...executorOptions });
  return executor.execute(request(handler, overrides), new AbortController().signal);
}

beforeEach(async () => {
  const base = await fs.promises.realpath(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lc-hook-exec-')),
  );
  pluginRoot = path.join(base, 'root');
  pluginData = path.join(base, 'data');
  await fs.promises.mkdir(pluginRoot, { recursive: true });
  await fs.promises.mkdir(pluginData, { recursive: true });
});

afterEach(async () => {
  await fs.promises.rm(path.dirname(pluginRoot), { recursive: true, force: true });
});

describe('createCommandExecutor', () => {
  test('advertises the plan-time capabilities', () => {
    const executor = createCommandExecutor({ pluginRoot, pluginData });
    expect(executor.capabilities).toBe(commandExecutorCapabilities);
    expect(executor.capabilities.handlerTypes.has('command')).toBe(true);
    expect(
      executor.capabilities.translateMatcher?.({
        sourceEvent: 'PreToolUse',
        targetEvent: 'PreToolUse',
        matcher: 'write_file|execute_code',
      }),
    ).toBe('write_file|execute_code');
  });

  test('translates Claude tool aliases in matchers and payload names', () => {
    const executor = createCommandExecutor({ pluginRoot, pluginData });
    expect(
      executor.capabilities.translateMatcher?.({
        sourceEvent: 'PreToolUse',
        targetEvent: 'PreToolUse',
        matcher: 'Bash|write_file',
      }),
    ).toEqual({
      matcher: 'bash_tool|write_file',
      requiresToolNameTranslation: true,
      translatedToolNames: ['bash_tool'],
    });
    expect(
      executor.capabilities.toPluginToolName?.({
        sourceEvent: 'PreToolUse',
        targetEvent: 'PreToolUse',
        toolName: 'bash_tool',
      }),
    ).toBe('Bash');
    expect(
      executor.capabilities.toPluginToolName?.({
        sourceEvent: 'PreToolUse',
        targetEvent: 'PreToolUse',
        toolName: 'my_mcp_tool',
      }),
    ).toBe('my_mcp_tool');
  });

  test('translates Claude aliases inside regex-form matchers or rejects unsafe ones', () => {
    const translate = (matcher: string) =>
      createCommandExecutor({ pluginRoot, pluginData }).capabilities.translateMatcher?.({
        sourceEvent: 'PreToolUse',
        targetEvent: 'PreToolUse',
        matcher,
      });
    expect(translate('^Bash$')).toEqual({
      matcher: '^bash_tool$',
      requiresToolNameTranslation: true,
      translatedToolNames: ['bash_tool'],
    });
    expect(translate('^(Write|Edit)$')).toEqual({
      matcher: '^(create_file|edit_file)$',
      requiresToolNameTranslation: true,
      translatedToolNames: ['create_file', 'edit_file'],
    });
    expect(translate('Bashful|write_file')).toBe('Bashful|write_file');
    /** Hyphen-joined names are single tool names, never alias sites. */
    expect(translate('deploy-Bash-v2_action_example_com')).toBe(
      'deploy-Bash-v2_action_example_com',
    );
    /** Regex metacharacters delimit aliases — runtime names never contain dots. */
    expect(translate('^Bash.*$')).toEqual({
      matcher: '^bash_tool.*$',
      requiresToolNameTranslation: true,
      translatedToolNames: ['bash_tool'],
    });
    expect(translate('[Bash]')).toBeUndefined();
    expect(translate('Bash\\d')).toBeUndefined();
    expect(translate('WebSearch')).toEqual({
      matcher: 'web_search',
      requiresToolNameTranslation: true,
      translatedToolNames: ['web_search'],
    });
  });

  test('rejects matchers naming Claude built-ins with no runtime equivalent', () => {
    const translate = (matcher: string) =>
      commandExecutorCapabilities.translateMatcher?.({
        sourceEvent: 'PreToolUse',
        targetEvent: 'PreToolUse',
        matcher,
      });
    expect(translate('Glob')).toBeUndefined();
    expect(translate('Task|my_mcp_tool')).toBeUndefined();
    expect(translate('^(Bash|WebFetch)$')).toBeUndefined();
    expect(translate('Grepish')).toBe('Grepish');
    expect(translate('my-Task-runner')).toBe('my-Task-runner');
  });

  test('presents aliased tool inputs under Claude field names', () => {
    const translate = (toolName: string, toolInput: Record<string, unknown>) =>
      commandExecutorCapabilities.toPluginToolInput?.({
        sourceEvent: 'PreToolUse',
        targetEvent: 'PreToolUse',
        toolName,
        toolInput,
      });
    expect(translate('create_file', { path: '/a.md', content: 'x', overwrite: true })).toEqual({
      file_path: '/a.md',
      content: 'x',
      overwrite: true,
    });
    expect(
      translate('edit_file', {
        path: '/a.md',
        old_text: 'foo',
        new_text: 'bar',
        edits: [{ old_text: 'a', new_text: 'b' }],
      }),
    ).toEqual({
      file_path: '/a.md',
      old_string: 'foo',
      new_string: 'bar',
      edits: [{ old_string: 'a', new_string: 'b' }],
    });
    expect(translate('read_file', { intent: 'read', path: '/a.md' })).toEqual({
      intent: 'read',
      file_path: '/a.md',
    });
    expect(translate('bash_tool', { command: 'ls' })).toEqual({ command: 'ls' });
    expect(translate('my_mcp_tool', { path: '/a.md' })).toEqual({ path: '/a.md' });
  });

  test('rejects handlers whose only command targets the wrong host shell', () => {
    const portable: PluginHookHandler = { type: 'command', command: 'echo ok' };
    expect(getShellHandlerIssue(portable, 'win32')).toContain('commandWindows');
    expect(getShellHandlerIssue(portable, 'linux')).toBeUndefined();
    expect(
      getShellHandlerIssue({ ...portable, commandWindows: 'Write-Output ok' }, 'win32'),
    ).toBeUndefined();
    expect(getShellHandlerIssue({ ...portable, shell: 'powershell' }, 'win32')).toBeUndefined();
    expect(getShellHandlerIssue({ type: 'prompt', prompt: 'check' }, 'win32')).toBeUndefined();
    /** A PowerShell-only command cannot run through bash on POSIX hosts. */
    expect(getShellHandlerIssue({ ...portable, shell: 'powershell' }, 'linux')).toContain(
      'commandWindows',
    );
    expect(
      getShellHandlerIssue(
        { ...portable, shell: 'powershell', commandWindows: 'Write-Output ok' },
        'linux',
      ),
    ).toBeUndefined();
  });

  test('skips execution for PowerShell-only handlers on POSIX hosts', async () => {
    const output = await execute({
      type: 'command',
      command: 'Write-Output should-not-run',
      shell: 'powershell',
    });
    expect(output).toEqual({});
  });

  test('leaves matchers for non-tool events untranslated', () => {
    const executor = createCommandExecutor({ pluginRoot, pluginData });
    expect(
      executor.capabilities.translateMatcher?.({
        sourceEvent: 'StopFailure',
        targetEvent: 'StopFailure',
        matcher: '^Bash failed$',
      }),
    ).toBe('^Bash failed$');
  });

  test('returns sanitized JSON stdout and drops host-only or invalid fields', async () => {
    const output = await execute({
      type: 'command',
      command: `printf '%s' '{"decision":"deny","reason":"blocked","injectedMessages":[{"content":"x"}],"allowedDecisions":["approve"],"updatedInput":{"path":"/evil"},"extra":1}'`,
    });
    expect(output).toEqual({ decision: 'deny', reason: 'blocked' });
  });

  test('receives the Claude-shaped payload on stdin', async () => {
    const output = await execute({
      type: 'command',
      command: `node -e 'let d="";process.stdin.on("data",(c)=>{d+=c;}).on("end",()=>{const p=JSON.parse(d);console.log(JSON.stringify({reason:p.tool_name+":"+p.session_id}));});'`,
    });
    expect(output).toEqual({ reason: 'write_file:conversation-1' });
  });

  test('maps exit code 2 to a blocking decision with stderr as the reason', async () => {
    const output = await execute({
      type: 'command',
      command: `echo 'writes to protected paths are refused' >&2; exit 2`,
    });
    expect(output).toEqual({ decision: 'deny', reason: 'writes to protected paths are refused' });
  });

  test('maps exit code 2 on Stop to a block decision', async () => {
    const output = await execute(
      { type: 'command', command: 'exit 2' },
      { sourceEvent: 'Stop', targetEvent: 'Stop' },
    );
    expect(output).toEqual({ decision: 'block' });
  });

  test('maps exit code 2 on events without a decision channel to preventContinuation', async () => {
    const handler: PluginHookHandler = { type: 'command', command: 'echo halted >&2; exit 2' };
    await expect(
      execute(handler, { sourceEvent: 'UserPromptSubmit', targetEvent: 'UserPromptSubmit' }),
    ).resolves.toEqual({ decision: 'deny', reason: 'halted' });
    await expect(
      execute(handler, { sourceEvent: 'PostToolUse', targetEvent: 'PostToolUse' }),
    ).resolves.toEqual({ preventContinuation: true, stopReason: 'halted' });
    await expect(
      execute(handler, { sourceEvent: 'SessionStart', targetEvent: 'RunStart' }),
    ).resolves.toEqual({ preventContinuation: true, stopReason: 'halted' });
  });

  test('tightens ask decisions to deny unless the run supports approvals', async () => {
    const handler: PluginHookHandler = {
      type: 'command',
      command: `printf '%s' '{"decision":"ask","reason":"confirm"}'`,
    };
    await expect(execute(handler)).resolves.toEqual({ decision: 'deny', reason: 'confirm' });
    await expect(
      execute(handler, {}, { PATH: process.env.PATH }, { allowAskDecision: true }),
    ).resolves.toEqual({ decision: 'ask', reason: 'confirm' });
  });

  test('returns an empty output when the payload cannot be serialized', async () => {
    const output = await execute(
      { type: 'command', command: 'echo unreachable' },
      {
        sourceEvent: 'PostToolUse',
        targetEvent: 'PostToolUse',
        payload: {
          hook_event_name: 'PostToolUse',
          session_id: 'conversation-1',
          run_id: 'run-1',
          tool_response: BigInt(1),
        },
      },
    );
    expect(output).toEqual({});
  });

  test('maps Claude legacy decisions per event channel', async () => {
    const handler: PluginHookHandler = {
      type: 'command',
      command: `printf '%s' '{"decision":"block"}'`,
    };
    /** Claude's legacy PreToolUse "block" denies; on Stop it is the stop decision. */
    await expect(execute(handler)).resolves.toEqual({ decision: 'deny' });
    await expect(execute(handler, { sourceEvent: 'Stop', targetEvent: 'Stop' })).resolves.toEqual({
      decision: 'block',
    });
    await expect(
      execute({ type: 'command', command: `printf '%s' '{"decision":"approve"}'` }),
    ).resolves.toEqual({ decision: 'allow' });
    /** "block" on events without a deny channel controls continuation instead. */
    await expect(
      execute(handler, { sourceEvent: 'PostToolUse', targetEvent: 'PostToolUse' }),
    ).resolves.toEqual({ preventContinuation: true });
  });

  test('translates Claude hookSpecificOutput into engine fields', async () => {
    await expect(
      execute({
        type: 'command',
        command: `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"protected path"}}'`,
      }),
    ).resolves.toEqual({ decision: 'deny', reason: 'protected path' });
    /** The ask gate applies to the Claude dialect too. */
    await expect(
      execute({
        type: 'command',
        command: `printf '%s' '{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"confirm"}}'`,
      }),
    ).resolves.toEqual({ decision: 'deny', reason: 'confirm' });
    await expect(
      execute(
        {
          type: 'command',
          command: `printf '%s' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"project notes"}}'`,
        },
        { sourceEvent: 'UserPromptSubmit', targetEvent: 'UserPromptSubmit' },
      ),
    ).resolves.toEqual({ additionalContext: 'project notes' });
    await expect(
      execute({
        type: 'command',
        command: `printf '%s' '{"continue":false,"stopReason":"manual halt"}'`,
      }),
    ).resolves.toEqual({ preventContinuation: true, stopReason: 'manual halt' });
    /** Native fields win when both dialects appear. */
    await expect(
      execute({
        type: 'command',
        command: `printf '%s' '{"decision":"allow","hookSpecificOutput":{"permissionDecision":"deny"}}'`,
      }),
    ).resolves.toEqual({ decision: 'allow' });
  });

  test('translates a structured block into continuation control on post-tool events', async () => {
    const handler: PluginHookHandler = {
      type: 'command',
      command: `printf '%s' '{"decision":"block","reason":"output leaked a secret"}'`,
    };
    await expect(
      execute(handler, { sourceEvent: 'PostToolUse', targetEvent: 'PostToolUse' }),
    ).resolves.toEqual({
      preventContinuation: true,
      reason: 'output leaked a secret',
      stopReason: 'output leaked a secret',
    });
    await expect(
      execute(handler, { sourceEvent: 'PostToolUseFailure', targetEvent: 'PostToolUseFailure' }),
    ).resolves.toEqual({
      preventContinuation: true,
      reason: 'output leaked a secret',
      stopReason: 'output leaked a secret',
    });
  });

  test('rejects native decisions from the other event channel', async () => {
    /** `continue` belongs to the Stop vocabulary; on a tool event it must not
     *  shadow the Claude decision. */
    await expect(
      execute({
        type: 'command',
        command: `printf '%s' '{"decision":"continue","hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"blocked"}}'`,
      }),
    ).resolves.toEqual({ decision: 'deny', reason: 'blocked' });
    /** `ask` belongs to the tool vocabulary and is dropped on Stop. */
    await expect(
      execute(
        { type: 'command', command: `printf '%s' '{"decision":"ask"}'` },
        { sourceEvent: 'Stop', targetEvent: 'Stop' },
      ),
    ).resolves.toEqual({});
  });

  test('falls back to the Claude decision when the native field is malformed', async () => {
    await expect(
      execute({
        type: 'command',
        command: `printf '%s' '{"decision":null,"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"protected"}}'`,
      }),
    ).resolves.toEqual({ decision: 'deny', reason: 'protected' });
    await expect(
      execute({
        type: 'command',
        command: `printf '%s' '{"decision":"maybe","reason":42,"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"unrecognized native"}}'`,
      }),
    ).resolves.toEqual({ decision: 'deny', reason: 'unrecognized native' });
  });

  test('ignores non-blocking failures', async () => {
    const output = await execute({ type: 'command', command: 'echo oops >&2; exit 1' });
    expect(output).toEqual({});
  });

  test('runs from the plugin root with PLUGIN_ROOT, PLUGIN_DATA, and only allowlisted vars', async () => {
    const output = await execute(
      {
        type: 'command',
        command: `printf '{"reason":"%s|%s|%s|%s|%s"}' "$PWD" "$PLUGIN_ROOT" "$PLUGIN_DATA" "$ALLOWED_TOKEN" "\${SECRET_TOKEN:-absent}"`,
        allowedEnvVars: ['ALLOWED_TOKEN', 'PLUGIN_ROOT'],
      },
      {},
      {
        PATH: process.env.PATH,
        ALLOWED_TOKEN: 'granted',
        SECRET_TOKEN: 's3cret',
        PLUGIN_ROOT: '/poisoned/by/host/env',
      },
    );
    expect(output).toEqual({
      reason: `${pluginRoot}|${pluginRoot}|${pluginData}|granted|absent`,
    });
  });

  test('expands PLUGIN_ROOT/PLUGIN_DATA placeholders in the command and binds args to $1..$n', async () => {
    const output = await execute({
      type: 'command',
      command: 'printf \'{"reason":"%s %s"}\' "$1" "${PLUGIN_DATA}"',
      args: ['${PLUGIN_ROOT}/scripts/check.sh'],
    });
    expect(output).toEqual({
      reason: `${path.join(pluginRoot, 'scripts/check.sh')} ${pluginData}`,
    });
  });

  test('expands the Claude plugin-root spelling in commands and the environment', async () => {
    const output = await execute({
      type: 'command',
      command: `printf '{"reason":"%s|%s"}' "\${CLAUDE_PLUGIN_ROOT}/hooks/check.py" "$CLAUDE_PLUGIN_ROOT"`,
    });
    expect(output).toEqual({
      reason: `${path.join(pluginRoot, 'hooks/check.py')}|${pluginRoot}`,
    });
  });

  test('treats non-JSON stdout as context for prompt-shaped events and ignores it elsewhere', async () => {
    const handler: PluginHookHandler = { type: 'command', command: 'echo loaded project notes' };
    await expect(
      execute(handler, { sourceEvent: 'UserPromptSubmit', targetEvent: 'UserPromptSubmit' }),
    ).resolves.toEqual({ additionalContext: 'loaded project notes' });
    await expect(execute(handler)).resolves.toEqual({});
  });

  const isGone = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z';
    } catch {
      return true;
    }
  };
  const waitFor = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!condition() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  test('escalates to a group SIGKILL when a descendant survives SIGTERM past the wrapper', async () => {
    const pidFile = path.join(pluginData, 'survivor.pid');
    const controller = new AbortController();
    const executor = createCommandExecutor({
      pluginRoot,
      pluginData,
      env: { PATH: process.env.PATH },
      killGraceMs: 500,
    });
    /**
     * The descendant redirects its stdio away from the captured pipes so the
     * wrapper's exit emits `close` while the descendant is still alive —
     * exercising the window where a close-time cancellation would skip the
     * group SIGKILL and leak the survivor.
     */
    const pending = executor.execute(
      request({
        type: 'command',
        command: `bash -c 'trap "" TERM; echo $$ > "$PLUGIN_DATA/survivor.pid"; exec >/dev/null 2>&1; while true; do sleep 0.1; done' & wait`,
      }),
      controller.signal,
    );
    await waitFor(() => fs.existsSync(pidFile));
    const survivorPid = Number((await fs.promises.readFile(pidFile, 'utf8')).trim());
    expect(survivorPid).toBeGreaterThan(0);
    controller.abort();
    /** The wrapper exits on SIGTERM while the trap-protected descendant survives. */
    await expect(pending).resolves.toEqual({});
    expect(isGone(survivorPid)).toBe(false);
    await waitFor(() => isGone(survivorPid));
    expect(isGone(survivorPid)).toBe(true);
  });

  test('reaps a pipe-holding worker at root exit instead of stalling until close', async () => {
    const pidFile = path.join(pluginData, 'holder.pid');
    const executor = createCommandExecutor({
      pluginRoot,
      pluginData,
      env: { PATH: process.env.PATH },
      killGraceMs: 250,
    });
    /**
     * The worker keeps the captured pipes open, so `close` cannot fire until
     * it dies — without the exit-time sweep this execution would stall for
     * the worker's full 30s lifetime.
     */
    const output = await executor.execute(
      request({
        type: 'command',
        command: `bash -c 'trap "" TERM; echo $$ > "$PLUGIN_DATA/holder.pid"; sleep 30' & while [ ! -f "$PLUGIN_DATA/holder.pid" ]; do sleep 0.01; done; printf '%s' '{"reason":"scheduled"}'`,
      }),
      new AbortController().signal,
    );
    expect(output).toEqual({ reason: 'scheduled' });
    const holderPid = Number((await fs.promises.readFile(pidFile, 'utf8')).trim());
    expect(holderPid).toBeGreaterThan(0);
    await waitFor(() => isGone(holderPid));
    expect(isGone(holderPid)).toBe(true);
  });

  test('reaps a backgrounded worker that outlives a successful hook', async () => {
    const pidFile = path.join(pluginData, 'worker.pid');
    const executor = createCommandExecutor({
      pluginRoot,
      pluginData,
      env: { PATH: process.env.PATH },
      killGraceMs: 250,
    });
    /**
     * The wrapper waits for the pid file so the worker's trap is set before
     * the exit-time sweep can deliver its SIGTERM.
     */
    const output = await executor.execute(
      request({
        type: 'command',
        command: `bash -c 'trap "" TERM; echo $$ > "$PLUGIN_DATA/worker.pid"; exec >/dev/null 2>&1; while true; do sleep 0.1; done' & while [ ! -f "$PLUGIN_DATA/worker.pid" ]; do sleep 0.01; done; printf '%s' '{"reason":"scheduled"}'`,
      }),
      new AbortController().signal,
    );
    expect(output).toEqual({ reason: 'scheduled' });
    await waitFor(() => fs.existsSync(pidFile));
    const workerPid = Number((await fs.promises.readFile(pidFile, 'utf8')).trim());
    expect(workerPid).toBeGreaterThan(0);
    await waitFor(() => isGone(workerPid));
    expect(isGone(workerPid)).toBe(true);
  });

  test('returns an empty output when the signal aborts a running command', async () => {
    const controller = new AbortController();
    const executor = createCommandExecutor({
      pluginRoot,
      pluginData,
      env: { PATH: process.env.PATH },
    });
    const pending = executor.execute(
      request({ type: 'command', command: 'sleep 30 & wait' }),
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    await expect(pending).resolves.toEqual({});
  });

  test('returns an empty output when the handler has no runnable command', async () => {
    const output = await execute({ type: 'command', command: '   ' });
    expect(output).toEqual({});
  });
});
