import React, { useCallback, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { useHref, useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { Constants, EModelEndpoint } from 'librechat-data-provider';
import { ArrowUpRight, MessageSquarePlus, Pin, PinOff, X } from 'lucide-react';
import {
  Button,
  Spinner,
  OGDialogClose,
  OGDialogContent,
  OGDialogDescription,
  OGDialogHeader,
  OGDialogTitle,
} from '@librechat/client';
import type t from 'librechat-data-provider';
import {
  agentMorphId,
  DETAIL_ENTER,
  DETAIL_EXIT,
  DETAIL_FADE_ENTER,
  DETAIL_FADE_INITIAL,
  DETAIL_INITIAL,
  DIALOG_MORPH_DEPENDENCY,
  MORPH_OPEN_TRANSITION,
} from './morph';
import Description, { getPlainDescription, isHtmlDescription } from '~/components/ui/Description';
import AgentContact, { resolveAgentContact } from './AgentContact';
import { useMarketplaceHost } from './MarketplaceContext';
import { useFavorites, useLocalize } from '~/hooks';
import DescriptionWords from './DescriptionWords';
import { cn, renderAgentAvatar } from '~/utils';
import AgentCategoryBadge from './Category';
import CopyLink from './CopyLink';

interface AgentDetailContentProps {
  agent: t.Agent;
  /**
   * Set while the dialog shares its layout with the originating grid card:
   * `open` expands out of the card, `closing` hands the surface back. Omit it
   * when there is no source card to morph from and the dialog should just fade.
   */
  morph?: 'open' | 'closing';
  /**
   * The theme's surface radius in pixels, supplied with `morph` so the shared
   * surface holds the same corner as the card it came from while it scales. At
   * rest the stylesheet's `rounded-theme-surface` governs.
   */
  surfaceRadius?: number;
  /**
   * Looks up the description paragraph of the card an agent is shown on,
   * allowing the dialog to hand the words back to the card as it closes.
   */
  descriptionSource?: (agentId: string) => HTMLElement | null;
  /**
   * True only after the per-agent access check returns 403/404. The selected snapshot
   * remains mounted for focus and dismissal, but controls that would act on it disappear.
   */
  actionsUnavailable?: boolean;
  /** Keep controls inert while the per-agent access check is still in flight. */
  actionsDisabled?: boolean;
}

const AgentDetailContent: React.FC<AgentDetailContentProps> = ({
  agent,
  morph,
  surfaceRadius,
  descriptionSource,
  actionsUnavailable = false,
  actionsDisabled = false,
}) => {
  const localize = useLocalize();
  const navigate = useNavigate();
  const reducedMotion = useReducedMotion();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const unavailableRef = useRef<HTMLParagraphElement>(null);
  const focusedActionRef = useRef<HTMLElement | null>(null);
  const previousActionsUnavailable = useRef(actionsUnavailable);
  const id = useId();
  const { isFavoriteAgent, toggleFavoriteAgent, isUpdating } = useFavorites();
  const isFavorite = isFavoriteAgent(agent.id);
  const favoriteLabel = localize(isFavorite ? 'com_ui_unpin' : 'com_ui_pin');
  const FavoriteIcon = isFavorite ? PinOff : Pin;

  const conversationStarters = useMemo(() => {
    const starters: string[] = [];
    for (const value of agent.conversation_starters ?? []) {
      const starter = value.trim();
      if (starter) {
        starters.push(starter);
      }
      if (starters.length === Constants.MAX_CONVO_STARTERS) {
        break;
      }
    }
    return starters;
  }, [agent.conversation_starters]);
  const chatSearch = useMemo(
    () => new URLSearchParams({ endpoint: EModelEndpoint.agents, agent_id: agent.id }).toString(),
    [agent.id],
  );
  const { resetNewConversation } = useMarketplaceHost();
  const chatHref = useHref({ pathname: '/c/new', search: `?${chatSearch}` });

  const handleStartChat = (prompt?: string) => {
    const params = new URLSearchParams(chatSearch);
    if (prompt) {
      params.set('prompt', prompt);
    }
    /* The chat route initializes from these query params through `useQueryParams`, which
       keeps added conversations and leaves the new-chat message cache alone. Starting an
       agent from the marketplace is a new conversation with that agent, not another column
       beside whatever was already open and not the transcript the last one left under
       `NEW_CONVO` — both belong to the app's conversation state, so the host drops them
       the way `newConversation` used to. */
    resetNewConversation();
    navigate({ pathname: '/c/new', search: `?${params.toString()}` });
  };

  const shareUrl = useMemo(() => new URL(chatHref, window.location.origin).toString(), [chatHref]);

  /* The dialog keeps its own layout: only the surface and the identity fields
     travel, and they animate position (not scale) so the dialog's typography is
     never a stretched copy of the card's. */
  const morphing = morph != null && reducedMotion !== true;
  const shared = {
    layoutCrossfade: false,
    /* The identity fields travel between two independently animating layouts,
       so they must resolve against the viewport, not against whichever section
       currently contains them. */
    layoutAnchor: false,
    layoutDependency: DIALOG_MORPH_DEPENDENCY,
    transition: MORPH_OPEN_TRANSITION,
  } as const;
  /**
   * Sections that are pinned to the dialog's own layout. Being projection nodes
   * keeps them scale-corrected inside the expanding surface, so they sit at
   * their final position and typography from the first frame and are revealed
   * by the surface's clip instead of stretching or spilling outside it.
   */
  const pinned = morphing
    ? ({
        layout: 'position',
        layoutDependency: DIALOG_MORPH_DEPENDENCY,
        transition: MORPH_OPEN_TRANSITION,
      } as const)
    : {};
  /** Controls that exist only here, introduced once the geometry is under way. */
  const detail = morphing
    ? { initial: DETAIL_INITIAL, animate: morph === 'closing' ? DETAIL_EXIT : DETAIL_ENTER }
    : { initial: DETAIL_FADE_INITIAL, animate: DETAIL_FADE_ENTER };
  const contact = resolveAgentContact(agent);
  const richDescription = isHtmlDescription(agent.description);
  const description =
    getPlainDescription(agent.description).trim() || localize('com_agents_description_empty');
  /* Nothing to morph the copy out of without the card that owns it, and a rich
     description is markup rather than the text nodes the word morph measures, so
     it hands over as one block instead of word by word. */
  const morphedDescription = morphing && !richDescription && descriptionSource != null;
  const readDescriptionSource = useCallback(
    () => descriptionSource?.(agent.id) ?? null,
    [agent.id, descriptionSource],
  );
  /* One handover, two elements: the copy the card shows arrives the same way whether it
     is markup or the text the words morph through. `relative` makes this the offset
     parent the word morph measures against. */
  const descriptionMotion = {
    layout: 'position' as const,
    layoutId: morphing ? agentMorphId('description', agent.id) : undefined,
    style: { willChange: morphing ? 'transform' : undefined },
    className:
      'relative mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-text-secondary sm:text-base',
    ...shared,
  };
  useLayoutEffect(() => {
    const wasUnavailable = previousActionsUnavailable.current;
    previousActionsUnavailable.current = actionsUnavailable;
    if (!actionsUnavailable || wasUnavailable || focusedActionRef.current == null) {
      return;
    }
    focusedActionRef.current = null;
    unavailableRef.current?.focus();
  }, [actionsUnavailable]);
  const handleActionFocusCapture = useCallback((event: React.FocusEvent<HTMLElement>) => {
    focusedActionRef.current = event.target;
  }, []);
  const handleActionBlurCapture = useCallback((event: React.FocusEvent<HTMLElement>) => {
    const relatedTarget = event.relatedTarget;
    if (!(relatedTarget instanceof Node) || !event.currentTarget.contains(relatedTarget)) {
      focusedActionRef.current = null;
    }
  }, []);

  return (
    <OGDialogContent
      bare
      forceMount={morphing ? true : undefined}
      className={cn(
        'inset-0 m-auto h-fit w-11/12 max-w-3xl',
        !morphing &&
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-150',
      )}
      /* While morphing, the dim is owned by the grid: it has to outlive this
         dialog's mount so it can fade out across the whole contraction. */
      overlayClassName={morphing ? 'bg-transparent' : undefined}
      showCloseButton={false}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        titleRef.current?.focus();
      }}
    >
      <motion.div
        layoutId={morphing ? agentMorphId('surface', agent.id) : undefined}
        /* The surface is the largest thing in flight and the animation loop
           does not promote it on its own. The hint stands for as long as this
           dialog shares the card's surface, and is never set on a dialog that
           has no morph to run. */
        style={{
          borderRadius: surfaceRadius,
          willChange: morphing ? 'transform' : undefined,
        }}
        className="rounded-theme-surface bg-surface-dialog high-contrast:border high-contrast:border-solid high-contrast:border-border-medium high-contrast:shadow-none relative flex max-h-[88dvh] w-full flex-col overflow-hidden shadow-lg"
        {...shared}
      >
        {/* Card-coloured wash so the surface interpolates its fill and border
            instead of popping to the dialog colour at the first frame. */}
        <motion.div
          aria-hidden="true"
          initial={morphing ? { opacity: 1 } : false}
          animate={{ opacity: morphing && morph === 'closing' ? 1 : 0 }}
          transition={MORPH_OPEN_TRANSITION}
          className="border-border-light bg-surface-secondary pointer-events-none absolute inset-0 border"
        />

        {/* Only the category and the close control are pinned above the scroll:
            the identity block carries the description now, and a long one has
            to scroll rather than push the dialog past its own height. */}
        <motion.div
          {...pinned}
          className="relative z-10 flex shrink-0 items-start justify-between gap-4 px-5 pt-5 sm:px-6 sm:pt-6"
        >
          {agent.category != null && agent.category !== '' && (
            /* The box has to hug the pill on both sides of the morph: a
               full-width box here would put the pill's travel on the box's
               centre and throw it across the header on the first frame. */
            <motion.div
              layout="position"
              layoutId={morphing ? agentMorphId('category', agent.id) : undefined}
              className="min-w-0"
              {...shared}
            >
              <AgentCategoryBadge category={agent.category} />
            </motion.div>
          )}
          <motion.div {...detail} className="ms-auto shrink-0">
            <OGDialogClose asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="-mt-2 -mr-2 shrink-0 rtl:mr-0 rtl:-ml-2"
                aria-label={localize('com_ui_close')}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </OGDialogClose>
          </motion.div>
        </motion.div>

        <motion.div
          {...pinned}
          layoutScroll
          className="relative z-10 min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-4 pb-5 sm:px-6 sm:pb-6"
        >
          <OGDialogHeader className="space-y-0 text-left sm:text-left rtl:text-right sm:rtl:text-right">
            {/* The avatar holds the top of the row and the copy centres on it,
                so a title with a line or two of description reads as one block
                beside it. Once the copy is the taller of the two there is
                nothing left for `self-center` to move, and the block stays
                aligned with the top of the avatar and grows downwards. */}
            <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
              <motion.div
                layoutId={morphing ? agentMorphId('avatar', agent.id) : undefined}
                className="shrink-0"
                {...shared}
              >
                {renderAgentAvatar(agent, {
                  size: 'md',
                  showBorder: false,
                  className: 'rounded-full bg-surface-tertiary ring-1 ring-border-light',
                })}
              </motion.div>
              <div className="min-w-0 flex-1 sm:self-center">
                <motion.div
                  layout
                  layoutId={morphing ? agentMorphId('title', agent.id) : undefined}
                  {...shared}
                >
                  <OGDialogTitle
                    focusOutline="hidden"
                    ref={titleRef}
                    tabIndex={-1}
                    className="text-text-primary text-2xl leading-tight font-semibold break-words sm:text-3xl"
                  >
                    {agent.name?.trim() || localize('com_ui_agent')}
                  </OGDialogTitle>
                </motion.div>
                {/* Sanitized markup can carry blocks of its own, so the rich branch is a
                    block and only the plain text keeps the paragraph the words morph in. */}
                {!morphedDescription && richDescription ? (
                  <motion.div {...descriptionMotion}>
                    <Description
                      description={agent.description}
                      className="[&_a]:underline [&_a]:underline-offset-2 [&_img]:inline-block [&_img]:max-w-full"
                    />
                  </motion.div>
                ) : (
                  <motion.p {...descriptionMotion}>
                    {morphedDescription && (
                      <DescriptionWords
                        text={description}
                        source={readDescriptionSource}
                        phase={morph === 'closing' ? 'closing' : 'open'}
                      />
                    )}
                    {!morphedDescription && !richDescription && description}
                  </motion.p>
                )}
              </div>
            </div>
            <OGDialogDescription className="sr-only">
              {localize('com_agents_details_hint')}
            </OGDialogDescription>
          </OGDialogHeader>

          {actionsUnavailable && (
            <p
              ref={unavailableRef}
              className="text-text-secondary mt-8 text-sm"
              role="status"
              tabIndex={-1}
            >
              {localize('com_agents_not_available')}
            </p>
          )}

          {!actionsUnavailable && conversationStarters.length > 0 && (
            <motion.section
              {...detail}
              className="mt-8"
              aria-labelledby={`${id}-starters`}
              onFocusCapture={handleActionFocusCapture}
              onBlurCapture={handleActionBlurCapture}
            >
              <h3 id={`${id}-starters`} className="text-text-primary text-sm font-semibold">
                {localize('com_agents_starters_heading')}
              </h3>
              <p className="text-text-secondary mt-1 text-sm leading-6">
                {localize('com_agents_starters_hint')}
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {conversationStarters.map((starter, index) => (
                  <Button
                    key={`${starter}-${index}`}
                    variant="outline"
                    className="h-auto min-h-14 items-start justify-between gap-3 px-4 py-3 text-left whitespace-normal rtl:text-right"
                    aria-disabled={actionsDisabled || undefined}
                    onClick={() => {
                      if (!actionsDisabled) {
                        handleStartChat(starter);
                      }
                    }}
                  >
                    <span className="min-w-0 break-words">{starter}</span>
                    <ArrowUpRight className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  </Button>
                ))}
              </div>
            </motion.section>
          )}
        </motion.div>

        <motion.div {...pinned} className="relative z-10 shrink-0">
          <div className="grid gap-3 p-5 sm:flex sm:items-center sm:justify-between sm:gap-4 sm:p-6">
            {/* The contact keeps the card's corner, so it travels instead of
                being faded in with the controls that only exist here. */}
            {contact != null && (
              <motion.div
                layout="position"
                layoutId={morphing ? agentMorphId('owner', agent.id) : undefined}
                className="min-w-0"
                {...shared}
              >
                <AgentContact agent={agent} compact className="text-sm" />
              </motion.div>
            )}
            {!actionsUnavailable && (
              <motion.div
                {...detail}
                className="grid gap-2 sm:ms-auto sm:flex sm:items-center sm:gap-2"
                onFocusCapture={handleActionFocusCapture}
                onBlurCapture={handleActionBlurCapture}
              >
                <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-2">
                  <Button
                    variant="outline"
                    aria-label={favoriteLabel}
                    aria-pressed={isFavorite}
                    aria-busy={isUpdating}
                    aria-disabled={actionsDisabled || isUpdating || undefined}
                    onClick={() => {
                      if (!actionsDisabled && !isUpdating) {
                        toggleFavoriteAgent(agent.id);
                      }
                    }}
                    className={cn('min-w-0 px-3', isUpdating && 'opacity-50')}
                  >
                    {isUpdating ? (
                      <Spinner className="size-4 shrink-0" aria-hidden="true" />
                    ) : (
                      <FavoriteIcon className="size-4 shrink-0" aria-hidden="true" />
                    )}
                    <span className="truncate">{favoriteLabel}</span>
                  </Button>
                  <CopyLink url={shareUrl} disabled={actionsDisabled} />
                </div>
                <Button
                  className="w-full sm:w-auto"
                  aria-disabled={actionsDisabled || undefined}
                  onClick={() => {
                    if (!actionsDisabled) {
                      handleStartChat();
                    }
                  }}
                >
                  <MessageSquarePlus className="size-4" aria-hidden="true" />
                  {localize('com_agents_start_chat')}
                </Button>
              </motion.div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </OGDialogContent>
  );
};

export default AgentDetailContent;
