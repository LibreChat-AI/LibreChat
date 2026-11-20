import { useToastContext } from '@librechat/client';
import { CodeWorkspaceMenu as WorkspaceMenu } from '@librechat/chat/components';
import type { WorkspaceMachineQuery } from '@librechat/chat/components';
import type { TConversation } from 'librechat-data-provider';
import type { SetterOrUpdater } from 'recoil';
import type { CodeWorkspaceResult, TranslationKeys } from '~/hooks';
import {
  useCodeWorkspaceRefresh,
  useCodeEnvironmentStatusQueries,
  useMoveConversationCodeEnvironmentMutation,
  useReconcileConversationCodeEnvironmentMutation,
} from '~/data-provider';
import { codeWorkspaceErrorKeys, getCodeWorkspaceErrorReason, getResponseStatus } from '~/utils';
import { useLocalize } from '~/hooks';

/** Conflicts refresh the decision; definitive rejections keep their specific explanation. */
function transitionErrorKey(error: unknown): TranslationKeys {
  const reason = getCodeWorkspaceErrorReason(error);
  if (reason === 'locked') return 'com_ui_code_workspace_move_stale';
  if (reason != null) return codeWorkspaceErrorKeys[reason];
  if (getResponseStatus(error) === 409) return 'com_ui_code_workspace_move_busy';
  return 'com_ui_code_workspace_move_error';
}

/** One machine's workspace list, read while its menu is open. An idle machine is not queried. */
function useMachineStatus(id: string | null, enabled: boolean): WorkspaceMachineQuery {
  const queries = useCodeEnvironmentStatusQueries(id != null ? [id] : [], enabled && id != null);
  const query = queries[0];
  return {
    data: query?.data,
    isLoading: query?.isLoading === true,
    refetch: () => {
      void query?.refetch();
    },
  };
}

export default function CodeWorkspaceMenu({
  setConversation,
  workspace,
  disabled,
}: {
  setConversation: SetterOrUpdater<TConversation | null>;
  workspace: CodeWorkspaceResult;
  disabled: boolean;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const moveMutation = useMoveConversationCodeEnvironmentMutation(setConversation);
  const reconcileMutation = useReconcileConversationCodeEnvironmentMutation(setConversation);
  const { refresh, isRefreshing } = useCodeWorkspaceRefresh();
  return (
    <WorkspaceMenu
      setConversation={setConversation}
      workspace={workspace}
      disabled={disabled}
      localize={(phraseKey, options) => localize(phraseKey as TranslationKeys, options)}
      showToast={showToast}
      refresh={refresh}
      isRefreshing={isRefreshing}
      movePending={moveMutation.isLoading}
      reconcilePending={reconcileMutation.isLoading}
      applyMove={(request, handlers) => moveMutation.mutate(request, handlers)}
      reconcile={(request) => reconcileMutation.mutate(request)}
      useMachineStatus={useMachineStatus}
      moveErrorMessage={(error) => localize(transitionErrorKey(error))}
    />
  );
}
