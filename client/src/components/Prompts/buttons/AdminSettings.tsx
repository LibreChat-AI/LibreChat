import { useToastContext } from '@librechat/client';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { PermissionConfig } from '~/components/ui';
import { useUpdatePromptPermissionsMutation } from '~/data-provider';
import { AdminSettingsDialog } from '~/components/ui';
import { useLocalize } from '~/hooks';

const permissions: PermissionConfig[] = [
  { permission: Permissions.USE, labelKey: 'com_ui_prompts_allow_use' },
  { permission: Permissions.CREATE, labelKey: 'com_ui_prompts_allow_create' },
  { permission: Permissions.SHARE, labelKey: 'com_ui_prompts_allow_share' },
  { permission: Permissions.SHARE_PUBLIC, labelKey: 'com_ui_prompts_allow_share_public' },
];

const AdminSettings = () => {
  const localize = useLocalize();
  const { showToast } = useToastContext();

  const mutation = useUpdatePromptPermissionsMutation({
    onSuccess: () => {
      showToast({ status: 'success', message: localize('com_ui_saved') });
    },
    onError: () => {
      showToast({ status: 'error', message: localize('com_ui_error_save_admin_settings') });
    },
  });

  return (
    <AdminSettingsDialog
      permissionType={PermissionTypes.PROMPTS}
      sectionKey="com_ui_prompts"
      permissions={permissions}
      menuId="prompt-role-dropdown"
      mutation={mutation}
    />
  );
};

export default AdminSettings;
