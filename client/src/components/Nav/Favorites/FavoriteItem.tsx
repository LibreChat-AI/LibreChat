import React from 'react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { Agent, TModelSpec, TEndpointsConfig } from 'librechat-data-provider';
import type { FavoriteModel } from '~/store/favorites';
import SpecIcon from '~/components/Chat/Menus/Endpoints/components/SpecIcon';
import UnpinButton from '~/components/Conversations/UnpinButton';
import MinimalIcon from '~/components/Endpoints/MinimalIcon';
import { useFavorites, useLocalize } from '~/hooks';
import { renderAgentAvatar } from '~/utils';

type Kwargs = {
  model?: string;
  agent_id?: string;
  assistant_id?: string;
  spec?: string | null;
};

type FavoriteItemBaseProps = {
  onRemoveFocus?: () => void;
  /** Shortcuts an owning list handles for this row, declared here because this
   *  is the element that takes focus. */
  keyShortcuts?: string;
};

type AgentFavoriteProps = FavoriteItemBaseProps & {
  type: 'agent';
  item: Agent;
  onSelectEndpoint?: (endpoint?: EModelEndpoint | string | null, kwargs?: Kwargs) => void;
};

type ModelFavoriteProps = FavoriteItemBaseProps & {
  type: 'model';
  item: FavoriteModel;
  onSelectEndpoint?: (endpoint?: EModelEndpoint | string | null, kwargs?: Kwargs) => void;
  endpointsConfig?: TEndpointsConfig;
};

type SpecFavoriteProps = FavoriteItemBaseProps & {
  type: 'spec';
  item: TModelSpec;
  onSelectSpec?: (spec: TModelSpec) => void;
  endpointsConfig?: TEndpointsConfig;
  /** Avatar of the agent the spec targets, used when the spec defines no icon of its own. */
  agentAvatarURL?: string;
};

type FavoriteItemProps = AgentFavoriteProps | ModelFavoriteProps | SpecFavoriteProps;

export default function FavoriteItem(props: FavoriteItemProps) {
  const { onRemoveFocus, keyShortcuts } = props;
  const localize = useLocalize();
  const { removeFavoriteAgent, removeFavoriteModel, removeFavoriteSpec } = useFavorites();

  const handleSelect = () => {
    if (props.type === 'agent') {
      props.onSelectEndpoint?.(EModelEndpoint.agents, { agent_id: props.item.id });
    } else if (props.type === 'spec') {
      props.onSelectSpec?.(props.item);
    } else {
      props.onSelectEndpoint?.(props.item.endpoint, { model: props.item.model });
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-testid="favorite-unpin-button"]')) {
      return;
    }
    handleSelect();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleSelect();
    }
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (props.type === 'agent') {
      removeFavoriteAgent(props.item.id);
    } else if (props.type === 'spec') {
      removeFavoriteSpec(props.item.name);
    } else {
      removeFavoriteModel(props.item.model, props.item.endpoint);
    }
    requestAnimationFrame(() => {
      onRemoveFocus?.();
    });
  };

  const renderIcon = () => {
    if (props.type === 'agent') {
      return renderAgentAvatar(props.item, { size: 'icon', className: 'mr-2' });
    }
    if (props.type === 'spec') {
      return (
        <div className="mr-2 h-5 w-5">
          <SpecIcon
            currentSpec={props.item}
            endpointsConfig={props.endpointsConfig}
            agentAvatarURL={props.agentAvatarURL}
          />
        </div>
      );
    }
    return (
      <div className="mr-2 h-5 w-5">
        <MinimalIcon
          endpoint={props.item.endpoint}
          endpointsConfig={props.endpointsConfig}
          model={props.item.model}
          size={20}
          isCreatedByUser={false}
        />
      </div>
    );
  };

  let name: string;
  let typeLabel: string;
  if (props.type === 'agent') {
    name = props.item.name ?? '';
    typeLabel = localize('com_ui_agent');
  } else if (props.type === 'spec') {
    name = props.item.label;
    typeLabel = localize('com_ui_model_spec');
  } else {
    name = props.item.model;
    typeLabel = localize('com_ui_model');
  }
  const ariaLabel = `${name} (${typeLabel})`;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-keyshortcuts={keyShortcuts}
      className="group relative flex w-full cursor-pointer items-center justify-between rounded-lg p-2 text-sm text-text-primary outline-none hover:bg-surface-active-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text-primary"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      data-testid="favorite-item"
    >
      <div className="flex flex-1 items-center truncate pr-6">
        {renderIcon()}
        <span className="truncate">{name}</span>
      </div>

      {/* Inset by the same 4px the 28px control leaves above and below it in a
          36px row, which is also where a pinned chat keeps its last control, so
          the two row kinds line up. Clicks are swallowed here rather than
          reaching the row underneath. */}
      <div className="absolute right-1 flex items-center" onClick={(e) => e.stopPropagation()}>
        <UnpinButton
          testId="favorite-unpin-button"
          onClick={handleRemove}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
            }
          }}
        />
      </div>
    </div>
  );
}
