import React, { useCallback, useMemo } from 'react';
import { Switch } from '@librechat/client';
import { Network, Users } from 'lucide-react';
import type { ControllerRenderProps } from 'react-hook-form';
import type { AgentForm } from '~/common';
import { StaticAgentRow, AddAgentSelect, ListMeta, useSelectableAgents } from './AgentList';
import OrchestrationPattern from './OrchestrationPattern';
import { useLocalize } from '~/hooks';
import { ToggleSetting } from './ui';

interface AgentSubagentsProps {
  field: ControllerRenderProps<AgentForm, 'subagents'>;
  currentAgentId: string;
  maxSubagents: number;
  fileSharingEnabled?: boolean;
}

const AgentSubagents: React.FC<AgentSubagentsProps> = ({
  field,
  currentAgentId,
  maxSubagents,
  fileSharingEnabled = false,
}) => {
  const localize = useLocalize();

  const fieldValue = field.value;
  const value = useMemo(() => fieldValue ?? {}, [fieldValue]);
  const enabled = value.enabled === true;
  const allowSelf = value.allowSelf !== false;
  const agentIds = useMemo(() => value.agent_ids ?? [], [value.agent_ids]);
  const graphCount = value.graphs?.length ?? 0;

  const { options, getAgent } = useSelectableAgents({ currentAgentId, exclude: agentIds });

  const setEnabled = useCallback(
    (next: boolean) => {
      /**
       * Persist `{ enabled: false }` (with the existing selections preserved)
       * rather than `undefined`. The backend's `removeNullishValues` strips
       * undefined fields from PATCH payloads, so setting the whole object to
       * undefined would leave the server copy enabled. An explicit
       * `enabled: false` flows through as a real update.
       */
      field.onChange({
        ...value,
        enabled: next,
        allowSelf: value.allowSelf ?? true,
        agent_ids: value.agent_ids ?? [],
      });
    },
    [field, value],
  );

  const setAllowSelf = useCallback(
    (next: boolean) => {
      field.onChange({ ...value, enabled: true, allowSelf: next });
    },
    [field, value],
  );

  const setShareFiles = useCallback(
    (next: boolean) => {
      field.onChange({ ...value, shareFiles: next });
    },
    [field, value],
  );

  const setAgentIds = useCallback(
    (ids: string[]) => {
      field.onChange({
        ...value,
        enabled: true,
        allowSelf: value.allowSelf ?? true,
        agent_ids: ids,
      });
    },
    [field, value],
  );

  const addAgent = useCallback(
    (agentId: string) => {
      if (!agentId || agentIds.length >= maxSubagents || agentIds.includes(agentId)) {
        return;
      }

      /** Commit the selection directly to react-hook-form. Deferring this
       * through component state and an effect allowed an immediate form submit
       * to persist the enable toggles before the selected roster. */
      setAgentIds([...agentIds, agentId]);
    },
    [agentIds, maxSubagents, setAgentIds],
  );

  const removeAgentAt = (index: number) => {
    setAgentIds(agentIds.filter((_, i) => i !== index));
  };

  const selfId = 'subagents-self-toggle';
  const nothingToSpawn = enabled && !allowSelf && agentIds.length === 0 && graphCount === 0;

  return (
    <OrchestrationPattern
      icon={<Network className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />}
      title={localize('com_ui_agent_subagents')}
      subtitle={localize('com_ui_agent_subagents_subtitle')}
      beta
      info={
        <>
          <p className="text-sm text-text-secondary">{localize('com_ui_agent_subagents_info')}</p>
          <p className="text-sm text-text-secondary">{localize('com_ui_agent_subagents_info_2')}</p>
        </>
      }
      trailing={
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={localize('com_ui_agent_subagents_enable')}
        />
      }
    >
      {enabled && (
        <>
          <ToggleSetting
            id={selfId}
            label={localize('com_ui_agent_subagents_allow_self')}
            checked={allowSelf}
            onCheckedChange={setAllowSelf}
            info={
              <p className="text-sm text-text-secondary">
                {localize('com_ui_agent_subagents_allow_self_info')}
              </p>
            }
          />

          {fileSharingEnabled && (
            <ToggleSetting
              id="subagents-share-files-toggle"
              label={localize('com_ui_agent_subagents_share_files')}
              checked={value.shareFiles === true}
              onCheckedChange={setShareFiles}
              info={
                <p className="text-sm text-text-secondary">
                  {localize('com_ui_agent_subagents_share_files_info')}
                </p>
              }
            />
          )}

          <div className="flex flex-col gap-0.5">
            <ListMeta
              label={localize('com_ui_agent_subagents_agents')}
              count={agentIds.length}
              max={maxSubagents}
            />

            {agentIds.map((agentId, idx) => {
              const details = getAgent(agentId);
              return (
                <StaticAgentRow
                  key={agentId}
                  agent={details}
                  name={details?.name ?? agentId}
                  onRemove={() => removeAgentAt(idx)}
                  removeLabel={localize('com_ui_agent_subagents_remove', {
                    0: details?.name ?? agentId,
                  })}
                />
              );
            })}

            {agentIds.length < maxSubagents && (
              <AddAgentSelect
                options={options}
                onSelect={addAgent}
                placeholder={localize('com_ui_agent_subagents_add')}
                ariaLabel={localize('com_ui_agent_subagents_add')}
              />
            )}

            {agentIds.length >= maxSubagents && (
              <p className="pt-1 text-center text-xs italic text-text-tertiary">
                {localize('com_ui_agent_subagents_max', { 0: maxSubagents })}
              </p>
            )}
          </div>

          {nothingToSpawn && (
            <p className="flex items-center gap-2 text-xs italic text-text-warning">
              <Users size={14} aria-hidden="true" />
              {localize('com_ui_agent_subagents_empty')}
            </p>
          )}
        </>
      )}
    </OrchestrationPattern>
  );
};

export default AgentSubagents;
