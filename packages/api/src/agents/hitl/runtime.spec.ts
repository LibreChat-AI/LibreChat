import { HookRegistry, executeHooks } from '@librechat/agents';
import { buildHITLRunWiring, buildToolApprovalExecutionConfig } from './runtime';
import { registerToolApprovalHook, clearToolApprovalHooks } from './hooks';
import { createAttachedCodeEnvironmentPolicyHook } from './byom';
import { resolveToolApprovalPolicy } from './policy';

describe('buildHITLRunWiring', () => {
  test.each([
    ['ask', 'bash_tool', 'ask'],
    ['deny', 'bash_tool', 'deny'],
    ['allow', 'bash_tool', 'allow'],
    ['allow', 'mcp:github:create_issue', 'ask'],
  ] as const)(
    'full access preserves endpoint %s rules for %s',
    async (rule, toolName, expected) => {
      const settings = new Map([
        [
          'attached-agent',
          {
            configSchema: {
              permissions: {
                fileWrite: {
                  allowed: ['ask', 'allow'] as Array<'ask' | 'allow'>,
                  default: 'ask' as const,
                },
                commandExecution: {
                  allowed: ['ask', 'allow'] as Array<'ask' | 'allow'>,
                  default: 'ask' as const,
                },
              },
            },
          },
        ],
      ]);
      const wiring = buildHITLRunWiring(
        { enabled: true, mode: 'default', [rule]: ['bash_tool'] },
        {},
        [],
        [
          {
            hook: createAttachedCodeEnvironmentPolicyHook(
              new Set(settings.keys()),
              settings,
              'fullAccess',
            ),
          },
        ],
      );
      const result = await executeHooks({
        registry: wiring!.hooks,
        matchQuery: toolName,
        input: {
          hook_event_name: 'PreToolUse',
          runId: 'full-access-policy',
          toolName,
          toolInput: {},
          toolUseId: 'tool-code',
          executingAgentId: 'attached-agent',
        },
      });
      expect(result.decision).toBe(expected);
    },
  );

  test('returns undefined when HITL is disabled (the default)', () => {
    expect(buildHITLRunWiring(undefined)).toBeUndefined();
    expect(buildHITLRunWiring({})).toBeUndefined();
    expect(buildHITLRunWiring({ enabled: false })).toBeUndefined();
    expect(buildHITLRunWiring({ mode: 'default', allow: ['read_*'] })).toBeUndefined();
  });

  test('returns the run wiring when enabled', () => {
    const wiring = buildHITLRunWiring({ enabled: true });
    expect(wiring).toBeDefined();
    expect(wiring?.humanInTheLoop).toEqual({ enabled: true });
    expect(wiring?.hooks).toBeInstanceOf(HookRegistry);
  });

  test('registers exactly one PreToolUse policy hook', () => {
    const wiring = buildHITLRunWiring({ enabled: true, mode: 'bypass', allow: ['x'] });
    const matchers = wiring?.hooks.getMatchers('PreToolUse') ?? [];
    expect(matchers).toHaveLength(1);
  });

  test('an enabled policy with no lists still wires (every tool falls through to ask)', () => {
    const wiring = buildHITLRunWiring({ enabled: true });
    expect(wiring?.hooks.getMatchers('PreToolUse')).toHaveLength(1);
  });

  test('updates the baseline policy for aliases learned after run creation', async () => {
    const wiring = buildHITLRunWiring({ enabled: true, mode: 'dontAsk', allow: ['legacy_tool'] });
    const policyHook = wiring?.hooks.getMatchers('PreToolUse')[0].hooks[0];
    expect(
      await policyHook?.({ toolName: 'current_tool' } as never, new AbortController().signal),
    ).toEqual({ decision: 'deny' });

    wiring?.addMCPToolAliases([{ name: 'current_tool', aliasName: 'legacy_tool' }], {
      enabled: true,
      mode: 'dontAsk',
      allow: ['legacy_tool', 'current_tool'],
    });
    expect(
      await policyHook?.({ toolName: 'current_tool' } as never, new AbortController().signal),
    ).toEqual({ decision: 'allow' });
    expect(wiring?.hooks.getMatchers('PreToolUse')).toHaveLength(1);

    // Re-resolving the same descriptor must not grow the run-wide hook registry.
    wiring?.addMCPToolAliases([{ name: 'current_tool', aliasName: 'legacy_tool' }], {
      enabled: true,
      mode: 'dontAsk',
      allow: ['legacy_tool', 'current_tool'],
    });
    expect(wiring?.hooks.getMatchers('PreToolUse')).toHaveLength(1);
  });

  test.each([
    ['default', 'ask'],
    ['dontAsk', 'deny'],
  ] as const)(
    'keeps the enabled endpoint %s fallback for unrelated tools in BYOM runs',
    async (mode, expectedDecision) => {
      const policy = resolveToolApprovalPolicy({
        endpoint: { enabled: true, mode },
        attachedCodeEnvironment: true,
      });
      const wiring = buildHITLRunWiring(
        policy,
        {},
        [],
        [{ hook: createAttachedCodeEnvironmentPolicyHook(new Set(['attached-agent'])) }],
      );

      const result = await executeHooks({
        registry: wiring?.hooks as HookRegistry,
        matchQuery: 'mcp:github:create_issue',
        input: {
          hook_event_name: 'PreToolUse',
          runId: 'run-byom-policy',
          toolName: 'mcp:github:create_issue',
          toolInput: {},
          toolUseId: 'tool-unrelated',
          executingAgentId: 'attached-agent',
        },
      });

      expect(result.decision).toBe(expectedDecision);
    },
  );
});

describe('buildHITLRunWiring host-hook composition', () => {
  afterEach(() => clearToolApprovalHooks());

  test('registers the static policy hook PLUS each registered host hook', () => {
    registerToolApprovalHook(() => async () => ({ decision: 'deny' }));
    registerToolApprovalHook(() => async () => ({ decision: 'ask' }), { matcher: 'write_.*' });
    const wiring = buildHITLRunWiring({ enabled: true });
    // 1 static baseline + 2 host hooks
    expect(wiring?.hooks.getMatchers('PreToolUse')).toHaveLength(3);
  });

  test('a factory that opts out (returns undefined) is not registered', () => {
    registerToolApprovalHook(() => undefined);
    const wiring = buildHITLRunWiring({ enabled: true });
    expect(wiring?.hooks.getMatchers('PreToolUse')).toHaveLength(1); // only the static baseline
  });

  test('does not invoke host-hook factories when HITL is disabled', () => {
    const factory = jest.fn(() => undefined);
    registerToolApprovalHook(factory);
    expect(buildHITLRunWiring({ enabled: false })).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  test('passes the run context to each factory', () => {
    const factory = jest.fn(() => undefined);
    registerToolApprovalHook(factory);
    buildHITLRunWiring({ enabled: true }, { userId: 'u1', conversationId: 'c1' });
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', conversationId: 'c1' }),
    );
  });

  test('reuses request-scoped hooks resolved by admission without invoking factories twice', () => {
    const hook = async () => ({ decision: 'ask' as const });
    const factory = jest.fn(() => hook);
    registerToolApprovalHook(factory);
    const resolved = [{ hook }];
    factory.mockClear();

    const wiring = buildHITLRunWiring({ enabled: true }, {}, [], resolved);

    expect(factory).not.toHaveBeenCalled();
    expect(wiring?.hooks.getMatchers('PreToolUse')).toHaveLength(2);
  });

  test('matches lazy aliases without changing host-hook ordering', async () => {
    const hook = jest.fn(async () => ({ decision: 'deny' as const }));
    registerToolApprovalHook(() => hook, {
      matcher: '^legacy_tool$',
    });
    const wiring = buildHITLRunWiring({ enabled: true, mode: 'bypass' });
    const hostHook = wiring?.hooks.getMatchers('PreToolUse')[1].hooks[0];
    await hostHook?.({ toolName: 'current_tool' } as never, new AbortController().signal);
    expect(hook).not.toHaveBeenCalled();

    wiring?.addMCPToolAliases([{ name: 'current_tool', aliasName: 'legacy_tool' }], {
      enabled: true,
      mode: 'bypass',
    });
    await hostHook?.({ toolName: 'current_tool' } as never, new AbortController().signal);
    expect(hook).toHaveBeenCalledTimes(1);
    // Baseline policy + host matcher; plugins registered later remain last.
    expect(wiring?.hooks.getMatchers('PreToolUse')).toHaveLength(2);
  });
});

describe('tool approval execution scope', () => {
  test('reconstructs the same scope for repeated approval resumes', () => {
    const generation = { responseMessageId: 'response-1', jobCreatedAt: 1000 };
    const original = buildToolApprovalExecutionConfig(
      generation.responseMessageId,
      generation.jobCreatedAt,
    );
    const restored = JSON.parse(JSON.stringify(generation)) as typeof generation;
    expect(
      buildToolApprovalExecutionConfig(restored.responseMessageId, restored.jobCreatedAt),
    ).toEqual(original);
    expect(Object.values(original)[0]).toBeTruthy();
  });

  test('separates new generations even when an edit reuses the response id', () => {
    const original = buildToolApprovalExecutionConfig('response-1', 1000);
    expect(buildToolApprovalExecutionConfig('response-1', 1001)).not.toEqual(original);
    expect(buildToolApprovalExecutionConfig('response-2', 1000)).not.toEqual(original);
  });

  test('uses the response id for runs without a generation job', () => {
    expect(buildToolApprovalExecutionConfig('response-1')).toEqual(
      buildToolApprovalExecutionConfig('response-1'),
    );
    expect(buildToolApprovalExecutionConfig('response-2')).not.toEqual(
      buildToolApprovalExecutionConfig('response-1'),
    );
  });
});
