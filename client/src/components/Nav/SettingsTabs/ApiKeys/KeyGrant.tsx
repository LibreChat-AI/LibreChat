import { useId, useMemo, useState } from 'react';
import { PermissionBits } from 'librechat-data-provider';
import { Label, ControlCombobox } from '@librechat/client';
import type { MutableRefObject } from 'react';
import type { GrantCopy } from '~/components/MCP/GrantDialog';
import { useApiKeyMCPConsent, useApiKeyMCPConsentMutations } from '~/data-provider/ApiKeys/consent';
import GrantDialog from '~/components/MCP/GrantDialog';
import { useListAgentsQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';

const copy: GrantCopy = {
  title: 'com_ui_api_key_grant_title',
  boundary: 'com_ui_api_key_grant_boundary',
  status: {
    changed: 'com_ui_api_key_grant_changed',
    unsupported: 'com_ui_api_key_grant_unsupported',
  },
  confirmed: 'com_ui_api_key_grant_confirmed',
};

/** What a run started with this key may use, for the agent the owner picks. */
export default function KeyGrant({
  id,
  name,
  onOpenChange,
  triggerRef,
}: {
  id: string;
  name: string;
  onOpenChange: (open: boolean) => void;
  triggerRef: MutableRefObject<HTMLButtonElement | null>;
}) {
  const localize = useLocalize();
  const selectId = useId();
  const [agentId, setAgentId] = useState('');
  const { data: agents } = useListAgentsQuery(
    { requiredPermission: PermissionBits.VIEW },
    { select: (res) => res.data },
  );
  const agentItems = useMemo(
    () => (agents ?? []).map((agent) => ({ label: agent.name || agent.id, value: agent.id })),
    [agents],
  );
  const query = useApiKeyMCPConsent(id, agentId);
  const { confirm, revoke } = useApiKeyMCPConsentMutations(id, agentId);
  return (
    <GrantDialog
      source={{ query, confirm, revoke }}
      copy={copy}
      name={name}
      subjectKey={agentId}
      onOpenChange={onOpenChange}
      triggerRef={triggerRef}
    >
      <div className="space-y-2">
        <Label htmlFor={selectId} className="text-sm font-medium">
          {localize('com_ui_agent')}
        </Label>
        <ControlCombobox
          selectedValue={agentId}
          displayValue={agentItems.find((item) => item.value === agentId)?.label ?? ''}
          selectPlaceholder={localize('com_ui_select_agent')}
          searchPlaceholder={localize('com_agents_search_name')}
          setValue={setAgentId}
          items={agentItems}
          ariaLabel={localize('com_ui_agent')}
          selectId={selectId}
          isCollapsed={false}
          showCarat={true}
          placement="bottom-start"
          // The dialog traps focus, so a popover portaled to the body could not be used.
          portal={false}
          matchTriggerWidth={true}
          variant="field"
        />
        {agentId === '' && (
          <p className="text-text-secondary text-sm">
            {localize('com_ui_api_key_grant_choose_agent')}
          </p>
        )}
      </div>
    </GrantDialog>
  );
}
