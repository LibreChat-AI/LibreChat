import { HookRegistry, executeHooks } from '@librechat/agents';
import { AIMessage } from '@librechat/agents/langchain/messages';
import type { HookOutput } from '@librechat/agents';
import type { PluginHookCapabilities } from './compatibility';
import type { PluginHookExecutor } from './runtime';
import type { PluginHooksDocument } from './schema';
import { createPluginHookPayload, registerPluginHooks } from './runtime';
import { planPluginHooks } from './compatibility';

const commandCapabilities: PluginHookCapabilities = {
  handlerTypes: new Set(['command']),
  translateMatcher: ({ matcher }: { matcher: string }) => matcher,
};

function document(hooks: PluginHooksDocument['hooks']): PluginHooksDocument {
  return { hooks };
}

function executor(output: HookOutput = {}): PluginHookExecutor & {
  execute: jest.Mock<Promise<HookOutput>, Parameters<PluginHookExecutor['execute']>>;
} {
  const execute = jest.fn<Promise<HookOutput>, Parameters<PluginHookExecutor['execute']>>(
    async (_request, _signal) => output,
  );
  return {
    capabilities: {
      ...commandCapabilities,
      handlerTypes: new Set(commandCapabilities.handlerTypes),
    },
    execute,
  };
}

describe('registerPluginHooks', () => {
  test('registers a supported command hook and passes a Claude-shaped payload', async () => {
    const registry = new HookRegistry();
    const hookExecutor = executor({
      decision: 'deny',
      reason: 'Protected path',
      additionalContext: 'Policy checked',
    });
    hookExecutor.capabilities.matchCondition = ({ toolInput }) =>
      typeof toolInput.path === 'string' && toolInput.path.startsWith('/workspace/');
    const registration = registerPluginHooks({
      pluginId: 'security-guidance',
      registry,
      executor: hookExecutor,
      context: {
        sessionId: 'conversation-1',
        cwd: '/workspace',
        permissionMode: 'default',
      },
      document: document({
        PreToolUse: [
          {
            matcher: '^write_file$',
            hooks: [
              {
                type: 'command',
                command: 'check-write',
                if: 'Write(/workspace/**)',
                timeout: 5,
                once: true,
              },
            ],
          },
        ],
      }),
    });

    expect(registration.registered).toBe(1);
    expect(registry.getMatchers('PreToolUse')[0].timeout).toBe(5_000);
    expect(registry.getMatchers('PreToolUse')[0].once).toBeUndefined();

    const result = await executeHooks({
      registry,
      matchQuery: 'write_file',
      input: {
        hook_event_name: 'PreToolUse',
        runId: 'run-1',
        threadId: 'thread-1',
        agentId: 'agent-1',
        toolName: 'write_file',
        toolInput: { path: '/workspace/file.ts' },
        toolUseId: 'tool-1',
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        decision: 'deny',
        reason: 'Protected path',
        additionalContexts: ['Policy checked'],
      }),
    );
    expect(hookExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'security-guidance',
        sourceEvent: 'PreToolUse',
        targetEvent: 'PreToolUse',
        condition: 'Write(/workspace/**)',
        payload: expect.objectContaining({
          hook_event_name: 'PreToolUse',
          session_id: 'conversation-1',
          run_id: 'run-1',
          thread_id: 'thread-1',
          cwd: '/workspace',
          permission_mode: 'default',
          agent_id: 'agent-1',
          tool_name: 'write_file',
          tool_input: { path: '/workspace/file.ts' },
          tool_use_id: 'tool-1',
        }),
      }),
      expect.any(AbortSignal),
    );
  });

  test('registers Claude exact and list matchers without substring matches', async () => {
    const registry = new HookRegistry();
    const hookExecutor = executor();
    const registration = registerPluginHooks({
      pluginId: 'exact-tool-matches',
      registry,
      executor: hookExecutor,
      document: document({
        PreToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [{ type: 'command', command: 'pipe-list-audit' }],
          },
          {
            matcher: 'Edit, Write',
            hooks: [{ type: 'command', command: 'comma-list-audit' }],
          },
        ],
      }),
    });

    const run = async (runId: string, toolName: string): Promise<void> => {
      await executeHooks({
        registry,
        matchQuery: toolName,
        input: {
          hook_event_name: 'PreToolUse',
          runId,
          toolName,
          toolInput: {},
          toolUseId: `tool-${runId}`,
        },
      });
    };

    await run('substring', 'MultiEdit');
    expect(hookExecutor.execute).not.toHaveBeenCalled();

    await run('exact', 'Edit');

    expect(registration.plan.entries.map(({ matcher }) => matcher)).toEqual([
      '^(?:Edit|Write)$',
      '^(?:Edit|Write)$',
    ]);
    expect(hookExecutor.execute).toHaveBeenCalledTimes(2);
  });

  test('applies Claude default timeouts when handlers omit them', () => {
    const registry = new HookRegistry();
    const hookExecutor = executor();
    hookExecutor.capabilities.handlerTypes = new Set(['command', 'prompt']);
    registerPluginHooks({
      pluginId: 'timeout-defaults',
      registry,
      executor: hookExecutor,
      document: document({
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'long-running-check' },
              { type: 'prompt', prompt: 'Verify completion' },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: 'validate-prompt' }],
          },
        ],
      }),
    });

    expect(registry.getMatchers('Stop').map(({ timeout }) => timeout)).toEqual([600_000, 30_000]);
    expect(registry.getMatchers('UserPromptSubmit')[0].timeout).toBe(30_000);
  });

  test('maps LibreChat tool names back into the plugin payload namespace', async () => {
    const registry = new HookRegistry();
    const hookExecutor = executor();
    hookExecutor.capabilities.translateMatcher = () => ({
      matcher: '^bash_tool$',
      requiresToolNameTranslation: true,
    });
    hookExecutor.capabilities.toPluginToolName = ({ toolName }) =>
      toolName === 'bash_tool' ? 'Bash' : toolName;
    registerPluginHooks({
      pluginId: 'tool-name-adapter',
      registry,
      executor: hookExecutor,
      document: document({
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'check-bash' }],
          },
        ],
      }),
    });

    await executeHooks({
      registry,
      matchQuery: 'bash_tool',
      input: {
        hook_event_name: 'PreToolUse',
        runId: 'run-tool-name',
        toolName: 'bash_tool',
        toolInput: { command: 'npm test' },
        toolUseId: 'tool-name-1',
      },
    });

    expect(hookExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ toolName: 'bash_tool' }),
        payload: expect.objectContaining({ tool_name: 'Bash' }),
      }),
      expect.any(AbortSignal),
    );
  });

  test('does not consume a conditional once hook before its condition matches', async () => {
    const registry = new HookRegistry();
    const hookExecutor = executor();
    hookExecutor.capabilities.translateMatcher = () => ({
      matcher: '^bash_tool$',
      requiresToolNameTranslation: true,
    });
    hookExecutor.capabilities.toPluginToolName = ({ toolName }) =>
      toolName === 'bash_tool' ? 'Bash' : toolName;
    hookExecutor.capabilities.matchCondition = ({ toolName, toolInput }) =>
      toolName === 'Bash' &&
      typeof toolInput.command === 'string' &&
      toolInput.command.startsWith('git commit ');
    registerPluginHooks({
      pluginId: 'commit-review',
      registry,
      executor: hookExecutor,
      document: document({
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: 'review-commit',
                if: 'Bash(git commit:*)',
                once: true,
              },
            ],
          },
        ],
      }),
    });

    expect(registry.getMatchers('PreToolUse')[0].once).toBeUndefined();

    const run = async (runId: string, command: string): Promise<void> => {
      await executeHooks({
        registry,
        matchQuery: 'bash_tool',
        input: {
          hook_event_name: 'PreToolUse',
          runId,
          threadId: 'commit-session',
          toolName: 'bash_tool',
          toolInput: { command },
          toolUseId: `tool-${runId}`,
        },
      });
    };

    await run('test', 'npm test');
    await run('commit', 'git commit -m "test"');
    await run('second-commit', 'git commit -m "again"');

    expect(hookExecutor.execute).toHaveBeenCalledTimes(1);
    expect(hookExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        condition: 'Bash(git commit:*)',
        input: expect.objectContaining({ runId: 'commit' }),
      }),
      expect.any(AbortSignal),
    );
  });

  test('scopes once handlers to each plugin session', async () => {
    const registry = new HookRegistry();
    const hookExecutor = executor();
    registerPluginHooks({
      pluginId: 'session-once',
      registry,
      executor: hookExecutor,
      document: document({
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'initialize-write-audit', once: true }],
          },
        ],
      }),
    });

    const run = async (runId: string, threadId: string): Promise<void> => {
      await executeHooks({
        registry,
        matchQuery: 'Write',
        input: {
          hook_event_name: 'PreToolUse',
          runId,
          threadId,
          toolName: 'Write',
          toolInput: { file_path: '/workspace/file.ts' },
          toolUseId: `tool-${runId}`,
        },
      });
    };

    await run('session-a-first', 'session-a');
    await run('session-a-second', 'session-a');
    await run('session-b-first', 'session-b');

    expect(registry.getMatchers('PreToolUse')[0].once).toBeUndefined();
    expect(hookExecutor.execute).toHaveBeenCalledTimes(2);
    expect(hookExecutor.execute.mock.calls.map(([request]) => request.input.threadId)).toEqual([
      'session-a',
      'session-b',
    ]);
  });

  test('shares once state across duplicate overlapping handlers', async () => {
    const registry = new HookRegistry();
    const hookExecutor = executor();
    const duplicateHandler = {
      type: 'command',
      command: 'initialize-write-audit',
      once: true,
    };
    registerPluginHooks({
      pluginId: 'deduplicated-session-once',
      registry,
      executor: hookExecutor,
      document: document({
        PreToolUse: [
          { matcher: '^Write$', hooks: [duplicateHandler] },
          { matcher: '^Wri.*$', hooks: [{ ...duplicateHandler }] },
        ],
      }),
    });

    const run = async (runId: string): Promise<void> => {
      await executeHooks({
        registry,
        matchQuery: 'Write',
        input: {
          hook_event_name: 'PreToolUse',
          runId,
          threadId: 'shared-once-session',
          toolName: 'Write',
          toolInput: { file_path: '/workspace/file.ts' },
          toolUseId: `tool-${runId}`,
        },
      });
    };

    await run('first');
    await run('second');

    expect(hookExecutor.execute).toHaveBeenCalledTimes(1);
  });

  test('keeps once state separate across disjoint matcher declarations', async () => {
    const registry = new HookRegistry();
    const hookExecutor = executor();
    const duplicateHandler = {
      type: 'command',
      command: 'initialize-tool-audit',
      once: true,
    };
    registerPluginHooks({
      pluginId: 'separate-session-once',
      registry,
      executor: hookExecutor,
      document: document({
        PreToolUse: [
          { matcher: '^Write$', hooks: [duplicateHandler] },
          { matcher: '^Bash$', hooks: [{ ...duplicateHandler }] },
        ],
      }),
    });

    const run = async (runId: string, toolName: string): Promise<void> => {
      await executeHooks({
        registry,
        matchQuery: toolName,
        input: {
          hook_event_name: 'PreToolUse',
          runId,
          threadId: 'separate-once-session',
          toolName,
          toolInput: {},
          toolUseId: `tool-${runId}`,
        },
      });
    };

    await run('write-first', 'Write');
    await run('write-second', 'Write');
    await run('bash-first', 'Bash');
    await run('bash-second', 'Bash');

    expect(hookExecutor.execute).toHaveBeenCalledTimes(2);
  });

  test('passes prompt continueOnBlock through to the executor', async () => {
    const registry = new HookRegistry();
    const hookExecutor = executor();
    hookExecutor.capabilities.handlerTypes = new Set(['command', 'prompt']);
    registerPluginHooks({
      pluginId: 'self-correcting-review',
      registry,
      executor: hookExecutor,
      document: document({
        PostToolUse: [
          {
            matcher: 'Write',
            hooks: [
              {
                type: 'prompt',
                prompt: 'Verify this write result',
                continueOnBlock: true,
              },
            ],
          },
        ],
      }),
    });

    await executeHooks({
      registry,
      matchQuery: 'Write',
      input: {
        hook_event_name: 'PostToolUse',
        runId: 'run-write',
        toolName: 'Write',
        toolInput: { file_path: '/workspace/file.ts' },
        toolOutput: 'updated',
        toolUseId: 'tool-write',
      },
    });

    expect(hookExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        handler: expect.objectContaining({ continueOnBlock: true }),
      }),
      expect.any(AbortSignal),
    );
  });

  test('deduplicates identical handlers across overlapping matcher groups', async () => {
    const registry = new HookRegistry();
    const hookExecutor = executor();
    const duplicateHandler = { type: 'command', command: 'audit-write' };
    const registration = registerPluginHooks({
      pluginId: 'deduplicated-hooks',
      registry,
      executor: hookExecutor,
      document: document({
        PreToolUse: [
          { matcher: '^write_file$', hooks: [duplicateHandler] },
          { matcher: '^write_.*$', hooks: [{ ...duplicateHandler }] },
        ],
      }),
    });

    await executeHooks({
      registry,
      matchQuery: 'write_file',
      input: {
        hook_event_name: 'PreToolUse',
        runId: 'run-deduplicate',
        toolName: 'write_file',
        toolInput: { path: '/workspace/file.ts' },
        toolUseId: 'tool-deduplicate',
      },
    });

    expect(registration.registered).toBe(2);
    expect(hookExecutor.execute).toHaveBeenCalledTimes(1);
  });

  test('filters and deduplicates SessionStart while registering RunStart', async () => {
    const registry = new HookRegistry();
    const hookExecutor = executor({ additionalContext: 'Loaded project context' });
    hookExecutor.capabilities.sessionLifecycle = true;
    delete hookExecutor.capabilities.translateMatcher;
    registerPluginHooks({
      pluginId: 'learning-output-style',
      registry,
      executor: hookExecutor,
      context: {
        sessionStartSource: 'resume',
        model: 'claude-sonnet-4-6',
        agentType: 'code-reviewer',
      },
      document: document({
        SessionStart: [
          {
            matcher: 'resume',
            hooks: [{ type: 'command', command: 'load-context' }],
          },
          {
            matcher: 'startup',
            hooks: [{ type: 'command', command: 'do-not-load' }],
          },
        ],
      }),
    });

    const firstResult = await executeHooks({
      registry,
      input: {
        hook_event_name: 'RunStart',
        runId: 'run-2',
        threadId: 'conversation-2',
        messages: [],
      },
    });
    await executeHooks({
      registry,
      input: {
        hook_event_name: 'RunStart',
        runId: 'run-3',
        threadId: 'conversation-2',
        messages: [],
      },
    });

    expect(firstResult.additionalContexts).toEqual(['Loaded project context']);
    expect(hookExecutor.execute).toHaveBeenCalledTimes(1);
    expect(hookExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEvent: 'SessionStart',
        targetEvent: 'RunStart',
        handler: expect.objectContaining({ command: 'load-context' }),
        payload: expect.objectContaining({
          hook_event_name: 'SessionStart',
          session_id: 'conversation-2',
          source: 'resume',
          model: 'claude-sonnet-4-6',
          agent_type: 'code-reviewer',
        }),
      }),
      expect.any(AbortSignal),
    );
  });

  test('runtime-filters compact from wildcard SessionStart hooks', async () => {
    const registry = new HookRegistry();
    const hookExecutor = executor();
    hookExecutor.capabilities.sessionLifecycle = true;
    registerPluginHooks({
      pluginId: 'compact-context',
      registry,
      executor: hookExecutor,
      context: { sessionStartSource: 'compact', model: 'claude-sonnet-4-6' },
      document: document({
        SessionStart: [{ hooks: [{ type: 'command', command: 'load-context' }] }],
      }),
    });

    await executeHooks({
      registry,
      input: {
        hook_event_name: 'RunStart',
        runId: 'run-compact-session',
        threadId: 'conversation-compact-session',
        messages: [],
      },
    });

    expect(hookExecutor.execute).not.toHaveBeenCalled();
  });

  test('shares SessionStart deduplication across overlapping declarations', async () => {
    const registry = new HookRegistry();
    const hookExecutor = executor();
    hookExecutor.capabilities.sessionLifecycle = true;
    delete hookExecutor.capabilities.translateMatcher;
    const duplicateHandler = { type: 'command', command: 'load-context' };
    registerPluginHooks({
      pluginId: 'deduplicated-session-start',
      registry,
      executor: hookExecutor,
      context: { sessionStartSource: 'resume' },
      document: document({
        SessionStart: [
          { matcher: 'startup|resume', hooks: [duplicateHandler] },
          { matcher: 'resume', hooks: [{ ...duplicateHandler }] },
        ],
      }),
    });

    const run = async (runId: string): Promise<void> => {
      await executeHooks({
        registry,
        input: {
          hook_event_name: 'RunStart',
          runId,
          threadId: 'shared-session-start',
          messages: [],
        },
      });
    };

    await run('first');
    await run('second');

    expect(hookExecutor.execute).toHaveBeenCalledTimes(1);
  });

  test('keeps SessionStart state separate across disjoint source declarations', async () => {
    const registry = new HookRegistry();
    const hookExecutor = executor();
    hookExecutor.capabilities.sessionLifecycle = true;
    const context = { sessionStartSource: 'startup' };
    const duplicateHandler = { type: 'command', command: 'load-context' };
    registerPluginHooks({
      pluginId: 'separate-session-start',
      registry,
      executor: hookExecutor,
      context,
      document: document({
        SessionStart: [
          { matcher: 'startup', hooks: [duplicateHandler] },
          { matcher: 'resume', hooks: [{ ...duplicateHandler }] },
        ],
      }),
    });

    const run = async (runId: string): Promise<void> => {
      await executeHooks({
        registry,
        input: {
          hook_event_name: 'RunStart',
          runId,
          threadId: 'separate-session-start',
          messages: [],
        },
      });
    };

    await run('startup');
    context.sessionStartSource = 'resume';
    await run('resume');

    expect(hookExecutor.execute).toHaveBeenCalledTimes(2);
  });

  test('translates compaction matchers and carries the trigger into PostCompact', async () => {
    const registry = new HookRegistry();
    const hookExecutor = executor();
    hookExecutor.capabilities.translateMatcher = ({ matcher }) =>
      matcher === 'auto' ? '^(token_ratio|remaining_tokens|messages_to_refine|default)$' : matcher;
    const registration = registerPluginHooks({
      pluginId: 'compact-audit',
      registry,
      executor: hookExecutor,
      document: document({
        PreCompact: [
          {
            matcher: 'auto',
            hooks: [{ type: 'command', command: 'before-compact' }],
          },
        ],
        PostCompact: [
          {
            matcher: 'auto',
            hooks: [{ type: 'command', command: 'after-compact' }],
          },
        ],
      }),
    });

    await executeHooks({
      registry,
      input: {
        hook_event_name: 'PreCompact',
        runId: 'run-compact',
        threadId: 'conversation-compact',
        trigger: 'token_ratio',
        messagesBeforeCount: 12,
      },
    });
    await executeHooks({
      registry,
      input: {
        hook_event_name: 'PostCompact',
        runId: 'run-compact',
        threadId: 'conversation-compact',
        summary: 'Compacted context',
        messagesAfterCount: 0,
      },
    });

    expect(registration.registered).toBe(2);
    expect(registry.getMatchers('PreCompact')).toHaveLength(2);
    expect(registry.getMatchers('PostCompact')).toHaveLength(2);
    expect(hookExecutor.execute).toHaveBeenCalledTimes(2);
    expect(hookExecutor.execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sourceEvent: 'PreCompact',
        payload: expect.objectContaining({
          hook_event_name: 'PreCompact',
          trigger: 'auto',
          messages_before_count: 12,
        }),
      }),
      expect.any(AbortSignal),
    );
    expect(hookExecutor.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sourceEvent: 'PostCompact',
        payload: expect.objectContaining({
          hook_event_name: 'PostCompact',
          trigger: 'auto',
          compact_summary: 'Compacted context',
          messages_after_count: 0,
        }),
      }),
      expect.any(AbortSignal),
    );

    await executeHooks({
      registry,
      input: {
        hook_event_name: 'PostCompact',
        runId: 'run-compact',
        threadId: 'conversation-compact',
        summary: 'No matching trigger',
        messagesAfterCount: 0,
      },
    });
    expect(hookExecutor.execute).toHaveBeenCalledTimes(2);

    registration.unregister();
    expect(registry.getMatchers('PreCompact')).toHaveLength(0);
    expect(registry.getMatchers('PostCompact')).toHaveLength(0);
  });

  test('translates batch entries and preserves the PostToolUseFailure error field', () => {
    const batchPayload = createPluginHookPayload('PostToolBatch', {
      hook_event_name: 'PostToolBatch',
      runId: 'run-batch',
      entries: [
        {
          toolName: 'Read',
          toolInput: { file_path: '/workspace/file.ts' },
          toolUseId: 'tool-success',
          toolOutput: 'file contents',
          status: 'success',
        },
        {
          toolName: 'Bash',
          toolInput: { command: 'exit 1' },
          toolUseId: 'tool-failure',
          error: 'Command failed',
          status: 'error',
        },
      ],
    });
    const failurePayload = createPluginHookPayload('PostToolUseFailure', {
      hook_event_name: 'PostToolUseFailure',
      runId: 'run-failure',
      toolName: 'Bash',
      toolInput: { command: 'exit 1' },
      toolUseId: 'tool-failure',
      error: 'Command failed',
    });

    expect(batchPayload.tool_calls).toEqual([
      {
        tool_name: 'Read',
        tool_input: { file_path: '/workspace/file.ts' },
        tool_use_id: 'tool-success',
        tool_response: 'file contents',
      },
      {
        tool_name: 'Bash',
        tool_input: { command: 'exit 1' },
        tool_use_id: 'tool-failure',
        tool_response: 'Command failed',
      },
    ]);
    expect(batchPayload).not.toHaveProperty('entries');
    expect(failurePayload).toEqual(
      expect.objectContaining({
        hook_event_name: 'PostToolUseFailure',
        error: 'Command failed',
      }),
    );
    expect(failurePayload).not.toHaveProperty('tool_error');
  });

  test('emits the documented SubagentStart identity fields', () => {
    const payload = createPluginHookPayload('SubagentStart', {
      hook_event_name: 'SubagentStart',
      runId: 'run-subagent',
      parentAgentId: 'agent-parent',
      agentId: 'agent-child',
      agentType: 'Explore',
      inputs: [],
    });

    expect(payload).toEqual(
      expect.objectContaining({
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-child',
        agent_type: 'Explore',
      }),
    );
  });

  test('includes StopFailure assistant text when the SDK provides it', () => {
    const payload = createPluginHookPayload('StopFailure', {
      hook_event_name: 'StopFailure',
      runId: 'run-stop-failure',
      error: 'Model response could not be parsed',
      lastAssistantMessage: new AIMessage('Partial assistant response'),
    });

    expect(payload).toEqual(
      expect.objectContaining({
        hook_event_name: 'StopFailure',
        error: 'Model response could not be parsed',
        last_assistant_message: 'Partial assistant response',
      }),
    );
  });

  test('filters StopFailure matchers against the runtime error', async () => {
    const registry = new HookRegistry();
    const hookExecutor = executor();
    const registration = registerPluginHooks({
      pluginId: 'failure-audit',
      registry,
      executor: hookExecutor,
      document: document({
        StopFailure: [
          {
            matcher: 'rate_limit|overloaded',
            hooks: [{ type: 'command', command: 'record-failure' }],
          },
        ],
      }),
    });

    expect(registration.registered).toBe(1);
    expect(registry.getMatchers('StopFailure')[0].pattern).toBeUndefined();

    await executeHooks({
      registry,
      input: {
        hook_event_name: 'StopFailure',
        runId: 'run-auth-failure',
        error: 'authentication_failed',
      },
    });
    await executeHooks({
      registry,
      input: {
        hook_event_name: 'StopFailure',
        runId: 'run-rate-limit',
        error: 'rate_limit',
      },
    });

    expect(hookExecutor.execute).toHaveBeenCalledTimes(1);
    expect(hookExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEvent: 'StopFailure',
        targetEvent: 'StopFailure',
        payload: expect.objectContaining({
          hook_event_name: 'StopFailure',
          error: 'rate_limit',
        }),
      }),
      expect.any(AbortSignal),
    );
  });

  test('registers the event surface used by the official hookify plugin', () => {
    const registry = new HookRegistry();
    const registration = registerPluginHooks({
      pluginId: 'hookify',
      registry,
      executor: executor(),
      document: document({
        PreToolUse: [{ hooks: [{ type: 'command', command: 'pretooluse.py' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'posttooluse.py' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'stop.py' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'userpromptsubmit.py' }] }],
      }),
    });

    expect(registration.registered).toBe(4);
    expect(registration.plan.summary).toEqual({ declared: 4, ready: 4, unsupported: 0 });
    expect(registry.getMatchers('PreToolUse')).toHaveLength(1);
    expect(registry.getMatchers('PostToolUse')).toHaveLength(1);
    expect(registry.getMatchers('Stop')).toHaveLength(1);
    expect(registry.getMatchers('UserPromptSubmit')).toHaveLength(1);
  });

  test('leaves unsupported declarations in the plan without registering them', () => {
    const registry = new HookRegistry();
    const registration = registerPluginHooks({
      pluginId: 'mixed-plugin',
      registry,
      executor: executor(),
      document: document({
        UserPromptExpansion: [{ hooks: [{ type: 'command', command: 'banner' }] }],
        Stop: [{ hooks: [{ type: 'prompt', prompt: 'Verify completion' }] }],
      }),
    });

    expect(registration.registered).toBe(0);
    expect(registration.plan.summary.unsupported).toBe(2);
    expect(registry.getMatchers('Stop')).toHaveLength(0);
  });

  test('registers from a supplied load-time plan without re-planning', () => {
    const registry = new HookRegistry();
    const hookExecutor = executor();
    const planned = document({
      Stop: [{ hooks: [{ type: 'command', command: 'stop-hook.sh' }] }],
    });
    const plan = planPluginHooks(planned, hookExecutor.capabilities);
    const registration = registerPluginHooks({
      pluginId: 'planned-plugin',
      registry,
      executor: hookExecutor,
      /** An empty document proves the supplied plan, not the document, drives registration. */
      document: document({}),
      plan,
    });

    expect(registration.plan).toBe(plan);
    expect(registration.registered).toBe(1);
    expect(registry.getMatchers('Stop')).toHaveLength(1);
  });

  test('unregisters only this plugin registration and is idempotent', () => {
    const registry = new HookRegistry();
    const existing = jest.fn(async () => ({}));
    registry.register('Stop', { hooks: [existing] });
    const registration = registerPluginHooks({
      pluginId: 'ralph-loop',
      registry,
      executor: executor(),
      document: document({
        Stop: [{ hooks: [{ type: 'command', command: 'stop-hook.sh' }] }],
      }),
    });

    expect(registry.getMatchers('Stop')).toHaveLength(2);
    registration.unregister();
    registration.unregister();
    expect(registry.getMatchers('Stop')).toHaveLength(1);
    expect(registry.getMatchers('Stop')[0].hooks[0]).toBe(existing);
  });
});
