import { useId, useState, useEffect } from 'react';
import * as Ariakit from '@ariakit/react';
import { useMutation } from '@tanstack/react-query';
import { dataService, MutationKeys } from 'librechat-data-provider';
import { Button, DropdownPopup, TooltipAnchor } from '@librechat/client';
import { Check, Shield, ShieldCheck, ShieldQuestion, MessageCircle, Minus } from 'lucide-react';
import type { AgentToolApprovalMode } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';

const LABELS: Record<AgentToolApprovalMode | 'inherit' | 'mixed', TranslationKeys> = {
  inherit: 'com_ui_tool_approval_inherit',
  ask: 'com_ui_tool_approval_ask',
  allow: 'com_ui_tool_approval_allow',
  chat: 'com_ui_tool_approval_chat',
  always: 'com_ui_tool_approval_always',
  mixed: 'com_ui_tool_approval_mixed',
};

const MODES: Array<AgentToolApprovalMode | 'inherit'> = [
  'inherit',
  'ask',
  'allow',
  'chat',
  'always',
];

export default function ApprovalOption({
  mode,
  onChange,
  bulk = false,
  disabled = false,
  constraint,
  agentId,
  toolName,
}: {
  mode?: AgentToolApprovalMode | 'mixed';
  onChange: (mode?: AgentToolApprovalMode) => void;
  bulk?: boolean;
  disabled?: boolean;
  constraint?: 'ask' | 'deny';
  agentId?: string;
  toolName?: string;
}) {
  const localize = useLocalize();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const reset = useMutation(dataService.resetToolApprovalGrants, {
    mutationKey: [MutationKeys.resetToolApprovalGrants],
  });
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // OGDialog prevents the native Escape before Ariakit can dismiss its popup.
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [open]);
  const selected = mode ?? 'inherit';
  const items = MODES.map((value) => ({
    id: `${menuId}-${value}`,
    label: localize(LABELS[value]),
    ariaChecked: selected === value,
    disabled: constraint != null && value !== 'inherit' && value !== 'ask',
    icon: selected === value ? <Check className="size-4" aria-hidden="true" /> : undefined,
    onClick: () => onChange(value === 'inherit' ? undefined : value),
  }));
  const label = localize(bulk ? 'com_ui_tool_approval_bulk' : 'com_ui_tool_approval_mode');
  let tooltip = `${label}: ${localize(LABELS[selected])}`;
  if (constraint) {
    tooltip = localize(
      constraint === 'ask' ? 'com_ui_tool_approval_admin_ask' : 'com_ui_tool_approval_admin_deny',
    );
  }
  if (disabled) tooltip = localize('com_ui_tool_approval_disabled');
  const icons = {
    inherit: Shield,
    ask: ShieldQuestion,
    allow: ShieldCheck,
    chat: MessageCircle,
    always: ShieldCheck,
    mixed: Minus,
  };
  const Icon = constraint === 'ask' ? ShieldQuestion : icons[selected];

  return (
    <DropdownPopup
      menuId={menuId}
      isOpen={open}
      setIsOpen={setOpen}
      portal={true}
      focusLoop={true}
      unmountOnHide={true}
      items={[
        ...items,
        ...(agentId && toolName && (mode === 'chat' || mode === 'always')
          ? [
              {
                id: `${menuId}-reset`,
                label: localize(
                  reset.isError ? 'com_ui_tool_approval_reset_error' : 'com_ui_tool_approval_reset',
                ),
                disabled: reset.isLoading,
                hideOnClick: false,
                onClick: () =>
                  reset.mutate({ agentId, toolName }, { onSuccess: () => setOpen(false) }),
              },
            ]
          : []),
      ]}
      trigger={
        <TooltipAnchor
          description={tooltip}
          side="top"
          render={
            <Ariakit.MenuButton
              aria-label={tooltip}
              aria-expanded={open}
              disabled={disabled}
              accessibleWhenDisabled={true}
              render={
                <Button
                  type="button"
                  variant={mode != null || constraint != null ? 'outline' : 'section-action'}
                  size={bulk ? 'icon-sm' : 'icon-xs'}
                />
              }
            >
              <Icon className="size-4" aria-hidden="true" />
            </Ariakit.MenuButton>
          }
        />
      }
    />
  );
}
