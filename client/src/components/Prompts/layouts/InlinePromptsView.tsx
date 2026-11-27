import { Button, Spinner } from '@librechat/client';
import { useParams, Navigate } from 'react-router-dom';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { useHasAccess, useAuthContext, useLocalize } from '~/hooks';
import PromptForm from '../forms/PromptForm';
import { useGetRole } from '~/data-provider';

export default function InlinePromptsView() {
  const { promptId } = useParams();
  const localize = useLocalize();
  const { user, roles } = useAuthContext();

  const hasAccess = useHasAccess({
    permissionType: PermissionTypes.PROMPTS,
    permission: Permissions.USE,
  });

  // Shares the auth context's role query, which keeps no error of its own.
  const roleQuery = useGetRole(user?.role ?? '_', { enabled: user?.role != null });

  // On a fresh page load the roles arrive after the first render; redirect only once they are known.
  const rolesLoaded = user?.role != null && roles?.[user.role] != null;
  if (!rolesLoaded && roleQuery.isError) {
    return (
      <div className="bg-surface-primary-alt text-text-secondary flex h-full w-full flex-col items-center justify-center gap-2 text-sm">
        <span role="alert">{localize('com_ui_prompt_permissions_load_error')}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={roleQuery.isFetching}
          onClick={() => void roleQuery.refetch()}
        >
          {localize('com_ui_retry')}
        </Button>
      </div>
    );
  }
  if (!rolesLoaded) {
    return (
      <div className="bg-surface-primary-alt flex h-full w-full items-center justify-center">
        <Spinner tone="secondary" aria-label={localize('com_ui_loading')} />
      </div>
    );
  }

  if (!hasAccess) {
    return <Navigate to="/c/new" replace />;
  }

  return (
    <div className="bg-surface-primary-alt flex h-full w-full flex-col overflow-y-auto">
      <PromptForm promptId={promptId} />
    </div>
  );
}
