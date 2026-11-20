import { useId, useMemo, useState } from 'react';
import { Label, Button, Spinner, ControlCombobox } from '@librechat/client';
import type { MutableRefObject } from 'react';
import type { GrantCopy } from '~/components/MCP/GrantDialog';
import {
  useApiKeyAgents,
  useApiKeyMCPConsent,
  useApiKeyMCPConsentMutations,
} from '~/data-provider/ApiKeys/consent';
import GrantDialog from '~/components/MCP/GrantDialog';
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
  /** The agents this key could run, which is not the catalog the owner browses in the app. */
  const list = useApiKeyAgents();
  const agents = list.data;
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
        {list.isLoading && <Spinner aria-label={localize('com_ui_loading')} />}
        {/* Nothing below can be asked for until an agent is picked, so a list that could not
            be read is said here, with a way to try again. A stale list stays usable. */}
        {!list.isLoading && list.isError && agents == null && (
          <div role="alert" className="space-y-2">
            <p className="text-text-primary text-sm">
              {localize('com_ui_api_key_grant_agents_error')}
            </p>
            <Button variant="outline" onClick={() => list.refetch()}>
              {localize('com_ui_retry')}
            </Button>
          </div>
        )}
        {agents != null && agents.length === 0 && (
          <p className="text-text-secondary text-sm">
            {localize('com_ui_api_key_grant_no_agents')}
          </p>
        )}
        {agents != null && agents.length > 0 && (
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
        )}
        {agentId === '' && agents != null && agents.length > 0 && (
          <p className="text-text-secondary text-sm">
            {localize('com_ui_api_key_grant_choose_agent')}
          </p>
        )}
      </div>
    </GrantDialog>
  );
}
