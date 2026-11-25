import { useId, useState, useEffect } from 'react';
import { ShieldOff } from 'lucide-react';
import * as Ariakit from '@ariakit/react';
import { useMutation } from '@tanstack/react-query';
import { dataService, MutationKeys } from 'librechat-data-provider';
import { Button, DropdownPopup, TooltipAnchor, useToastContext } from '@librechat/client';
import { useGetAgentsConfig, useLocalize } from '~/hooks';

/** Personal consent is independent of permission to edit the shared agent. */
export default function ResetApprovals({
  agentId,
  disabled = false,
}: {
  agentId: string;
  disabled?: boolean;
}) {
  const localize = useLocalize();
  const { agentsConfig } = useGetAgentsConfig();
  const { showToast } = useToastContext();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const reset = useMutation(dataService.resetToolApprovalGrants, {
    mutationKey: [MutationKeys.resetToolApprovalGrants],
    onSuccess: () => {
      setOpen(false);
      showToast({ message: localize('com_ui_tool_approval_reset_success'), status: 'success' });
    },
  });
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [open]);
  if (agentsConfig?.toolApproval?.agentModes !== true) return null;
  const label = localize('com_ui_tool_approval_reset');
  return (
    <DropdownPopup
      menuId={menuId}
      isOpen={open}
      setIsOpen={setOpen}
      portal
      focusLoop
      unmountOnHide
      items={[
        {
          id: `${menuId}-reset`,
          label: localize(
            reset.isError ? 'com_ui_tool_approval_reset_error' : 'com_ui_tool_approval_reset',
          ),
          disabled: disabled || reset.isLoading,
          hideOnClick: false,
          onClick: () => {
            if (!disabled) reset.mutate({ agentId });
          },
        },
      ]}
      trigger={
        <TooltipAnchor
          description={label}
          render={
            <Ariakit.MenuButton
              aria-label={label}
              aria-expanded={open}
              disabled={disabled || reset.isLoading}
              render={<Button type="button" variant="outline" size="icon-sm" />}
            >
              <ShieldOff className="size-4" aria-hidden="true" />
            </Ariakit.MenuButton>
          }
        />
      }
    />
  );
}
