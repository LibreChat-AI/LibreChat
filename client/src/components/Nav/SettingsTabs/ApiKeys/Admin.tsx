import { ShieldEllipsis } from 'lucide-react';
import { Button, useToastContext } from '@librechat/client';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { PermissionConfig } from '~/components/ui';
import { useUpdateRemoteAgentsPermissionsMutation } from '~/data-provider';
import { AdminSettingsDialog } from '~/components/ui';
import { useLocalize } from '~/hooks';

const remoteAgentsPermissions: PermissionConfig[] = [
  { permission: Permissions.USE, labelKey: 'com_ui_remote_agents_allow_use' },
  { permission: Permissions.CREATE, labelKey: 'com_ui_remote_agents_allow_create' },
  { permission: Permissions.SHARE, labelKey: 'com_ui_remote_agents_allow_share' },
  { permission: Permissions.SHARE_PUBLIC, labelKey: 'com_ui_remote_agents_allow_share_public' },
];

export default function Admin() {
  const localize = useLocalize();
  const { showToast } = useToastContext();

  const mutation = useUpdateRemoteAgentsPermissionsMutation({
    onSuccess: () => {
      showToast({ status: 'success', message: localize('com_ui_saved') });
    },
    onError: () => {
      showToast({ status: 'error', message: localize('com_ui_error_save_admin_settings') });
    },
  });

  const trigger = (
    <Button variant="outline" size="sm" className="gap-1.5 text-text-secondary">
      <ShieldEllipsis className="h-4 w-4" aria-hidden="true" />
      {localize('com_ui_admin_panel')}
    </Button>
  );

  return (
    <AdminSettingsDialog
      permissionType={PermissionTypes.REMOTE_AGENTS}
      sectionKey="com_ui_remote_agents"
      permissions={remoteAgentsPermissions}
      menuId="remote-agents-role-dropdown"
      mutation={mutation}
      trigger={trigger}
    />
  );
}
