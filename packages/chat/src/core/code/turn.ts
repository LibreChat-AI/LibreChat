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

export type TurnCodeResult =
  | { state: 'ready'; decision: TurnCodeDecision }
  | { state: 'pending' | 'blocked' };

/** The same single workspace derivation used by both manual and automatic admission. */
export function resolveTurnCodeResult(
  { workspace, approval, latest }: TurnCodeInputs,
  submitted: TConversation | null,
): TurnCodeResult {
  const derivation = resolveCodeWorkspace(workspace);
  const latestApprovalMode = latest?.codeApprovalMode;
  const submission = derivation.resolveSubmission(
    latest?.codeWorkspaces ?? submitted?.codeWorkspaces,
    latest?.codeEnvironmentMode ?? submitted?.codeEnvironmentMode,
  );
  if (submission == null) {
    const requestedMode = latest?.codeEnvironmentMode ?? submitted?.codeEnvironmentMode;
    if (requestedMode === 'without_attached' && !derivation.supportsEnvironmentDecisions) {
      return { state: 'blocked' };
    }
    if (workspace.recoveryPending || workspace.replacingDecision) return { state: 'pending' };
    if (
      Object.values(workspace.statuses).some(
        (status) => status?.fetchStatus === 'fetching' || status?.fetchStatus === 'paused',
      )
    )
      return { state: 'pending' };
    const terminal = derivation.environments.some(
      ({ state }) => state === 'unavailable' || state === 'unsupported' || state === 'missing',
    );
    const loading =
      derivation.metadataPending === true ||
      derivation.state === 'loading' ||
      Object.values(workspace.statuses).some((status) => status?.isLoading === true);
    return { state: !terminal && loading ? 'pending' : 'blocked' };
  }
  const { modes, selected } = resolveCodeApprovalModes({
    ...approval,
    codeEnvironmentMode: derivation.mode,
  });
  const { codeEnvironmentMode, codeWorkspaces } = submission;
  return {
    state: 'ready',
    decision: {
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
    },
  };
}

/** A manual send's code decision, retaining the established null refusal contract. */
export function resolveTurnCode(
  inputs: TurnCodeInputs,
  submitted: TConversation | null,
): TurnCodeDecision | null {
  const result = resolveTurnCodeResult(inputs, submitted);
  return result.state === 'ready' ? result.decision : null;
}
