import { ShieldEllipsis } from 'lucide-react';
import { Button, useToastContext } from '@librechat/client';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { PermissionConfig } from '~/components/ui';
import { useUpdateArtifactPermissionsMutation } from '~/data-provider';
import { AdminSettingsDialog } from '~/components/ui';
import { useLocalize } from '~/hooks';

const permissions: PermissionConfig[] = [
  { permission: Permissions.USE, labelKey: 'com_ui_artifacts_allow_use' },
  { permission: Permissions.CREATE, labelKey: 'com_ui_artifacts_allow_create' },
  { permission: Permissions.SHARE, labelKey: 'com_ui_artifacts_allow_share' },
  { permission: Permissions.SHARE_PUBLIC, labelKey: 'com_ui_artifacts_allow_share_public' },
];

const ArtifactAppsAdminSettings = ({ compact = false }: { compact?: boolean }) => {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const mutation = useUpdateArtifactPermissionsMutation({
    onSuccess: () => showToast({ status: 'success', message: localize('com_ui_saved') }),
    onError: () =>
      showToast({ status: 'error', message: localize('com_ui_error_save_admin_settings') }),
  });

  const trigger = (
    <Button
      size={compact ? 'icon' : undefined}
      variant="outline"
      className={
        compact
          ? 'rounded-xl bg-presentation duration-0 hover:bg-surface-active-alt'
          : 'relative h-12 rounded-xl border-border-medium font-medium'
      }
      aria-label={localize('com_ui_admin_settings')}
      data-testid="artifact-apps-admin-settings-button"
    >
      <ShieldEllipsis className={compact ? 'icon-md' : 'cursor-pointer'} aria-hidden="true" />
    </Button>
  );

  return (
    <AdminSettingsDialog
      permissionType={PermissionTypes.ARTIFACTS}
      sectionKey="com_ui_artifact_apps"
      permissions={permissions}
      menuId="artifact-role-dropdown"
      mutation={mutation}
      trigger={trigger}
      dialogContentClassName="w-11/12 max-w-md border-border-light bg-surface-primary text-text-primary"
      showAdminWarning={false}
    />
  );
};

export default ArtifactAppsAdminSettings;
