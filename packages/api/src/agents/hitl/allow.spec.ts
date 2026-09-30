import { Constants, executeHooks, createToolPolicyHook } from '@librechat/agents';
import type { Agents, TToolApprovalPolicy } from 'librechat-data-provider';
import type { HookRegistry } from '@librechat/agents';
import {
  isToolAllowAlwaysEligible,
  collectToolApprovalAllows,
  recordToolApprovalAllows,
  markToolApprovalAllowAlways,
  applyConversationToolAllows,
  resolveRunToolApprovalAllows,
  MAX_CONVERSATION_TOOL_ALLOWS,
  buildEffectiveToolApprovalPolicy,
} from './allow';
import { registerToolApprovalHook, clearToolApprovalHooks } from './hooks';
import { buildToolApprovalPayload, mapToolApprovalPolicy } from './policy';
import { resolveToolApprovalResume } from './resume';
import { canAgentGraphPause } from './admission';
import { buildHITLRunWiring } from './runtime';

const GITHUB_SEARCH = 'search_mcp_github';
const GITLAB_SEARCH = 'search_mcp_gitlab';

const enabled = (overrides: Partial<NonNullable<TToolApprovalPolicy>> = {}) => ({
  enabled: true,
  allowAlways: true,
  ...overrides,
});

/** Run the SDK's real policy evaluation for one tool name. */
async function decide(policy: TToolApprovalPolicy | undefined, toolName: string) {
  const hook = createToolPolicyHook(mapToolApprovalPolicy(policy) ?? {});
  const result = await hook(
    {
      hook_event_name: 'PreToolUse',
      runId: 'run',
      toolName,
      toolInput: {},
      toolUseId: 'call',
    } as Parameters<typeof hook>[0],
    new AbortController().signal,
  );
  return result.decision;
}

const payloadFor = (...names: string[]): Agents.ToolApprovalInterruptPayload =>
  buildToolApprovalPayload(
    names.map((name, index) => ({ name, arguments: {}, tool_call_id: `call-${index}` })),
  );

describe('server enforcement of conversation tool allows', () => {
  it('auto-approves only the exact remembered tool, not a same-named tool from another server', async () => {
    const policy = applyConversationToolAllows(enabled(), [GITHUB_SEARCH]);
    expect(await decide(policy, GITHUB_SEARCH)).toBe('allow');
    expect(await decide(policy, GITLAB_SEARCH)).toBe('ask');
    expect(await decide(policy, 'search')).toBe('ask');
  });

  it('never lets a remembered tool beat an admin deny or ask rule', async () => {
    const policy = applyConversationToolAllows(
      enabled({ deny: ['*_mcp_github'], ask: ['delete_*'] }),
      [GITHUB_SEARCH, 'delete_repo'],
    );
    expect(await decide(policy, GITHUB_SEARCH)).toBe('deny');
    expect(await decide(policy, 'delete_repo')).toBe('ask');
  });

  it('ignores stored tools when the feature is off, HITL is off, or mode is dontAsk', async () => {
    for (const policy of [
      enabled({ allowAlways: false }),
      { ...enabled(), enabled: false },
      enabled({ mode: 'dontAsk' as const }),
    ]) {
      const applied = applyConversationToolAllows(policy, [GITHUB_SEARCH]);
      expect(applied).toBe(policy);
    }
    expect(await decide(enabled({ allowAlways: false }), GITHUB_SEARCH)).toBe('ask');
  });

  it('drops stored wildcards and native code tools instead of widening them', async () => {
    const policy = applyConversationToolAllows(enabled(), ['*', Constants.BASH_TOOL]);
    expect(policy?.allow).toBeUndefined();
    expect(await decide(policy, 'anything')).toBe('ask');
  });

  it('resolves run allows only from the stored record of the executing conversation', () => {
    const convo = { conversationId: 'c1', toolApprovalAllows: [GITHUB_SEARCH, 42] };
    expect(resolveRunToolApprovalAllows(enabled(), convo, 'c1')).toEqual([GITHUB_SEARCH]);
    expect(resolveRunToolApprovalAllows(enabled(), convo, 'c2')).toEqual([]);
    expect(resolveRunToolApprovalAllows(enabled({ allowAlways: false }), convo, 'c1')).toEqual([]);
  });
});

describe('isToolAllowAlwaysEligible', () => {
  it('rejects deny/ask matches, wildcards, empty and oversized names', () => {
    const policy = enabled({ deny: ['rm_*'], ask: ['pay'] });
    expect(isToolAllowAlwaysEligible(policy, GITHUB_SEARCH)).toBe(true);
    expect(isToolAllowAlwaysEligible(policy, 'rm_rf')).toBe(false);
    expect(isToolAllowAlwaysEligible(policy, 'pay')).toBe(false);
    expect(isToolAllowAlwaysEligible(policy, 'a*')).toBe(false);
    expect(isToolAllowAlwaysEligible(policy, '')).toBe(false);
    expect(isToolAllowAlwaysEligible(policy, 'x'.repeat(300))).toBe(false);
    expect(isToolAllowAlwaysEligible(policy, Constants.EXECUTE_CODE)).toBe(false);
  });
});

describe('markToolApprovalAllowAlways', () => {
  it('offers the choice only for eligible tools that can be approved', () => {
    const payload = payloadFor(GITHUB_SEARCH, 'pay');
    const marked = markToolApprovalAllowAlways(payload, { policy: enabled({ ask: ['pay'] }) });
    expect(marked.review_configs.map((config) => config.allow_always)).toEqual([true, undefined]);
  });

  it('does not offer the choice for a tool a healed ask rule matches by its other spelling', () => {
    const payload = payloadFor(GITHUB_SEARCH);
    const policy = enabled({ ask: ['legacy_search_mcp_github'] });
    const agents = [
      { mcpToolAliases: [{ name: GITHUB_SEARCH, aliasName: 'legacy_search_mcp_github' }] },
    ];
    expect(markToolApprovalAllowAlways(payload, { policy }).review_configs[0].allow_always).toBe(
      true,
    );
    expect(markToolApprovalAllowAlways(payload, { policy, agents })).toBe(payload);
  });

  it('stops offering new tools once the configured cap is reached', () => {
    const payload = payloadFor(GITHUB_SEARCH, GITLAB_SEARCH, GITHUB_SEARCH);
    const policy = enabled({ allowAlwaysMaxTools: 2 });
    const offers = (storedTools: string[]) =>
      markToolApprovalAllowAlways(payload, { policy, storedTools }).review_configs.map(
        (config) => config.allow_always,
      );
    expect(offers([])).toEqual([true, true, true]);
    expect(offers(['other'])).toEqual([true, undefined, true]);
    expect(offers(['other', 'another'])).toEqual([undefined, undefined, undefined]);
    // A tool already remembered costs no room, so it is still offered at the cap.
    expect(offers(['other', GITLAB_SEARCH])).toEqual([undefined, true, undefined]);
  });

  it('uses the configured tool name length cap', () => {
    const policy = enabled({ allowAlwaysMaxToolNameLength: 8 });
    expect(isToolAllowAlwaysEligible(policy, 'short')).toBe(true);
    expect(isToolAllowAlwaysEligible(policy, GITHUB_SEARCH)).toBe(false);
    expect(isToolAllowAlwaysEligible(enabled(), 'x'.repeat(256))).toBe(true);
    expect(isToolAllowAlwaysEligible(enabled(), 'x'.repeat(257))).toBe(false);
  });

  it('returns the payload untouched when the feature is off', () => {
    const payload = payloadFor(GITHUB_SEARCH);
    expect(markToolApprovalAllowAlways(payload, { policy: enabled({ allowAlways: false }) })).toBe(
      payload,
    );
  });
});

describe('resume validation of remembered approvals', () => {
  const policy = enabled();

  it('accepts scope session only where the pause offered it', () => {
    const offered = markToolApprovalAllowAlways(payloadFor(GITHUB_SEARCH), { policy });
    expect(
      resolveToolApprovalResume(offered, [
        { tool_call_id: 'call-0', decision: 'approve', scope: 'session' },
      ]),
    ).toEqual({ resumeValue: { 'call-0': { type: 'approve' } } });

    const notOffered = payloadFor(GITHUB_SEARCH);
    expect(
      resolveToolApprovalResume(notOffered, [
        { tool_call_id: 'call-0', decision: 'approve', scope: 'session' },
      ]),
    ).toMatchObject({ status: 403, disallowed: ['call-0'] });
  });

  it('rejects the reserved always scope and session scope on non-approve decisions', () => {
    const offered = markToolApprovalAllowAlways(payloadFor(GITHUB_SEARCH), { policy });
    for (const resolution of [
      { tool_call_id: 'call-0', decision: 'approve' as const, scope: 'always' as const },
      { tool_call_id: 'call-0', decision: 'reject' as const, scope: 'session' as const },
    ]) {
      expect(resolveToolApprovalResume(offered, [resolution])).toMatchObject({ status: 403 });
    }
  });
});

describe('collectToolApprovalAllows', () => {
  it('re-checks eligibility against the live policy', () => {
    const offered = markToolApprovalAllowAlways(payloadFor(GITHUB_SEARCH), { policy: enabled() });
    const resolutions: Agents.ToolApprovalResolution[] = [
      { tool_call_id: 'call-0', decision: 'approve', scope: 'session' },
    ];
    expect(collectToolApprovalAllows(offered, resolutions, enabled())).toEqual([GITHUB_SEARCH]);
    expect(
      collectToolApprovalAllows(offered, resolutions, enabled({ deny: [GITHUB_SEARCH] })),
    ).toEqual([]);
    expect(
      collectToolApprovalAllows(offered, resolutions, enabled({ allowAlways: false })),
    ).toEqual([]);
  });
});

describe('buildEffectiveToolApprovalPolicy', () => {
  const alias = { name: GITHUB_SEARCH, aliasName: 'legacy_search_mcp_github' };

  it('heals ask rules before folding remembered tools, so a healed ask still wins', async () => {
    const policy = buildEffectiveToolApprovalPolicy(
      enabled({ ask: ['legacy_search_mcp_github'] }),
      [alias],
      [GITHUB_SEARCH],
    );
    expect(policy?.allow ?? []).not.toContain(GITHUB_SEARCH);
    expect(await decide(policy, GITHUB_SEARCH)).toBe('ask');
  });

  it('lets scheduled admission skip a run whose every known tool is remembered', () => {
    const agents = [{ tools: [GITHUB_SEARCH, GITLAB_SEARCH] }];
    expect(canAgentGraphPause({ policy: enabled(), agents })).toBe(true);
    expect(
      canAgentGraphPause({ policy: enabled(), agents, toolApprovalAllows: [GITHUB_SEARCH] }),
    ).toBe(true);
    expect(
      canAgentGraphPause({
        policy: enabled(),
        agents,
        toolApprovalAllows: [GITHUB_SEARCH, GITLAB_SEARCH],
      }),
    ).toBe(false);
    expect(
      canAgentGraphPause({
        policy: enabled({ allowAlways: false }),
        agents,
        toolApprovalAllows: [GITHUB_SEARCH, GITLAB_SEARCH],
      }),
    ).toBe(true);
  });

  it('keeps admission paused for a remembered tool a healed ask rule matches', () => {
    expect(
      canAgentGraphPause({
        policy: enabled({ ask: ['legacy_search_mcp_github'] }),
        agents: [{ tools: [GITHUB_SEARCH], mcpToolAliases: [alias] }],
        toolApprovalAllows: [GITHUB_SEARCH],
      }),
    ).toBe(true);
  });
});

describe('recordToolApprovalAllows', () => {
  const offered = markToolApprovalAllowAlways(payloadFor(GITHUB_SEARCH, GITLAB_SEARCH), {
    policy: enabled(),
  });
  const resolutions = [
    { tool_call_id: 'call-0', decision: 'approve', scope: 'session' },
    { tool_call_id: 'call-1', decision: 'approve' },
  ];

  it('stores remembered tools and exposes them to the rebuilt run', async () => {
    const addConvoToolApprovalAllows = jest.fn().mockResolvedValue(true);
    const request = {
      resolvedConversation: { conversationId: 'c1', toolApprovalAllows: ['other_tool'] },
    };
    const stored = await recordToolApprovalAllows({
      userId: 'u1',
      conversationId: 'c1',
      policy: enabled(),
      pendingAction: { payload: offered },
      resolutions,
      request,
      addConvoToolApprovalAllows,
    });
    expect(stored).toEqual([GITHUB_SEARCH]);
    expect(addConvoToolApprovalAllows).toHaveBeenCalledWith({
      user: 'u1',
      conversationId: 'c1',
      toolNames: [GITHUB_SEARCH],
      max: MAX_CONVERSATION_TOOL_ALLOWS,
    });
    expect(request.resolvedConversation.toolApprovalAllows).toEqual(['other_tool', GITHUB_SEARCH]);
  });

  it('passes the configured cap to storage and rechecks against healed rules', async () => {
    const addConvoToolApprovalAllows = jest.fn().mockResolvedValue(true);
    await recordToolApprovalAllows({
      userId: 'u1',
      conversationId: 'c1',
      policy: enabled({ allowAlwaysMaxTools: 5 }),
      pendingAction: { payload: offered },
      resolutions,
      request: {},
      addConvoToolApprovalAllows,
    });
    expect(addConvoToolApprovalAllows).toHaveBeenCalledWith(expect.objectContaining({ max: 5 }));

    addConvoToolApprovalAllows.mockClear();
    const stored = await recordToolApprovalAllows({
      userId: 'u1',
      conversationId: 'c1',
      policy: enabled({ ask: ['legacy_search_mcp_github'] }),
      pendingAction: { payload: offered },
      resolutions,
      agents: [
        { mcpToolAliases: [{ name: GITHUB_SEARCH, aliasName: 'legacy_search_mcp_github' }] },
      ],
      request: {},
      addConvoToolApprovalAllows,
    });
    expect(stored).toEqual([]);
    expect(addConvoToolApprovalAllows).not.toHaveBeenCalled();
  });

  it('degrades to a one-time approval when storage fails', async () => {
    const request = { resolvedConversation: { conversationId: 'c1' } };
    const stored = await recordToolApprovalAllows({
      userId: 'u1',
      conversationId: 'c1',
      policy: enabled(),
      pendingAction: { payload: offered },
      resolutions,
      request,
      addConvoToolApprovalAllows: jest.fn().mockRejectedValue(new Error('db down')),
    });
    expect(stored).toEqual([]);
    expect(request.resolvedConversation).toEqual({ conversationId: 'c1' });
  });

  it('approves once and stores nothing when a hook registered after the pause applies', async () => {
    const addConvoToolApprovalAllows = jest.fn().mockResolvedValue(true);
    const pluginHookSource = {
      hasHooks: () => true,
      hasToolApprovalHooks: (names?: readonly string[]) => names?.includes(GITHUB_SEARCH) === true,
      register: () => 0,
    };
    const request = { resolvedConversation: { conversationId: 'c1' } };
    const viaPlugin = await recordToolApprovalAllows({
      userId: 'u1',
      conversationId: 'c1',
      policy: enabled(),
      pendingAction: { payload: offered },
      resolutions,
      pluginHookSource,
      request,
      addConvoToolApprovalAllows,
    });
    expect(viaPlugin).toEqual([]);

    const hookContexts: unknown[] = [];
    registerToolApprovalHook((context) => {
      hookContexts.push(context);
      return async () => ({ decision: 'ask' as const });
    });
    try {
      const viaProgrammatic = await recordToolApprovalAllows({
        userId: 'u1',
        conversationId: 'c1',
        policy: enabled(),
        pendingAction: { payload: offered },
        resolutions,
        hookContext: { userId: 'u1', conversationId: 'c1', tenantId: 't1' },
        request,
        addConvoToolApprovalAllows,
      });
      expect(viaProgrammatic).toEqual([]);
    } finally {
      clearToolApprovalHooks();
    }
    expect(hookContexts).toEqual([{ userId: 'u1', conversationId: 'c1', tenantId: 't1' }]);
    expect(addConvoToolApprovalAllows).not.toHaveBeenCalled();
    expect(request.resolvedConversation).toEqual({ conversationId: 'c1' });
  });

  it('does nothing for ask-user-question resumes', async () => {
    const addConvoToolApprovalAllows = jest.fn();
    await recordToolApprovalAllows({
      userId: 'u1',
      conversationId: 'c1',
      policy: enabled(),
      pendingAction: {
        payload: { type: 'ask_user_question', question: { question: 'q' } },
      },
      resolutions: undefined,
      request: {},
      addConvoToolApprovalAllows,
    });
    expect(addConvoToolApprovalAllows).not.toHaveBeenCalled();
  });
});

describe('invariant: Always allow is offered only when the next identical call is auto-approved', () => {
  const STRIPPED = GITHUB_SEARCH;
  const LEGACY = 'legacy_search_mcp_github';
  const alias = { name: STRIPPED, aliasName: LEGACY };
  const askHook = async () => ({ decision: 'ask' as const, reason: 'per-argument check' });
  const askPluginSource = {
    hasHooks: () => true,
    hasToolApprovalHooks: () => true,
    register: ({ registry }: { registry: HookRegistry }) => {
      registry.register('PreToolUse', { hooks: [askHook] });
      return 1;
    },
  };

  interface InvariantCase {
    label: string;
    policy: NonNullable<TToolApprovalPolicy>;
    /** Spelling the paused call used. */
    paused: string;
    /** Spellings the next identical call may arrive under. */
    next: string[];
    stored?: string[];
    programmaticHook?: boolean;
    pluginHook?: boolean;
    /** The hook is registered after the pause (restart or deploy) instead of before it. */
    hookAfterPause?: boolean;
    offered: boolean;
  }

  const cases: InvariantCase[] = [
    {
      label: 'static ask',
      policy: enabled({ ask: [STRIPPED] }),
      paused: STRIPPED,
      next: [STRIPPED],
      offered: false,
    },
    {
      label: 'default mode ask',
      policy: enabled({ mode: 'default' }),
      paused: STRIPPED,
      next: [STRIPPED],
      offered: true,
    },
    {
      label: 'programmatic hook ask',
      policy: enabled(),
      paused: STRIPPED,
      next: [STRIPPED],
      programmaticHook: true,
      offered: false,
    },
    {
      label: 'plugin hook ask',
      policy: enabled(),
      paused: STRIPPED,
      next: [STRIPPED],
      pluginHook: true,
      offered: false,
    },
    {
      label: 'programmatic hook registered after the pause',
      policy: enabled(),
      paused: STRIPPED,
      next: [STRIPPED],
      programmaticHook: true,
      hookAfterPause: true,
      offered: true,
    },
    {
      label: 'plugin hook registered after the pause',
      policy: enabled(),
      paused: STRIPPED,
      next: [STRIPPED],
      pluginHook: true,
      hookAfterPause: true,
      offered: true,
    },
    {
      label: 'admin deny',
      policy: enabled({ deny: [STRIPPED] }),
      paused: STRIPPED,
      next: [STRIPPED],
      offered: false,
    },
    {
      label: 'admin ask on the alias spelling',
      policy: enabled({ ask: [LEGACY] }),
      paused: STRIPPED,
      next: [STRIPPED, LEGACY],
      offered: false,
    },
    {
      label: 'admin deny on the stripped spelling, paused as legacy',
      policy: enabled({ deny: [STRIPPED] }),
      paused: LEGACY,
      next: [LEGACY],
      offered: false,
    },
    {
      label: 'remembered legacy spelling',
      policy: enabled(),
      paused: LEGACY,
      next: [STRIPPED, LEGACY],
      offered: true,
    },
    {
      label: 'remembered stripped spelling',
      policy: enabled(),
      paused: STRIPPED,
      next: [LEGACY, STRIPPED],
      offered: true,
    },
    {
      label: 'dontAsk',
      policy: enabled({ mode: 'dontAsk' }),
      paused: STRIPPED,
      next: [STRIPPED],
      offered: false,
    },
    {
      label: 'flag off',
      policy: enabled({ allowAlways: false }),
      paused: STRIPPED,
      next: [STRIPPED],
      offered: false,
    },
    {
      label: 'cap reached',
      policy: enabled({ allowAlwaysMaxTools: 1 }),
      paused: STRIPPED,
      next: [STRIPPED],
      stored: ['other_tool'],
      offered: false,
    },
  ];

  afterEach(() => clearToolApprovalHooks());

  /** Decide one call exactly as `createRun` wires it: effective policy plus registered hooks. */
  async function runDecision(row: InvariantCase, allows: string[], toolName: string) {
    const wiring = buildHITLRunWiring(
      buildEffectiveToolApprovalPolicy(row.policy, [alias], allows),
      {},
      [alias],
    );
    if (wiring == null) {
      return 'allow';
    }
    if (row.pluginHook) {
      askPluginSource.register({ registry: wiring.hooks });
    }
    const result = await executeHooks({
      registry: wiring.hooks,
      matchQuery: toolName,
      input: {
        hook_event_name: 'PreToolUse',
        runId: 'invariant',
        toolName,
        toolInput: {},
        toolUseId: 'next-call',
      },
    });
    return result.decision ?? 'allow';
  }

  it.each(cases)('$label', async (row) => {
    const registerHooks = () => {
      if (row.programmaticHook) {
        registerToolApprovalHook(() => askHook);
      }
      return row.pluginHook ? askPluginSource : undefined;
    };
    const agents = [{ mcpToolAliases: [alias] }];
    const hooksAtPause = row.hookAfterPause ? undefined : registerHooks();
    const marked = markToolApprovalAllowAlways(payloadFor(row.paused), {
      policy: row.policy,
      agents,
      storedTools: row.stored,
      pluginHookSource: hooksAtPause,
    });
    const offered = marked.review_configs[0].allow_always === true;
    expect(offered).toBe(row.offered);
    const pluginHookSource = row.hookAfterPause ? registerHooks() : hooksAtPause;

    const addConvoToolApprovalAllows = jest.fn().mockResolvedValue(true);
    const recorded = await recordToolApprovalAllows({
      userId: 'u1',
      conversationId: 'c1',
      policy: row.policy,
      pendingAction: { payload: marked },
      resolutions: [{ tool_call_id: 'call-0', decision: 'approve', scope: 'session' }],
      agents,
      pluginHookSource,
      request: {},
      addConvoToolApprovalAllows,
    });
    const remembered = offered && row.hookAfterPause !== true;
    expect(recorded).toEqual(remembered ? [row.paused] : []);
    const allows = resolveRunToolApprovalAllows(
      row.policy,
      { conversationId: 'c1', toolApprovalAllows: [...(row.stored ?? []), ...recorded] },
      'c1',
    );
    for (const spelling of row.next) {
      const decision = await runDecision(row, allows, spelling);
      if (remembered) {
        expect(decision).toBe('allow');
      } else if (row.policy.enabled === true && row.policy.mode !== 'dontAsk') {
        expect(decision).not.toBe('allow');
      }
    }
    if (remembered) {
      expect(await runDecision(row, allows, GITLAB_SEARCH)).toBe('ask');
      expect(
        canAgentGraphPause({
          policy: row.policy,
          agents: [{ tools: row.next, mcpToolAliases: [alias] }],
          toolApprovalAllows: allows,
        }),
      ).toBe(false);
    }
  });
});
