import { useParams, Navigate } from 'react-router-dom';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { usePromptOpened } from '~/hooks/Prompts/usePromptTracking';
import PromptForm from '../forms/PromptForm';
import { useHasAccess } from '~/hooks';

export default function InlinePromptsView() {
  const { promptId } = useParams();

  const hasAccess = useHasAccess({
    permissionType: PermissionTypes.PROMPTS,
    permission: Permissions.USE,
  });
  usePromptOpened('route', hasAccess && !promptId);

  if (!hasAccess) {
    return <Navigate to="/c/new" replace />;
  }

  return (
    <div className="bg-surface-primary-alt flex h-full w-full flex-col overflow-y-auto">
      <PromptForm promptId={promptId} />
    </div>
  );
}
