import type { TConversation } from 'librechat-data-provider';
import {
  hasSameCodeDecision,
  withSubmittedCodeDecision,
  resolveSubmittedCodeApprovalMode,
} from '../codeDecision';

const selection = { environmentId: 'personal-vm', workspaceId: 'project-a' };
const conversation = (overrides: Partial<TConversation> = {}): TConversation =>
  ({ conversationId: 'existing', ...overrides }) as TConversation;

describe('withSubmittedCodeDecision', () => {
  it('does not treat changed agent ownership as the same sealed route', () => {
    const current = conversation({
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [{ ...selection, agentIds: ['primary'] }],
    });
    const submitted = {
      codeEnvironmentMode: 'attached' as const,
      codeWorkspaces: [{ ...selection, agentIds: ['reviewer'] }],
    };
    expect(hasSameCodeDecision(current, submitted)).toBe(false);
    expect(withSubmittedCodeDecision(current, submitted)?.codeWorkspaces).toEqual(
      submitted.codeWorkspaces,
    );
  });
  it('records the mode and selections the run was submitted with', () => {
    expect(
      withSubmittedCodeDecision(conversation(), {
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [selection],
      }),
    ).toEqual({
      conversationId: 'existing',
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [selection],
    });
  });

  it('records a run that continues without an attached environment', () => {
    expect(
      withSubmittedCodeDecision(conversation({ codeWorkspaces: [selection] }), {
        codeEnvironmentMode: 'without_attached',
      }),
    ).toEqual({ conversationId: 'existing', codeEnvironmentMode: 'without_attached' });
  });

  /* A send that carries no decision belongs to a chat no attached environment applies to. */
  it('leaves a conversation alone when the submission carries no decision', () => {
    const current = conversation();
    expect(withSubmittedCodeDecision(current, {})).toBe(current);
    expect(withSubmittedCodeDecision(null, { codeEnvironmentMode: 'attached' })).toBeNull();
  });

  it('keeps the same conversation when it already holds the decision in another order', () => {
    const other = { environmentId: 'team-vm', workspaceId: 'shared' };
    const current = conversation({
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [other, selection],
    });

    expect(
      withSubmittedCodeDecision(current, {
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [selection, other],
      }),
    ).toBe(current);
  });
});

it('does not confuse colons in environment and workspace identifiers', () => {
  const current = conversation({
    codeEnvironmentMode: 'attached',
    codeWorkspaces: [{ environmentId: 'vm:repo', workspaceId: 'main' }],
  });
  const submitted = {
    codeEnvironmentMode: 'attached' as const,
    codeWorkspaces: [{ environmentId: 'vm', workspaceId: 'repo:main' }],
  };
  expect(withSubmittedCodeDecision(current, submitted)?.codeWorkspaces).toEqual(
    submitted.codeWorkspaces,
  );
});

it('records a legacy selection-only submission before the first saved-chat event', () => {
  expect(withSubmittedCodeDecision(conversation(), { codeWorkspaces: [selection] })).toEqual({
    conversationId: 'existing',
    codeEnvironmentMode: 'attached',
    codeWorkspaces: [selection],
  });
});

it('matches legacy selection-only decisions when reconciling a transition', () => {
  expect(
    hasSameCodeDecision(
      { codeWorkspaces: [selection] },
      { codeEnvironmentMode: 'attached', codeWorkspaces: [selection] },
    ),
  ).toBe(true);
});

it('treats empty and absent selections alike without treating an undecided chat as sealed', () => {
  expect(
    hasSameCodeDecision(
      { codeEnvironmentMode: 'without_attached', codeWorkspaces: [] },
      { codeEnvironmentMode: 'without_attached' },
    ),
  ).toBe(true);
  expect(hasSameCodeDecision({}, { codeEnvironmentMode: 'without_attached' })).toBe(false);
});

describe('resolveSubmittedCodeApprovalMode', () => {
  const modes = ['ask', 'acceptEdits', 'fullAccess'] as const;

  it('sends the gated ask for a turn resolved without a workspace', () => {
    for (const requested of modes) {
      expect(
        resolveSubmittedCodeApprovalMode({
          requested,
          modes,
          fallback: requested,
          codeEnvironmentMode: 'without_attached',
        }),
      ).toBe('ask');
    }
  });

  it('keeps the policy-offered pick for an attached turn and falls back otherwise', () => {
    expect(
      resolveSubmittedCodeApprovalMode({
        requested: 'fullAccess',
        modes,
        fallback: 'ask',
        codeEnvironmentMode: 'attached',
      }),
    ).toBe('fullAccess');
    expect(
      resolveSubmittedCodeApprovalMode({
        requested: 'fullAccess',
        modes: ['ask'],
        fallback: 'ask',
      }),
    ).toBe('ask');
    expect(resolveSubmittedCodeApprovalMode({ modes, fallback: 'acceptEdits' })).toBe(
      'acceptEdits',
    );
  });

  it('sends nothing when approvals are unsupported', () => {
    expect(
      resolveSubmittedCodeApprovalMode({
        requested: 'fullAccess',
        modes: [],
        codeEnvironmentMode: 'without_attached',
      }),
    ).toBeUndefined();
  });
});
