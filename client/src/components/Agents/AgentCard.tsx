import React, { useMemo, useState } from 'react';
import { OGDialog, OGDialogTrigger } from '@librechat/client';
import type t from 'librechat-data-provider';
import Description, { getPlainDescription } from '~/components/ui/Description';
import { useLocalize, TranslationKeys, useAgentCategories } from '~/hooks';
import AgentDetailContent from './AgentDetailContent';
import { cn, renderAgentAvatar } from '~/utils';
import AgentContact from './AgentContact';

interface AgentCardProps {
  agent: t.Agent;
  onSelect?: (agent: t.Agent) => void;
  className?: string;
}

/**
 * Card component to display agent information with integrated detail dialog
 */
const AgentCard: React.FC<AgentCardProps> = ({ agent, onSelect, className = '' }) => {
  const localize = useLocalize();
  const { categories } = useAgentCategories();
  const [isOpen, setIsOpen] = useState(false);
  const description = useMemo(() => getPlainDescription(agent.description), [agent.description]);

  const categoryLabel = useMemo(() => {
    if (!agent.category) return '';

    const category = categories.find((cat) => cat.value === agent.category);
    if (category) {
      if (category.label && category.label.startsWith('com_')) {
        return localize(category.label as TranslationKeys);
      }
      return category.label;
    }

    return agent.category.charAt(0).toUpperCase() + agent.category.slice(1);
  }, [agent.category, categories, localize]);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (open && onSelect) {
      onSelect(agent);
    }
  };

  return (
    <OGDialog open={isOpen} onOpenChange={handleOpenChange}>
      <OGDialogTrigger asChild>
        <div
          className={cn(
            'group relative flex h-40 gap-5 overflow-hidden rounded-xl',
            'cursor-pointer select-none px-6 py-4',
            'bg-surface-tertiary transition-colors duration-150 hover:bg-surface-hover',
            'lg:h-44',
            '[&_*]:cursor-pointer',
            className,
          )}
          aria-label={localize('com_agents_agent_card_label', {
            name: agent.name,
            description,
          })}
          aria-describedby={description ? `agent-${agent.id}-description` : undefined}
          tabIndex={0}
          role="button"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setIsOpen(true);
            }
          }}
        >
          {/* Category badge - top right */}
          {categoryLabel && (
            <span className="absolute right-4 top-3 max-w-[40%] truncate rounded-md bg-surface-hover px-2 py-0.5 text-xs text-text-secondary">
              {categoryLabel}
            </span>
          )}

          {/* Avatar */}
          <div className="flex-shrink-0 self-center">
            <div className="overflow-hidden rounded-full shadow-[0_0_15px_rgba(0,0,0,0.3)] dark:shadow-[0_0_15px_rgba(0,0,0,0.5)]">
              {renderAgentAvatar(agent, { size: 'sm', showBorder: false })}
            </div>
          </div>

          {/* Content. Children never shrink, so a clamped line is either fully shown
              or fully hidden, rather than sliced in half by the card's fixed height. */}
          <div className="flex min-w-0 flex-1 flex-col justify-center overflow-hidden [&>*]:shrink-0">
            {/* Agent name. Not a <Label>: that component hardcodes `block`, which beats
                the `display: -webkit-box` line-clamp needs and leaves the clamp inert, and
                `break-all`, which splits names mid-word. The floated spacer keeps only the
                first line clear of the category badge, so longer names still wrap to the
                full card width. */}
            <span className="line-clamp-2 break-words text-base font-semibold text-text-primary lg:text-lg">
              {categoryLabel && (
                <span aria-hidden="true" className="float-right h-5 w-24 max-w-[40%]" />
              )}
              {agent.name}
            </span>

            {/* Agent description */}
            {description && (
              <Description
                as="p"
                id={`agent-${agent.id}-description`}
                className="mt-0.5 line-clamp-2 text-sm leading-snug text-text-secondary lg:line-clamp-3"
                aria-label={localize('com_agents_description_card', {
                  description,
                })}
                description={description}
                plainText
              />
            )}

            <AgentContact
              agent={agent}
              className="mt-1 text-xs text-text-secondary [&_a]:font-normal [&_a]:text-text-secondary"
            />
          </div>
        </div>
      </OGDialogTrigger>

      <AgentDetailContent agent={agent} />
    </OGDialog>
  );
};

export default AgentCard;
