import type { TConversation } from 'librechat-data-provider';
import type { CodeApprovalModeInputs } from './approval';
import type { CodeWorkspaceInputs } from './workspace';
import type { BuildTurnInput } from '../turns';
import { resolveCodeApprovalModes, resolveSubmittedCodeApprovalMode } from './approval';
import { withSubmittedCodeDecision } from '../decision';
import { resolveCodeWorkspace } from './workspace';

/** What a send's code decision reads, as the app stores it: no defaults and no derivation. */
export interface TurnCodeInputs {
  workspace: CodeWorkspaceInputs;
  /** The approval mode's mode is the one the workspace resolves, so it is not an input. */
  approval: Omit<CodeApprovalModeInputs, 'codeEnvironmentMode'>;
  /** The pane's conversation at send time, which can be ahead of the one last rendered. */
  latest: TConversation | null;
}

/** The code workspace and approval a send carries. */
export interface TurnCodeDecision {
  code: BuildTurnInput['code'];
  /** Records the decision on the pane's conversation once the send is published. */
  apply: (conversation: TConversation) => TConversation | null;
}

/**
 * The code decision for one send, or `null` when the send has to wait: a recovery or replacement
 * is in flight, or the attached workspaces cannot be resolved yet.
 */
export function resolveTurnCode(
  { workspace, approval, latest }: TurnCodeInputs,
  submitted: TConversation | null,
): TurnCodeDecision | null {
  const derivation = resolveCodeWorkspace(workspace);
  const latestApprovalMode = latest?.codeApprovalMode;
  const submission = derivation.resolveSubmission(
    latest?.codeWorkspaces ?? submitted?.codeWorkspaces,
    latest?.codeEnvironmentMode ?? submitted?.codeEnvironmentMode,
  );
  if (submission == null) {
    return null;
  }
  const { modes, selected } = resolveCodeApprovalModes({
    ...approval,
    codeEnvironmentMode: derivation.mode,
  });
  const { codeEnvironmentMode, codeWorkspaces } = submission;
  return {
    code: {
      approvalMode: resolveSubmittedCodeApprovalMode({
        requested: latestApprovalMode,
        modes,
        fallback: selected,
        codeEnvironmentMode,
      }),
      latestApprovalMode,
      environmentMode: codeEnvironmentMode,
      workspaces: codeWorkspaces,
    },
    apply: (current) => withSubmittedCodeDecision(current, submission),
  };
}
