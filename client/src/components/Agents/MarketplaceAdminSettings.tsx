import { ShieldEllipsis } from 'lucide-react';
import { Button, useToastContext } from '@librechat/client';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { PermissionConfig } from '~/components/ui';
import { useUpdateMarketplacePermissionsMutation } from '~/data-provider';
import { AdminSettingsDialog } from '~/components/ui';
import { useLocalize } from '~/hooks';

const permissions: PermissionConfig[] = [
  { permission: Permissions.USE, labelKey: 'com_ui_marketplace_allow_use' },
];

const MarketplaceAdminSettings = () => {
  const localize = useLocalize();
  const { showToast } = useToastContext();

  const mutation = useUpdateMarketplacePermissionsMutation({
    onSuccess: () => {
      showToast({ status: 'success', message: localize('com_ui_saved') });
    },
    onError: () => {
      showToast({ status: 'error', message: localize('com_ui_error_save_admin_settings') });
    },
  });

  /* `outline` matches the search field it sits beside — same border token, same
     radius — and `size-9` keeps the two controls the same height. */
  const trigger = (
    <Button
      size="icon-sm"
      variant="outline"
      className="size-9 shrink-0 transition-none"
      aria-label={localize('com_ui_admin_settings')}
    >
      <ShieldEllipsis className="size-4" aria-hidden="true" />
    </Button>
  );

  return (
    <AdminSettingsDialog
      permissionType={PermissionTypes.MARKETPLACE}
      sectionKey="com_ui_marketplace"
      permissions={permissions}
      menuId="marketplace-role-dropdown"
      mutation={mutation}
      trigger={trigger}
      showAdminWarning={false}
    />
  );
};

export default MarketplaceAdminSettings;
