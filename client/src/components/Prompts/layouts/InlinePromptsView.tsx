import { Spinner } from '@librechat/client';
import { useParams, Navigate } from 'react-router-dom';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { useHasAccess, useAuthContext, useLocalize } from '~/hooks';
import PromptsCollection from './PromptsCollection';
import PromptForm from '../forms/PromptForm';

export default function InlinePromptsView() {
  const { promptId } = useParams();
  const localize = useLocalize();
  const { user, roles } = useAuthContext();

  const hasAccess = useHasAccess({
    permissionType: PermissionTypes.PROMPTS,
    permission: Permissions.USE,
  });

  if (user?.role == null || roles?.[user.role] == null) {
    return (
      <div role="status" aria-label={localize('com_ui_loading')}>
        <Spinner tone="secondary" />
      </div>
    );
  }

  if (!hasAccess) {
    return <Navigate to="/c/new" replace />;
  }

  return (
    <div className="bg-surface-primary-alt flex h-full w-full flex-col overflow-y-auto">
      {promptId ? <PromptForm promptId={promptId} /> : <PromptsCollection />}
    </div>
  );
}
