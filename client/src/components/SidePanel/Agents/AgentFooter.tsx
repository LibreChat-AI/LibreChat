import { Globe } from 'lucide-react';
import { Button, Spinner } from '@librechat/client';
import { useWatch, useFormContext } from 'react-hook-form';
import {
  SystemRoles,
  Permissions,
  ResourceType,
  PermissionBits,
  PermissionTypes,
} from 'librechat-data-provider';
import type { AgentForm, AgentPanelProps } from '~/common';
import { useLocalize, useAuthContext, useHasAccess, useResourcePermissions } from '~/hooks';
import { GenericGrantAccessDialog } from '~/components/Sharing';
import { useUpdateAgentMutation } from '~/data-provider';
import AdvancedButton from './Advanced/AdvancedButton';
import VersionButton from './Version/VersionButton';
import DuplicateAgent from './DuplicateAgent';
import AdminSettings from './AdminSettings';
import DeleteButton from './DeleteButton';
import { Panel } from '~/common';

export default function AgentFooter({
  activePanel,
  createMutation,
  updateMutation,
  setActivePanel,
  setCurrentAgentId,
  isAvatarUploading = false,
}: Pick<
  AgentPanelProps,
  'setCurrentAgentId' | 'createMutation' | 'activePanel' | 'setActivePanel'
> & {
  updateMutation: ReturnType<typeof useUpdateAgentMutation>;
  isAvatarUploading?: boolean;
}) {
  const localize = useLocalize();
  const { user } = useAuthContext();

  const methods = useFormContext<AgentForm>();

  const { control } = methods;
  const agent = useWatch({ control, name: 'agent' });
  const agent_id = useWatch({ control, name: 'id' });
  const hasAccessToShareAgents = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.SHARE,
  });
  const hasAccessToShareRemoteAgents = useHasAccess({
    permissionType: PermissionTypes.REMOTE_AGENTS,
    permission: Permissions.SHARE,
  });
  const { hasPermission, isLoading: permissionsLoading } = useResourcePermissions(
    ResourceType.AGENT,
    agent?._id || '',
  );
  const { hasPermission: hasRemoteAgentPermission, isLoading: remotePermissionsLoading } =
    useResourcePermissions(ResourceType.REMOTE_AGENT, agent?._id || '');

  const canShareThisAgent = hasPermission(PermissionBits.SHARE);
  const canEditThisAgent = hasPermission(PermissionBits.EDIT);
  const canDeleteThisAgent = hasPermission(PermissionBits.DELETE);
  const canShareRemoteAgent = hasRemoteAgentPermission(PermissionBits.SHARE);
  const isAdmin = user?.role === SystemRoles.ADMIN;
  const isSaving = createMutation.isLoading || updateMutation.isLoading || isAvatarUploading;
  const saveLabel = agent_id ? localize('com_ui_save') : localize('com_ui_create');
  const renderSaveButton = () => (
    <span className="t-icon-swap" data-state={isSaving ? 'b' : 'a'} aria-hidden={false}>
      <span className="t-icon" data-icon="a">
        {saveLabel}
      </span>
      <span className="t-icon" data-icon="b">
        <Spinner className="icon-md" aria-hidden="true" />
      </span>
    </span>
  );

  const showButtons = activePanel === Panel.builder;

  return (
    <div className="mb-1 flex w-full flex-col gap-2">
      {showButtons && (
        <div className={`grid gap-2 ${agent_id ? 'grid-cols-2' : 'grid-cols-1'}`}>
          <AdvancedButton setActivePanel={setActivePanel} />
          {!!agent_id && <VersionButton setActivePanel={setActivePanel} />}
        </div>
      )}
      {user?.role === SystemRoles.ADMIN && showButtons && <AdminSettings />}
      {/* Context Button */}
      <div className="flex items-center justify-end gap-2">
        {(agent?.author === user?.id || user?.role === SystemRoles.ADMIN || canDeleteThisAgent) &&
          !permissionsLoading && (
            <DeleteButton
              agent_id={agent_id}
              setCurrentAgentId={setCurrentAgentId}
              createMutation={createMutation}
            />
          )}
        {(agent?.author === user?.id || isAdmin || canShareThisAgent) &&
          (hasAccessToShareAgents || isAdmin) &&
          !permissionsLoading && (
            <GenericGrantAccessDialog
              resourceDbId={agent?._id}
              resourceId={agent_id}
              resourceName={agent?.name ?? ''}
              resourceType={ResourceType.AGENT}
            />
          )}
        {(agent?.author === user?.id || user?.role === SystemRoles.ADMIN || canShareRemoteAgent) &&
          hasAccessToShareRemoteAgents &&
          !remotePermissionsLoading &&
          agent?._id && (
            <GenericGrantAccessDialog
              resourceDbId={agent?._id}
              resourceId={agent_id}
              resourceName={agent?.name ?? ''}
              resourceType={ResourceType.REMOTE_AGENT}
            >
              <Button
                type="button"
                variant="outline"
                aria-label={localize('com_ui_remote_access')}
                title={localize('com_ui_remote_access')}
                className="h-9 w-auto px-3"
              >
                <Globe className="h-4 w-4" aria-hidden="true" />
              </Button>
            </GenericGrantAccessDialog>
          )}
        {(agent?.author === user?.id || user?.role === SystemRoles.ADMIN || canEditThisAgent) &&
          !permissionsLoading && <DuplicateAgent agent_id={agent_id} />}
        {/* Submit Button */}
        <Button
          variant="submit"
          className="h-9 w-full px-4 py-2 font-semibold"
          type="submit"
          disabled={isSaving}
          aria-busy={isSaving}
          aria-label={saveLabel}
        >
          {renderSaveButton()}
        </Button>
      </div>
    </div>
  );
}
