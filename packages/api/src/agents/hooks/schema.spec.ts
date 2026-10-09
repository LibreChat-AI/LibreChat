import { MAX_PATTERN_LENGTH } from '@librechat/agents';
import { parsePluginHooks } from './schema';

describe('parsePluginHooks', () => {
  test('parses the plugin hooks wrapper used by Claude and Codex', () => {
    const result = parsePluginHooks({
      description: 'Guard file writes',
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write|Edit',
            hooks: [
              {
                type: 'command',
                command: 'python3 "${CLAUDE_PLUGIN_ROOT}/hooks/check.py"',
                timeout: 10,
              },
            ],
          },
        ],
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.document.hooks.PreToolUse[0].hooks[0]).toEqual({
      type: 'command',
      command: 'python3 "${CLAUDE_PLUGIN_ROOT}/hooks/check.py"',
      timeout: 10,
    });
  });

  test('rejects a direct settings-style event map without the plugin wrapper', () => {
    const result = parsePluginHooks({
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'check' }] }],
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'hooks' })]),
    );
  });

  test('rejects command handlers without a command', () => {
    const result = parsePluginHooks({
      hooks: {
        Stop: [{ hooks: [{ type: 'command' }] }],
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'hooks.Stop.0.hooks.0.command',
          message: 'Command hooks require a non-empty command',
        }),
      ]),
    );
  });

  test('rejects prompt handlers without a prompt', () => {
    const result = parsePluginHooks({
      hooks: {
        Stop: [{ hooks: [{ type: 'prompt' }] }],
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'hooks.Stop.0.hooks.0.prompt',
          message: 'Prompt hooks require a non-empty prompt',
        }),
      ]),
    );
  });

  test('retains compatibility modifiers needed by the planner', () => {
    const result = parsePluginHooks({
      hooks: {
        PostToolUse: [
          {
            matcher: ' Bash ',
            hooks: [
              {
                type: 'command',
                command: 'review',
                if: ' Bash(git commit:*) ',
                asyncRewake: true,
                rewakeMessage: 'Review these findings',
                rewakeSummary: 'Review complete',
                continueOnBlock: true,
              },
            ],
          },
        ],
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.document.hooks.PostToolUse[0]).toEqual({
      matcher: 'Bash',
      hooks: [
        {
          type: 'command',
          command: 'review',
          if: 'Bash(git commit:*)',
          asyncRewake: true,
          rewakeMessage: 'Review these findings',
          rewakeSummary: 'Review complete',
          continueOnBlock: true,
        },
      ],
    });
  });

  test('retains official command and prompt handler options', () => {
    const result = parsePluginHooks({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: 'verify',
                args: ['--mode', 'strict'],
                shell: 'bash',
                once: true,
              },
              {
                type: 'prompt',
                prompt: 'Check whether the task is complete',
                model: 'claude-sonnet-4-5',
              },
            ],
          },
        ],
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.document.hooks.Stop[0].hooks).toEqual([
      {
        type: 'command',
        command: 'verify',
        args: ['--mode', 'strict'],
        shell: 'bash',
        once: true,
      },
      {
        type: 'prompt',
        prompt: 'Check whether the task is complete',
        model: 'claude-sonnet-4-5',
      },
    ]);
  });

  test('retains schema metadata and known handlers for compatibility planning', () => {
    const result = parsePluginHooks({
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: 'verify',
              },
              {
                type: 'http',
                url: 'https://hooks.example.com/pre-tool',
                headers: { Authorization: 'Bearer ${HOOK_TOKEN}' },
                allowedEnvVars: ['HOOK_TOKEN'],
              },
              {
                type: 'mcp_tool',
                server: 'policy',
                tool: 'validate',
                input: { strict: true },
              },
              {
                type: 'agent',
                prompt: 'Review this tool call',
                model: 'claude-sonnet-4-5',
              },
            ],
          },
        ],
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.document.$schema).toBe('https://json.schemastore.org/claude-code-settings.json');
    expect(result.document.hooks.PreToolUse[0].hooks).toEqual([
      {
        type: 'command',
        command: 'verify',
      },
      {
        type: 'http',
        url: 'https://hooks.example.com/pre-tool',
        headers: { Authorization: 'Bearer ${HOOK_TOKEN}' },
        allowedEnvVars: ['HOOK_TOKEN'],
      },
      {
        type: 'mcp_tool',
        server: 'policy',
        tool: 'validate',
        input: { strict: true },
      },
      {
        type: 'agent',
        prompt: 'Review this tool call',
        model: 'claude-sonnet-4-5',
      },
    ]);
  });

  test('rejects blank conditions and oversized matchers', () => {
    const blankCondition = parsePluginHooks({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'review', if: '   ' }],
          },
        ],
      },
    });
    const oversizedMatcher = parsePluginHooks({
      hooks: {
        PostToolUse: [
          {
            matcher: 'a'.repeat(MAX_PATTERN_LENGTH + 1),
            hooks: [{ type: 'command', command: 'review' }],
          },
        ],
      },
    });

    expect(blankCondition.success).toBe(false);
    expect(oversizedMatcher.success).toBe(false);
    if (blankCondition.success || oversizedMatcher.success) {
      return;
    }
    expect(blankCondition.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'hooks.PostToolUse.0.hooks.0.if' })]),
    );
    expect(oversizedMatcher.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'hooks.PostToolUse.0.matcher' })]),
    );
  });

  test('rejects unrecognized behavior instead of silently stripping it', () => {
    const result = parsePluginHooks({
      hooks: {
        Stop: [
          {
            hooks: [{ type: 'command', command: 'verify', futureMode: 'detached' }],
          },
        ],
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'hooks.Stop.0.hooks.0',
          message: expect.stringContaining('futureMode'),
        }),
      ]),
    );
  });
});
