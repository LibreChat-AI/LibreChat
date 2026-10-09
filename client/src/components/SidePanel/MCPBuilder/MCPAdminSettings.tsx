import { Permissions, PermissionTypes } from 'librechat-data-provider';
import { useToastContext } from '@librechat/client';
import { AdminSettingsDialog } from '~/components/ui';
import { useUpdateMCPServersPermissionsMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';
import type { PermissionConfig } from '~/components/ui';

const permissions: PermissionConfig[] = [
  { permission: Permissions.USE, labelKey: 'com_ui_mcp_servers_allow_use' },
  { permission: Permissions.CREATE, labelKey: 'com_ui_mcp_servers_allow_create' },
  { permission: Permissions.SHARE, labelKey: 'com_ui_mcp_servers_allow_share' },
  { permission: Permissions.SHARE_PUBLIC, labelKey: 'com_ui_mcp_servers_allow_share_public' },
  {
    permission: Permissions.CONFIGURE_OBO,
    labelKey: 'com_ui_mcp_servers_allow_configure_obo',
  },
];

const MCPAdminSettings = () => {
  const localize = useLocalize();
  const { showToast } = useToastContext();

  const mutation = useUpdateMCPServersPermissionsMutation({
    onSuccess: () => {
      showToast({ status: 'success', message: localize('com_ui_saved') });
    },
    onError: () => {
      showToast({ status: 'error', message: localize('com_ui_error_save_admin_settings') });
    },
  });

  return (
    <AdminSettingsDialog
      permissionType={PermissionTypes.MCP_SERVERS}
      sectionKey="com_ui_mcp_servers"
      permissions={permissions}
      menuId="mcp-role-dropdown"
      mutation={mutation}
    />
  );
};

export default MCPAdminSettings;
