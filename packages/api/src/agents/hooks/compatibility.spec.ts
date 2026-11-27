import type { PluginHookCapabilities } from './compatibility';
import type { PluginHooksDocument } from './schema';
import { planPluginHooks } from './compatibility';

const commandCapabilities: PluginHookCapabilities = {
  handlerTypes: new Set(['command']),
  translateMatcher: ({ matcher }: { matcher: string }) => matcher,
};

function document(hooks: PluginHooksDocument['hooks']): PluginHooksDocument {
  return { hooks };
}

describe('planPluginHooks', () => {
  test('maps the common Claude lifecycle events directly', () => {
    const plan = planPluginHooks(
      document({
        PreToolUse: [{ matcher: '^write_file$', hooks: [{ type: 'command', command: 'check' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'record' }] }],
        Stop: [{ matcher: '.*', hooks: [{ type: 'command', command: 'verify' }] }],
      }),
      commandCapabilities,
    );

    expect(plan.summary).toEqual({ declared: 3, ready: 3, unsupported: 0 });
    expect(
      plan.entries.map(({ sourceEvent, targetEvent, matcher }) => ({
        sourceEvent,
        targetEvent,
        matcher,
      })),
    ).toEqual([
      { sourceEvent: 'PreToolUse', targetEvent: 'PreToolUse', matcher: '^write_file$' },
      { sourceEvent: 'PostToolUse', targetEvent: 'PostToolUse', matcher: undefined },
      { sourceEvent: 'Stop', targetEvent: 'Stop', matcher: undefined },
    ]);
  });

  test('gives matcherless tool declarations the document namespace', () => {
    const plan = planPluginHooks(
      document({
        PreToolUse: [{ hooks: [{ type: 'command', command: 'audit' }] }],
        PostToolBatch: [{ hooks: [{ type: 'command', command: 'record' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'verify' }] }],
      }),
      {
        handlerTypes: new Set(['command']),
        translateMatcher: ({ matcher }: { matcher: string }) => matcher,
        toPluginToolName: ({ toolName }) => toolName,
      },
    );

    expect(plan.summary.ready).toBe(3);
    expect(
      plan.entries.map(({ targetEvent, requiresToolNameTranslation, translatedToolNames }) => ({
        targetEvent,
        requiresToolNameTranslation,
        translatedToolNames,
      })),
    ).toEqual([
      {
        targetEvent: 'PreToolUse',
        requiresToolNameTranslation: true,
        translatedToolNames: undefined,
      },
      {
        targetEvent: 'PostToolBatch',
        requiresToolNameTranslation: true,
        translatedToolNames: undefined,
      },
      {
        targetEvent: 'Stop',
        requiresToolNameTranslation: undefined,
        translatedToolNames: undefined,
      },
    ]);
  });

  test('marks handlers unsupported when the executor rejects them for the host', () => {
    const plan = planPluginHooks(
      document({
        PreToolUse: [
          { matcher: '^write_file$', hooks: [{ type: 'command', command: 'check' }] },
          {
            matcher: '^read_file$',
            hooks: [{ type: 'command', command: 'check', commandWindows: 'check.ps1' }],
          },
        ],
      }),
      {
        handlerTypes: new Set(['command']),
        translateMatcher: ({ matcher }: { matcher: string }) => matcher,
        supportsHandler: ({ handler }) =>
          handler.commandWindows === undefined ? 'host requires commandWindows' : undefined,
      },
    );

    expect(plan.summary).toEqual({ declared: 2, ready: 1, unsupported: 1 });
    expect(plan.entries[0].status).toBe('unsupported');
    expect(plan.entries[0].issues).toEqual([
      expect.objectContaining({
        code: 'unsupported_handler',
        severity: 'error',
        message: 'host requires commandWindows',
      }),
    ]);
    expect(plan.entries[1].status).toBe('ready');
  });

  test('maps SessionStart to RunStart with an explicit lifecycle warning', () => {
    const plan = planPluginHooks(
      document({
        SessionStart: [
          { matcher: 'resume', hooks: [{ type: 'command', command: 'load-context' }] },
        ],
      }),
      { handlerTypes: new Set(['command']), sessionLifecycle: true },
    );

    expect(plan.summary.ready).toBe(1);
    expect(plan.entries[0]).toEqual(
      expect.objectContaining({
        sourceEvent: 'SessionStart',
        targetEvent: 'RunStart',
        sourceMatcher: 'resume',
        matcher: '^(?:resume)$',
        status: 'ready',
        issues: [
          expect.objectContaining({
            code: 'event_alias',
            severity: 'warning',
          }),
        ],
      }),
    );
  });

  test('normalizes Claude exact and list matchers while preserving regex matchers', () => {
    const translatedMatchers: string[] = [];
    const plan = planPluginHooks(
      document({
        PreToolUse: [
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'pipe-list' }] },
          { matcher: 'Edit, Write', hooks: [{ type: 'command', command: 'comma-list' }] },
          {
            matcher: 'mcp__.*__write.*',
            hooks: [{ type: 'command', command: 'regex-pattern' }],
          },
        ],
        SessionStart: [
          { matcher: 'startup, resume', hooks: [{ type: 'command', command: 'load-context' }] },
        ],
        SubagentStart: [
          { matcher: 'code-reviewer', hooks: [{ type: 'command', command: 'track-agent' }] },
        ],
        StopFailure: [
          {
            matcher: 'rate_limit, overloaded',
            hooks: [{ type: 'command', command: 'track-failure' }],
          },
        ],
      }),
      {
        ...commandCapabilities,
        sessionLifecycle: true,
        translateMatcher: ({ matcher }) => {
          translatedMatchers.push(matcher);
          return matcher;
        },
      },
    );

    expect(plan.summary).toEqual({ declared: 6, ready: 6, unsupported: 0 });
    expect(plan.entries.map(({ sourceMatcher, matcher }) => ({ sourceMatcher, matcher }))).toEqual([
      { sourceMatcher: 'Edit|Write', matcher: '^(?:Edit|Write)$' },
      { sourceMatcher: 'Edit, Write', matcher: '^(?:Edit|Write)$' },
      { sourceMatcher: 'mcp__.*__write.*', matcher: 'mcp__.*__write.*' },
      { sourceMatcher: 'startup, resume', matcher: '^(?:startup|resume)$' },
      { sourceMatcher: 'code-reviewer', matcher: '^(?:code-reviewer)$' },
      { sourceMatcher: 'rate_limit, overloaded', matcher: 'rate_limit, overloaded' },
    ]);
    expect(translatedMatchers).toEqual([
      'Edit|Write',
      'Edit|Write',
      'mcp__.*__write.*',
      'code-reviewer',
      'rate_limit, overloaded',
    ]);
  });

  test('fails closed for SessionStart compact matchers', () => {
    const plan = planPluginHooks(
      document({
        SessionStart: [
          { matcher: 'compact', hooks: [{ type: 'command', command: 'reload-context' }] },
        ],
      }),
      { handlerTypes: new Set(['command']), sessionLifecycle: true },
    );

    expect(plan.summary).toEqual({ declared: 1, ready: 0, unsupported: 1 });
    expect(plan.entries[0]).toEqual(
      expect.objectContaining({
        sourceEvent: 'SessionStart',
        targetEvent: 'RunStart',
        status: 'unsupported',
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'unsupported_session_source',
            severity: 'error',
          }),
        ]),
      }),
    );
  });

  test('fails closed for SessionStart clear matchers, which no run path emits', () => {
    const plan = planPluginHooks(
      document({
        SessionStart: [
          { matcher: 'resume|clear', hooks: [{ type: 'command', command: 'reload-context' }] },
        ],
      }),
      { handlerTypes: new Set(['command']), sessionLifecycle: true },
    );

    expect(plan.summary).toEqual({ declared: 1, ready: 0, unsupported: 1 });
    expect(plan.entries[0]).toEqual(
      expect.objectContaining({
        status: 'unsupported',
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'unsupported_session_source',
            severity: 'error',
            message: expect.stringContaining('"clear"'),
          }),
        ]),
      }),
    );
  });

  test('keeps wildcard SessionStart ready while reporting compact as filtered', () => {
    const plan = planPluginHooks(
      document({
        SessionStart: [{ hooks: [{ type: 'command', command: 'load-context' }] }],
      }),
      { handlerTypes: new Set(['command']), sessionLifecycle: true },
    );

    expect(plan.summary).toEqual({ declared: 1, ready: 1, unsupported: 0 });
    expect(plan.entries[0].issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unsupported_session_source',
          severity: 'warning',
        }),
      ]),
    );
  });

  test('plans translated compaction-trigger matchers', () => {
    const plan = planPluginHooks(
      document({
        PreCompact: [{ matcher: 'auto', hooks: [{ type: 'command', command: 'before' }] }],
        PostCompact: [{ matcher: 'manual', hooks: [{ type: 'command', command: 'after' }] }],
      }),
      {
        handlerTypes: new Set(['command']),
        translateMatcher: ({ matcher }) =>
          matcher === 'auto'
            ? '^(token_ratio|remaining_tokens|messages_to_refine|default)$'
            : '^manual$',
      },
    );

    expect(plan.summary).toEqual({ declared: 2, ready: 2, unsupported: 0 });
    expect(plan.entries).toEqual([
      expect.objectContaining({
        sourceEvent: 'PreCompact',
        sourceMatcher: 'auto',
        matcher: '^(?:^(token_ratio|remaining_tokens|messages_to_refine|default)$)$',
        status: 'ready',
      }),
      expect.objectContaining({
        sourceEvent: 'PostCompact',
        sourceMatcher: 'manual',
        matcher: '^(?:^manual$)$',
        status: 'ready',
      }),
    ]);
  });

  test('plans StopFailure matchers against translated error names', () => {
    const plan = planPluginHooks(
      document({
        StopFailure: [
          {
            matcher: 'rate_limit|overloaded',
            hooks: [{ type: 'command', command: 'record-failure' }],
          },
        ],
      }),
      commandCapabilities,
    );

    expect(plan.summary).toEqual({ declared: 1, ready: 1, unsupported: 0 });
    expect(plan.entries[0]).toEqual(
      expect.objectContaining({
        sourceEvent: 'StopFailure',
        targetEvent: 'StopFailure',
        sourceMatcher: 'rate_limit|overloaded',
        matcher: '^(?:rate_limit|overloaded)$',
        status: 'ready',
      }),
    );
  });

  test('does not activate events whose Claude control surfaces are unavailable', () => {
    const plan = planPluginHooks(
      document({
        SubagentStop: [{ hooks: [{ type: 'command', command: 'verify' }] }],
        PermissionDenied: [{ hooks: [{ type: 'command', command: 'retry' }] }],
      }),
      commandCapabilities,
    );

    expect(plan.summary).toEqual({ declared: 2, ready: 0, unsupported: 2 });
    expect(plan.entries[0]).toEqual(
      expect.objectContaining({
        sourceEvent: 'SubagentStop',
        targetEvent: 'SubagentStop',
        status: 'unsupported',
        issues: [
          expect.objectContaining({
            code: 'unsupported_event_payload',
            severity: 'error',
          }),
        ],
      }),
    );
    expect(plan.entries[1]).toEqual(
      expect.objectContaining({
        sourceEvent: 'PermissionDenied',
        targetEvent: 'PermissionDenied',
        status: 'unsupported',
        issues: [
          expect.objectContaining({
            code: 'unsupported_event_output',
            severity: 'error',
          }),
        ],
      }),
    );
  });

  test('does not silently activate events or handler types the runtime cannot execute', () => {
    const plan = planPluginHooks(
      document({
        UserPromptExpansion: [{ hooks: [{ type: 'command', command: 'banner' }] }],
        StopFinalize: [{ hooks: [{ type: 'command', command: 'intercept-finalization' }] }],
        Stop: [{ hooks: [{ type: 'prompt', prompt: 'Verify completion' }] }],
      }),
      commandCapabilities,
    );

    expect(plan.summary).toEqual({ declared: 3, ready: 0, unsupported: 3 });
    expect(plan.entries[0].issues).toEqual([
      expect.objectContaining({ code: 'unsupported_event' }),
    ]);
    expect(plan.entries[1].issues).toEqual([
      expect.objectContaining({ code: 'unsupported_event' }),
    ]);
    expect(plan.entries[2].issues).toEqual([
      expect.objectContaining({ code: 'unsupported_handler' }),
    ]);
  });

  test('keeps known unsupported handler declarations in a mixed compatibility plan', () => {
    const plan = planPluginHooks(
      document({
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'verify' },
              { type: 'http', url: 'https://hooks.example.com/stop' },
              { type: 'mcp_tool', server: 'policy', tool: 'validate', input: { strict: true } },
              { type: 'agent', prompt: 'Review completion', model: 'claude-sonnet-4-5' },
            ],
          },
        ],
      }),
      commandCapabilities,
    );

    expect(plan.summary).toEqual({ declared: 4, ready: 1, unsupported: 3 });
    expect(plan.entries[0].status).toBe('ready');
    expect(plan.entries.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          handler: expect.objectContaining({ type: 'http' }),
          status: 'unsupported',
          issues: [expect.objectContaining({ code: 'unsupported_handler' })],
        }),
        expect.objectContaining({
          handler: expect.objectContaining({ type: 'mcp_tool' }),
          status: 'unsupported',
          issues: [expect.objectContaining({ code: 'unsupported_handler' })],
        }),
        expect.objectContaining({
          handler: expect.objectContaining({ type: 'agent' }),
          status: 'unsupported',
          issues: [expect.objectContaining({ code: 'unsupported_handler' })],
        }),
      ]),
    );
  });

  test('preserves continueOnBlock for supported prompt handlers', () => {
    const plan = planPluginHooks(
      document({
        PostToolUse: [
          {
            hooks: [
              {
                type: 'prompt',
                prompt: 'Review this tool result',
                continueOnBlock: true,
              },
            ],
          },
        ],
        PreToolUse: [
          {
            hooks: [
              {
                type: 'prompt',
                prompt: 'Verify this tool call',
                continueOnBlock: true,
              },
            ],
          },
        ],
      }),
      {
        ...commandCapabilities,
        handlerTypes: new Set(['command', 'prompt']),
      },
    );

    expect(plan.summary).toEqual({ declared: 2, ready: 2, unsupported: 0 });
    expect(plan.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'ready',
          handler: expect.objectContaining({ continueOnBlock: true }),
        }),
      ]),
    );
  });

  test('rejects continueOnBlock on non-prompt handlers', () => {
    const plan = planPluginHooks(
      document({
        PostToolUse: [
          {
            hooks: [{ type: 'command', command: 'verify-output', continueOnBlock: true }],
          },
        ],
      }),
      commandCapabilities,
    );

    expect(plan.summary).toEqual({ declared: 1, ready: 0, unsupported: 1 });
    expect(plan.entries[0].issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unsupported_continue_on_block',
          severity: 'error',
        }),
      ]),
    );
  });

  test('rejects prompt handlers on events that do not support them', () => {
    const plan = planPluginHooks(
      document({
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [{ type: 'prompt', prompt: 'Load context' }],
          },
        ],
        StopFailure: [{ hooks: [{ type: 'prompt', prompt: 'Classify the failure' }] }],
      }),
      {
        handlerTypes: new Set(['command', 'prompt']),
        sessionLifecycle: true,
      },
    );

    expect(plan.summary).toEqual({ declared: 2, ready: 0, unsupported: 2 });
    for (const entry of plan.entries) {
      expect(entry.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'unsupported_handler_event',
            severity: 'error',
          }),
        ]),
      );
    }
  });

  test('rejects conditional, async-rewake, and unsafe matcher semantics by default', () => {
    const plan = planPluginHooks(
      document({
        RunStart: [
          {
            matcher: 'startup',
            hooks: [{ type: 'command', command: 'load' }],
          },
        ],
        PostToolUse: [
          {
            matcher: '(a+)+',
            hooks: [
              {
                type: 'command',
                command: 'review',
                if: 'Bash(git commit:*)',
                async: true,
                asyncRewake: true,
              },
            ],
          },
        ],
      }),
      commandCapabilities,
    );

    expect(plan.summary.unsupported).toBe(2);
    expect(plan.entries[0].issues).toEqual([
      expect.objectContaining({ code: 'unsupported_matcher' }),
    ]);
    expect(plan.entries[1].issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_matcher' }),
        expect.objectContaining({ code: 'unsupported_condition' }),
        expect.objectContaining({ code: 'unsupported_async' }),
        expect.objectContaining({ code: 'unsupported_async_rewake' }),
      ]),
    );
  });

  test('requires explicit matcher and session-lifecycle adapters', () => {
    const plan = planPluginHooks(
      document({
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'load' }] }],
      }),
      { handlerTypes: new Set(['command']) },
    );

    expect(plan.summary).toEqual({ declared: 2, ready: 0, unsupported: 2 });
    expect(plan.entries[0].issues).toEqual([expect.objectContaining({ code: 'unmapped_matcher' })]);
    expect(plan.entries[1].issues).toEqual([
      expect.objectContaining({ code: 'unsupported_session_lifecycle' }),
    ]);
  });

  test('records matcher translation without losing the source declaration', () => {
    const plan = planPluginHooks(
      document({
        PreToolUse: [{ matcher: ' Bash|Write ', hooks: [{ type: 'command', command: 'check' }] }],
      }),
      {
        handlerTypes: new Set(['command']),
        translateMatcher: () => '^(bash_tool|create_file)$',
        toPluginToolName: ({ toolName }) => toolName,
      },
    );

    expect(plan.entries[0]).toEqual(
      expect.objectContaining({
        sourceMatcher: 'Bash|Write',
        matcher: '^(?:^(bash_tool|create_file)$)$',
        status: 'ready',
        issues: [expect.objectContaining({ code: 'matcher_translated', severity: 'warning' })],
      }),
    );
  });

  test('keeps invalid authored regex matchers unsupported after a valid translation', () => {
    const plan = planPluginHooks(
      document({
        PreToolUse: [{ matcher: '[invalid', hooks: [{ type: 'command', command: 'check' }] }],
      }),
      {
        handlerTypes: new Set(['command']),
        translateMatcher: () => '^bash_tool$',
      },
    );

    expect(plan.summary).toEqual({ declared: 1, ready: 0, unsupported: 1 });
    expect(plan.entries[0]).toEqual(
      expect.objectContaining({
        sourceMatcher: '[invalid',
        matcher: '^bash_tool$',
        status: 'unsupported',
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'invalid_matcher', severity: 'error' }),
          expect.objectContaining({ code: 'matcher_translated', severity: 'warning' }),
        ]),
      }),
    );
  });

  test('requires reverse tool-name translation when matcher namespaces differ', () => {
    const plan = planPluginHooks(
      document({
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check' }] }],
      }),
      {
        handlerTypes: new Set(['command']),
        translateMatcher: () => ({
          matcher: '^bash_tool$',
          requiresToolNameTranslation: true,
        }),
      },
    );

    expect(plan.summary).toEqual({ declared: 1, ready: 0, unsupported: 1 });
    expect(plan.entries[0].issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'matcher_translated', severity: 'warning' }),
        expect.objectContaining({ code: 'unmapped_tool_name', severity: 'error' }),
      ]),
    );
  });

  test('allows regex-only matcher rewrites without reverse tool-name mapping', () => {
    const plan = planPluginHooks(
      document({
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check' }] }],
      }),
      {
        handlerTypes: new Set(['command']),
        translateMatcher: () => '^Bash$',
      },
    );

    expect(plan.summary).toEqual({ declared: 1, ready: 1, unsupported: 0 });
    expect(plan.entries[0]).toEqual(
      expect.objectContaining({
        matcher: '^(?:^Bash$)$',
        status: 'ready',
        issues: [expect.objectContaining({ code: 'matcher_translated', severity: 'warning' })],
      }),
    );
  });

  test('plans current handler-level conditions independently', () => {
    const plan = planPluginHooks(
      document({
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: 'review-commit',
                if: 'Bash(git commit:*)',
              },
              {
                type: 'command',
                command: 'record-all',
              },
            ],
          },
        ],
      }),
      {
        handlerTypes: new Set(['command']),
        translateMatcher: () => '^bash_tool$',
        toPluginToolName: ({ toolName }) => toolName,
      },
    );

    expect(plan.summary).toEqual({ declared: 2, ready: 1, unsupported: 1 });
    expect(plan.entries[0]).toEqual(
      expect.objectContaining({
        condition: 'Bash(git commit:*)',
        status: 'unsupported',
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'unsupported_condition' }),
        ]),
      }),
    );
    expect(plan.entries[1]).toEqual(
      expect.objectContaining({
        status: 'ready',
      }),
    );
  });

  test('rejects conditional expressions on non-tool events', () => {
    const plan = planPluginHooks(
      document({
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: 'verify',
                if: 'Bash(git status:*)',
              },
            ],
          },
        ],
      }),
      {
        handlerTypes: new Set(['command']),
        matchCondition: () => true,
      },
    );

    expect(plan.summary).toEqual({ declared: 1, ready: 0, unsupported: 1 });
    expect(plan.entries[0].issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unsupported_condition',
          severity: 'error',
          message: 'Conditional `if` hook expressions are only supported for tool events',
        }),
      ]),
    );
  });

  test('converts portable timeout seconds to the SDK timeout in milliseconds', () => {
    const plan = planPluginHooks(
      document({
        Stop: [{ hooks: [{ type: 'command', command: 'verify', timeout: 30 }] }],
      }),
      commandCapabilities,
    );

    expect(plan.entries[0].timeoutMs).toBe(30_000);
  });
});
