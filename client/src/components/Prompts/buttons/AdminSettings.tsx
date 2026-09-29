import { useState } from 'react';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import { OGDialog, OGDialogTemplate, useToastContext } from '@librechat/client';
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
  const [confirmAdminUseChange, setConfirmAdminUseChange] = useState<{
    newValue: boolean;
    callback: (value: boolean) => void;
  } | null>(null);

  const mutation = useUpdatePromptPermissionsMutation({
    onSuccess: () => {
      showToast({ status: 'success', message: localize('com_ui_saved') });
    },
    onError: () => {
      showToast({ status: 'error', message: localize('com_ui_error_save_admin_settings') });
    },
  });

  const handlePermissionConfirm = (
    _permission: Permissions,
    newValue: boolean,
    onChange: (value: boolean) => void,
  ) => {
    setConfirmAdminUseChange({ newValue, callback: onChange });
  };

  const confirmDialog = (
    <OGDialog
      open={confirmAdminUseChange !== null}
      onOpenChange={(open) => {
        if (!open) {
          setConfirmAdminUseChange(null);
        }
      }}
    >
      <OGDialogTemplate
        showCloseButton={true}
        title={localize('com_ui_confirm_change')}
        className="w-11/12 max-w-lg"
        main={<p className="mb-4">{localize('com_ui_confirm_admin_use_change')}</p>}
        selection={{
          selectHandler: () => {
            if (confirmAdminUseChange) {
              confirmAdminUseChange.callback(confirmAdminUseChange.newValue);
            }
            setConfirmAdminUseChange(null);
          },
          selectClasses:
            'bg-surface-destructive hover:bg-surface-destructive-hover text-text-on-status transition-colors duration-200',
          selectText: localize('com_ui_confirm_action'),
          isLoading: false,
        }}
      />
    </OGDialog>
  );

  return (
    <AdminSettingsDialog
      permissionType={PermissionTypes.PROMPTS}
      sectionKey="com_ui_prompts"
      permissions={permissions}
      menuId="prompt-role-dropdown"
      mutation={mutation}
      onPermissionConfirm={handlePermissionConfirm}
      confirmPermissions={[Permissions.USE]}
      extraContent={confirmDialog}
    />
  );
};

export default AdminSettings;
