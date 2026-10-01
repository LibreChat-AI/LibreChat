import React, { forwardRef, memo, useId } from 'react';
import { motion } from 'framer-motion';
import { ArrowUpRight } from 'lucide-react';
import type t from 'librechat-data-provider';
import { agentMorphId, CARD_HANDOFF_VARIANTS, MORPH_CLOSE_TRANSITION } from './morph';
import AgentContact, { resolveAgentContact } from './AgentContact';
import { getPlainDescription } from '~/components/ui/Description';
import { cn, renderAgentAvatar } from '~/utils';
import AgentCategoryBadge from './Category';
import { useLocalize } from '~/hooks';

interface AgentCardProps {
  agent: t.Agent;
  onSelect: (agent: t.Agent) => void;
  /**
   * True while this card's detail dialog owns the shared surface. The card keeps
   * its box so the grid never reflows; the shared fields are hidden by the
   * layout projection and the card-only content fades out.
   */
  expanded?: boolean;
  /**
   * True for as long as this card's surface is in flight, which outlasts
   * `expanded` by the contraction. The trigger stays behind at the card's slot
   * while the surface travels, so its focus ring is held back until the card is
   * home again rather than framing an empty hole.
   */
  morphing?: boolean;
  /**
   * The theme's surface radius in pixels, supplied while this card takes part
   * in a morph so the projection can hold the corner steady as it scales. At
   * rest the stylesheet's `rounded-theme-surface` governs.
   */
  surfaceRadius?: number;
  /**
   * Reports this card's description paragraph, whose wrapping the detail dialog
   * morphs its own copy out of. It has to be handed over on mount rather than
   * when the card is selected: `motion.p` resolves the ref it forwards once,
   * when its visual element is created, so a ref that arrives later is never
   * attached. The paragraph itself stays plain text — a grid of cards is not
   * the place to pay for an animation most of them never take part in.
   */
  descriptionRef?: React.Ref<HTMLParagraphElement>;
  className?: string;
}

/** The list owns preview state so recycling a card cannot dismiss its dialog. */
const AgentCard = memo(
  forwardRef<HTMLButtonElement, AgentCardProps>(function AgentCard(
    {
      agent,
      onSelect,
      expanded = false,
      morphing = false,
      surfaceRadius,
      descriptionRef,
      className = '',
    },
    ref,
  ) {
    const localize = useLocalize();
    const id = useId();
    const titleId = `${id}-title`;
    const descriptionId = `${id}-description`;
    const name = agent.name?.trim() || localize('com_ui_agent');
    /* Stripped rather than rendered: a card is a blurb, and the word morph measures
       text nodes, so markup here would neither clamp nor travel. The dialog renders
       the same copy with its links and images intact. */
    const description =
      getPlainDescription(agent.description).trim() || localize('com_agents_description_empty');
    /* Only fields the dialog also renders take part in the morph, so an absent
       category or contact never hands over an empty box. `layoutAnchor: false`
       keeps them resolving against the viewport rather than against whichever
       section of the dialog currently contains their counterpart. */
    const contact = resolveAgentContact(agent);
    const shared = {
      layoutCrossfade: false,
      layoutAnchor: false,
      layoutDependency: expanded,
      transition: MORPH_CLOSE_TRANSITION,
    } as const;

    return (
      <article
        className={cn(
          /* The article keeps a plain resting fill so the grid slot still reads as a
             card while the surface layer is away being the dialog. */
          'group rounded-theme-surface bg-surface-secondary relative flex h-full min-h-[17.5rem] min-w-0 flex-col p-5',
          className,
        )}
      >
        <motion.div
          aria-hidden="true"
          layoutId={agentMorphId('surface', agent.id)}
          /* Promoted only while this card's surface is in flight; a grid of
             permanently layered cards is a cost, not a saving. */
          style={{
            borderRadius: surfaceRadius,
            willChange: morphing ? 'transform' : undefined,
          }}
          className="rounded-theme-surface border-border-light bg-surface-secondary group-hover:border-border-medium group-hover:bg-surface-tertiary pointer-events-none absolute inset-0 z-0 border transition-colors duration-150"
          {...shared}
        />

        <button
          ref={ref}
          type="button"
          className={cn(
            'rounded-theme-surface focus-visible:ring-text-primary absolute inset-0 z-10 cursor-pointer border-0 bg-transparent p-0 text-start focus-visible:ring-2 focus-visible:outline-hidden focus-visible:ring-inset',
            morphing && 'focus-visible:ring-0',
          )}
          aria-label={expanded ? name : undefined}
          aria-labelledby={expanded ? undefined : titleId}
          aria-describedby={expanded ? undefined : descriptionId}
          aria-haspopup="dialog"
          aria-expanded={expanded}
          onClick={() => onSelect(agent)}
        />

        <motion.div
          initial={false}
          animate={expanded ? 'handoff' : 'rest'}
          className="pointer-events-none relative z-20 flex min-h-0 flex-1 flex-col"
        >
          <div className="flex items-start justify-between gap-3">
            <motion.div
              layoutId={agentMorphId('avatar', agent.id)}
              className="shrink-0"
              {...shared}
            >
              {renderAgentAvatar(agent, {
                size: 'sm',
                showBorder: false,
                className:
                  'rounded-full bg-surface-tertiary ring-1 ring-border-light transition-colors duration-150 group-hover:ring-border-medium',
              })}
            </motion.div>
            {agent.category != null && agent.category !== '' && (
              <motion.div
                layout="position"
                layoutId={agentMorphId('category', agent.id)}
                className="max-w-[60%] min-w-0 shrink-0 text-end"
                {...shared}
              >
                <AgentCategoryBadge
                  category={agent.category}
                  className="group-hover:border-border-medium transition-colors duration-150 [&>span]:line-clamp-2"
                />
              </motion.div>
            )}
          </div>

          {/* Full `layout` on the name so the type zooms between the two sizes
              instead of snapping to the dialog's scale on the first frame. */}
          <motion.h2
            layout
            layoutId={agentMorphId('title', agent.id)}
            id={titleId}
            className="text-text-primary mt-4 line-clamp-2 text-lg leading-6 font-semibold break-words"
            {...shared}
          >
            {name}
          </motion.h2>

          {/* The blurb is the same copy the dialog shows in full, so it is
              handed over rather than dropped: the paragraph travels, the words
              inside it re-wrap into the dialog's setting, and the lines this
              clamp hid arrive behind them. */}
          <motion.p
            ref={descriptionRef}
            layout="position"
            layoutId={agentMorphId('description', agent.id)}
            id={descriptionId}
            style={{ willChange: morphing ? 'transform' : undefined }}
            className="text-text-secondary mt-2 mb-5 line-clamp-3 text-sm leading-6 break-words"
            {...shared}
          >
            {description}
          </motion.p>

          <footer className="relative mt-auto flex min-w-0 items-end justify-between gap-3 pt-4">
            <motion.span
              aria-hidden="true"
              variants={CARD_HANDOFF_VARIANTS}
              className="bg-border-light absolute inset-x-0 top-0 h-px"
            />
            {contact != null && (
              <motion.div
                layout="position"
                layoutId={agentMorphId('owner', agent.id)}
                className="min-w-0 [&_a]:pointer-events-auto"
                {...shared}
              >
                <AgentContact
                  agent={agent}
                  compact
                  className="text-text-secondary [&_a]:text-text-primary max-w-full text-xs"
                />
              </motion.div>
            )}
            <motion.span
              variants={CARD_HANDOFF_VARIANTS}
              className="text-text-primary ms-auto flex shrink-0 items-center gap-1 text-sm font-medium"
            >
              {localize('com_agents_view_details')}
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </motion.span>
          </footer>
        </motion.div>
      </article>
    );
  }),
);

export default AgentCard;
