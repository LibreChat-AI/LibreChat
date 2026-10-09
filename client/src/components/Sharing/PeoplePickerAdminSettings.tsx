import { ShieldEllipsis } from 'lucide-react';
import { Button, useToastContext } from '@librechat/client';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { PermissionConfig } from '~/components/ui';
import { useUpdatePeoplePickerPermissionsMutation } from '~/data-provider';
import { AdminSettingsDialog } from '~/components/ui';
import { useLocalize } from '~/hooks';

const permissions: PermissionConfig[] = [
  { permission: Permissions.VIEW_USERS, labelKey: 'com_ui_people_picker_allow_view_users' },
  { permission: Permissions.VIEW_GROUPS, labelKey: 'com_ui_people_picker_allow_view_groups' },
  { permission: Permissions.VIEW_ROLES, labelKey: 'com_ui_people_picker_allow_view_roles' },
];

const PeoplePickerAdminSettings = () => {
  const localize = useLocalize();
  const { showToast } = useToastContext();

  const mutation = useUpdatePeoplePickerPermissionsMutation({
    onSuccess: () => {
      showToast({ status: 'success', message: localize('com_ui_saved') });
    },
    onError: () => {
      showToast({ status: 'error', message: localize('com_ui_error_save_admin_settings') });
    },
  });

  const trigger = (
    <Button
      type="button"
      variant="outline"
      className="gap-2 rounded-lg font-medium"
      aria-label={localize('com_ui_admin_settings')}
    >
      <ShieldEllipsis className="size-4" aria-hidden="true" />
      {localize('com_ui_admin_settings')}
    </Button>
  );

  return (
    <AdminSettingsDialog
      permissionType={PermissionTypes.PEOPLE_PICKER}
      sectionKey="com_ui_people_picker"
      descriptionKey="com_ui_people_picker_admin_description"
      permissions={permissions}
      menuId="people-picker-role-dropdown"
      mutation={mutation}
      trigger={trigger}
      showAdminWarning={false}
    />
  );
};

export default PeoplePickerAdminSettings;
