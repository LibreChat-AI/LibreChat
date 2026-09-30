import { Constants, createToolPolicyHook } from '@librechat/agents';
import type { Agents, TToolApprovalPolicy } from 'librechat-data-provider';
import {
  isToolAllowAlwaysEligible,
  collectToolApprovalAllows,
  recordToolApprovalAllows,
  markToolApprovalAllowAlways,
  applyConversationToolAllows,
  resolveRunToolApprovalAllows,
  MAX_CONVERSATION_TOOL_ALLOWS,
} from './allow';
import { buildToolApprovalPayload, mapToolApprovalPolicy } from './policy';
import { resolveToolApprovalResume } from './resume';

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
    const marked = markToolApprovalAllowAlways(payload, enabled({ ask: ['pay'] }));
    expect(marked.review_configs.map((config) => config.allow_always)).toEqual([true, undefined]);
  });

  it('returns the payload untouched when the feature is off', () => {
    const payload = payloadFor(GITHUB_SEARCH);
    expect(markToolApprovalAllowAlways(payload, enabled({ allowAlways: false }))).toBe(payload);
  });
});

describe('resume validation of remembered approvals', () => {
  const policy = enabled();

  it('accepts scope session only where the pause offered it', () => {
    const offered = markToolApprovalAllowAlways(payloadFor(GITHUB_SEARCH), policy);
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
    const offered = markToolApprovalAllowAlways(payloadFor(GITHUB_SEARCH), policy);
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
    const offered = markToolApprovalAllowAlways(payloadFor(GITHUB_SEARCH), enabled());
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

describe('recordToolApprovalAllows', () => {
  const offered = markToolApprovalAllowAlways(payloadFor(GITHUB_SEARCH, GITLAB_SEARCH), enabled());
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
