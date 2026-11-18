import { agent, conversation, projectA, projectB, turnInputs } from '../__fixtures__/turn';
import { resolveTurnCode, resolveTurnCodeResult } from '../turn';
import * as workspace from '../workspace';

describe('resolveTurnCode', () => {
  it('admits a sealed without-attached decision before irrelevant linked metadata loads', () => {
    const inputs = turnInputs();
    inputs.workspace.primaryAgent = { ...agent, agent_ids: ['agent_child'] };
    inputs.workspace.agentsMap = undefined;
    const selected = conversation({
      codeEnvironmentMode: 'without_attached',
      codeWorkspaces: undefined,
    });
    inputs.workspace.conversation = selected;
    expect(resolveTurnCodeResult(inputs, selected).state).toBe('ready');
  });

  it('keeps an unsupported legacy without-attached decision terminal while other data loads', () => {
    const inputs = turnInputs();
    inputs.workspace.startupConfig = {};
    inputs.workspace.statuses['personal-vm'] = { isLoading: true, isError: false };
    const selected = conversation({
      codeEnvironmentMode: 'without_attached',
      codeWorkspaces: undefined,
    });
    inputs.workspace.conversation = selected;
    expect(resolveTurnCodeResult(inputs, selected).state).toBe('blocked');
  });

  it('distinguishes unknown linked metadata from a loaded missing target', () => {
    const inputs = turnInputs();
    inputs.workspace.primaryAgent = { ...agent, agent_ids: ['agent_child'] };
    inputs.workspace.agentsMap = undefined;
    expect(resolveTurnCodeResult(inputs, inputs.workspace.conversation).state).toBe('pending');
    inputs.workspace.agentsMap = {};
    expect(resolveTurnCodeResult(inputs, inputs.workspace.conversation).state).toBe('blocked');
  });

  it('derives workspace once for a reason-preserving attempt and once for the manual wrapper', () => {
    const derive = jest.spyOn(workspace, 'resolveCodeWorkspace');
    try {
      const inputs = turnInputs();
      const selected = inputs.workspace.conversation;
      expect(resolveTurnCodeResult(inputs, selected).state).toBe('ready');
      expect(derive).toHaveBeenCalledTimes(1);
      derive.mockClear();
      expect(resolveTurnCode(inputs, selected)).not.toBeNull();
      expect(derive).toHaveBeenCalledTimes(1);
    } finally {
      derive.mockRestore();
    }
  });

  it('waits while a recovery is pending', () => {
    const inputs = turnInputs();
    expect(
      resolveTurnCode(
        { ...inputs, workspace: { ...inputs.workspace, recoveryPending: true } },
        null,
      ),
    ).toBeNull();
  });

  it('waits while a decision replacement is in flight', () => {
    const inputs = turnInputs();
    expect(
      resolveTurnCode(
        { ...inputs, workspace: { ...inputs.workspace, replacingDecision: true } },
        null,
      ),
    ).toBeNull();
  });

  it('returns an empty decision when no workspace is required', () => {
    const inputs = turnInputs();
    const decision = resolveTurnCode(
      {
        workspace: { ...inputs.workspace, canRunCode: false },
        approval: { conversation: null, reachable: { agents: [], complete: true } },
        latest: null,
      },
      null,
    );
    expect(decision?.code).toEqual({
      approvalMode: undefined,
      latestApprovalMode: undefined,
      environmentMode: undefined,
      workspaces: undefined,
    });
  });

  it("prefers the pane's latest conversation over the submitted one", () => {
    const decision = resolveTurnCode(
      turnInputs({
        latest: conversation({ codeEnvironmentMode: 'attached', codeWorkspaces: [projectA] }),
      }),
      conversation({ codeEnvironmentMode: 'attached', codeWorkspaces: [projectB] }),
    );
    expect(decision?.code.environmentMode).toBe('attached');
    expect(decision?.code.workspaces).toEqual([projectA]);
  });

  it('falls back to the submitted conversation when the latest has no decision', () => {
    const submitted = conversation({ codeEnvironmentMode: 'attached', codeWorkspaces: [projectB] });
    const absent = resolveTurnCode(turnInputs({ latest: null }), submitted);
    expect(absent?.code.workspaces).toEqual([projectB]);
    const undecided = resolveTurnCode(turnInputs({ latest: conversation() }), submitted);
    expect(undecided?.code.environmentMode).toBe('attached');
    expect(undecided?.code.workspaces).toEqual([projectB]);
  });

  it('carries the gated ask for a turn without a workspace while reporting the latest pick', () => {
    const inputs = turnInputs();
    const decision = resolveTurnCode(
      {
        ...inputs,
        workspace: {
          ...inputs.workspace,
          conversation: conversation({
            conversationId: 'conversation-1',
            codeEnvironmentMode: 'without_attached',
          }),
        },
        latest: conversation({
          conversationId: 'conversation-1',
          codeApprovalMode: 'acceptEdits',
          codeEnvironmentMode: 'without_attached',
        }),
      },
      null,
    );
    expect(decision?.code.environmentMode).toBe('without_attached');
    expect(decision?.code.approvalMode).toBe('ask');
    expect(decision?.code.latestApprovalMode).toBe('acceptEdits');
  });

  it('submits the latest approval mode the policy offers', () => {
    const decision = resolveTurnCode(
      turnInputs({
        latest: conversation({
          codeApprovalMode: 'acceptEdits',
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [projectA],
        }),
      }),
      null,
    );
    expect(decision?.code.approvalMode).toBe('acceptEdits');
  });

  it('falls back to the selected mode when the requested one is not offered', () => {
    const inputs = turnInputs();
    const decision = resolveTurnCode(
      {
        ...inputs,
        approval: { ...inputs.approval, conversation: conversation(), preferred: 'acceptEdits' },
        latest: conversation({
          codeApprovalMode: 'fullAccess',
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [projectA],
        }),
      },
      null,
    );
    expect(decision?.code.approvalMode).toBe('acceptEdits');
    expect(decision?.code.latestApprovalMode).toBe('fullAccess');
  });

  it('records the submission on a conversation', () => {
    const decision = resolveTurnCode(
      turnInputs({
        latest: conversation({ codeEnvironmentMode: 'attached', codeWorkspaces: [projectA] }),
      }),
      null,
    );
    const current = conversation({ conversationId: 'conversation-1' });
    expect(decision?.apply(current)).toEqual({
      ...current,
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [projectA],
    });
  });
});
