import { useMemo } from 'react';
import { X, PlusCircle } from 'lucide-react';
import { EModelEndpoint } from 'librechat-data-provider';
import { Button, ControlCombobox } from '@librechat/client';
import type { Agent, TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { OptionWithIcon } from '~/common';
import MessageIcon from '~/components/Share/MessageIcon';
import { useAgentsMapContext } from '~/Providers';
import { useLocalize } from '~/hooks';

const AGENT_MESSAGE = { endpoint: EModelEndpoint.agents, isCreatedByUser: false } as TMessage;

/** Renders an agent's avatar/icon as used in combobox options and select triggers. */
export const agentIcon = (agent?: Agent | false): ReactNode => (
  <MessageIcon message={AGENT_MESSAGE} agent={agent} />
);

/** Fixed-size circular agent avatar for list rows. */
export function AgentGlyph({ agent }: { agent?: Agent }) {
  return (
    <div className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full">
      {agentIcon(agent)}
    </div>
  );
}

interface UseSelectableAgentsParams {
  currentAgentId: string;
  /** Agent ids to omit from the options (e.g. already-selected ones). */
  exclude?: string[];
}

/**
 * Builds the list of agents this agent can collaborate with (everything except
 * itself and any excluded ids), plus a lookup for a single agent's details.
 */
export function useSelectableAgents({ currentAgentId, exclude }: UseSelectableAgentsParams) {
  const agentsMap = useAgentsMapContext();
  const excludeKey = (exclude ?? []).join(',');

  const options = useMemo<OptionWithIcon[]>(() => {
    const excludeSet = new Set(exclude ?? []);
    const agents = agentsMap ? Object.values(agentsMap) : [];
    return agents
      .filter((agent) => {
        if (!agent?.id) return false;
        if (agent.id === currentAgentId) return false;
        return !excludeSet.has(agent.id);
      })
      .map(
        (agent) =>
          ({
            label: agent?.name || '',
            value: agent?.id || '',
            icon: agentIcon(agent),
          }) as OptionWithIcon,
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsMap, currentAgentId, excludeKey]);

  const getAgent = (id: string): Agent | undefined => agentsMap?.[id];

  return { options, getAgent };
}

interface AddAgentSelectProps {
  options: OptionWithIcon[];
  onSelect: (id: string) => void;
  placeholder: string;
  ariaLabel: string;
}

/** Dashed "+ Add agent" combobox shared by every orchestration pattern. */
export function AddAgentSelect({ options, onSelect, placeholder, ariaLabel }: AddAgentSelectProps) {
  const localize = useLocalize();
  return (
    <ControlCombobox
      isCollapsed={false}
      ariaLabel={ariaLabel}
      selectedValue=""
      setValue={onSelect}
      selectPlaceholder={placeholder}
      searchPlaceholder={localize('com_ui_agent_var', { 0: localize('com_ui_search') })}
      items={options}
      className="border-border-light text-text-secondary hover:text-text-primary h-9 w-full border-dashed text-center"
      containerClassName="px-0"
      SelectIcon={<PlusCircle size={16} className="text-text-secondary" />}
    />
  );
}

interface AgentSelectInlineProps {
  options: OptionWithIcon[];
  selectedValue: string;
  onChange: (id: string) => void;
  displayValue: string;
  icon: ReactNode;
  ariaLabel: string;
}

/** Inline combobox to change which agent a row points at (chain, handoffs). */
export function AgentSelectInline({
  options,
  selectedValue,
  onChange,
  displayValue,
  icon,
  ariaLabel,
}: AgentSelectInlineProps) {
  const localize = useLocalize();
  return (
    <ControlCombobox
      isCollapsed={false}
      ariaLabel={ariaLabel}
      selectedValue={selectedValue}
      setValue={onChange}
      selectPlaceholder={localize('com_ui_agent_var', { 0: localize('com_ui_select') })}
      searchPlaceholder={localize('com_ui_agent_var', { 0: localize('com_ui_search') })}
      items={options}
      displayValue={displayValue}
      SelectIcon={icon}
      className="border-border-light h-9 flex-1"
      containerClassName="px-0"
    />
  );
}

interface RemoveButtonProps {
  onClick: () => void;
  label: string;
}

/** Ghost remove (×) button shared by agent rows. */
export function RemoveButton({ onClick, label }: RemoveButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="text-text-secondary hover:bg-surface-secondary hover:text-text-primary size-auto shrink-0 p-1"
      onClick={onClick}
      aria-label={label}
    >
      <X size={16} aria-hidden="true" />
    </Button>
  );
}

interface AgentRowProps {
  children: ReactNode;
  onRemove: () => void;
  removeLabel: string;
}

/** Borderless row laying out an editable control plus a remove button. */
export function AgentRow({ children, onRemove, removeLabel }: AgentRowProps) {
  return (
    <div className="flex items-center gap-1">
      {children}
      <RemoveButton onClick={onRemove} label={removeLabel} />
    </div>
  );
}

interface StaticAgentRowProps {
  agent?: Agent;
  name: string;
  onRemove: () => void;
  removeLabel: string;
}

/** Borderless display row for a selected agent (avatar, name, remove). */
export function StaticAgentRow({ agent, name, onRemove, removeLabel }: StaticAgentRowProps) {
  return (
    <div className="hover:bg-surface-secondary flex items-center gap-2 rounded-lg px-1 py-1 transition">
      <AgentGlyph agent={agent} />
      <span className="text-text-primary min-w-0 flex-1 truncate text-sm">{name}</span>
      <RemoveButton onClick={onRemove} label={removeLabel} />
    </div>
  );
}

interface ListMetaProps {
  label: string;
  count: number;
  max: number;
}

/** "Agents  2 / 10" sub-header used above an agent list. */
export function ListMeta({ label, count, max }: ListMetaProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-text-secondary text-xs font-medium">{label}</span>
      <span className="text-text-tertiary text-[10px] font-medium whitespace-nowrap tabular-nums">
        {count} / {max}
      </span>
    </div>
  );
}
