import { memo, useRef, useMemo, useState, useLayoutEffect } from 'react';
import * as Ariakit from '@ariakit/react';
import { ChevronDown } from 'lucide-react';
import { TooltipAnchor } from '@librechat/client';
import type { SettingDefinition, TConversation, TReasoningOverride } from 'librechat-data-provider';
import { ReasoningControl, useComposerReasoning } from '../Reasoning';
import useReducedMotion from '~/hooks/Generic/useReducedMotion';
import Effort, { resolveEffortLabel } from './Effort';
import { useGetStartupConfig } from '~/data-provider';
import { useChatContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/** Matches `animate-composer-popover`'s opacity leg, so the button and the
 *  popup resize on the same clock. */
const RESIZE_MS = 190;
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

interface ThinkingControlProps {
  index: number;
  setting: SettingDefinition;
  conversation: TConversation | null;
  value?: TReasoningOverride;
  disabled: boolean;
  onChange: (value: TReasoningOverride) => void;
}

function ThinkingControl({
  index,
  setting,
  conversation,
  value,
  disabled,
  onChange,
}: ThinkingControlProps) {
  const localize = useLocalize();
  const reducedMotion = useReducedMotion();
  /* Ariakit owns the open state rather than a controlled `open`/`setOpen` pair:
     with the controlled form, hide-on-interact-outside fired on mousedown and
     the disclosure's own click re-opened it, so a second click never closed the
     popup. */
  const popover = Ariakit.usePopoverStore({ placement: 'bottom' });
  const open = popover.useState('open');
  const disclosureRef = useRef<HTMLButtonElement>(null);
  const ghostsRef = useRef<HTMLSpanElement>(null);
  const currentRef = useRef<HTMLSpanElement>(null);
  const [slotWidth, setSlotWidth] = useState<number>();

  /* The conversation only holds a value once the user touches the control; an
     admin can still override the setting's default (e.g. reasoning_effort:
     high), and labelling that state Auto would disagree with what actually
     runs, and with the Parameters panel. */
  const raw =
    value?.key === setting.key
      ? value.value
      : (conversation?.[setting.key as keyof TConversation] ?? setting.default);
  const currentValue = raw == null ? undefined : String(raw);
  const display =
    currentValue == null
      ? localize('com_ui_auto')
      : resolveEffortLabel(setting, currentValue, localize);

  /* Every label this button can show, in the active language. All of them get
     measured rather than picking by character count: the longest string is not
     the widest one in a proportional font, and even less so across languages. */
  const optionLabels = useMemo(() => {
    const seen = new Set<string>([localize('com_ui_auto')]);
    for (const option of setting.options ?? []) {
      const raw = String(option);
      seen.add(resolveEffortLabel(setting, raw, localize));
    }
    return [...seen];
  }, [setting, localize]);

  /* Both candidate widths come from out-of-flow ghosts. The visible label is a
     block that fills the slot, so measuring it just returned the slot's current
     width and the button never shrank back down.
     Measured after commit, not during render: a ref read mid-render returns the
     previous layout, so closing right after a level change animated to the old
     label's width. */
  useLayoutEffect(() => {
    const ghosts = ghostsRef.current;
    const widest =
      ghosts != null
        ? Math.max(0, ...Array.from(ghosts.children, (el) => (el as HTMLElement).offsetWidth))
        : 0;
    const measured = open ? widest : (currentRef.current?.offsetWidth ?? 0);
    if (measured > 0) {
      setSlotWidth(measured);
    }
  }, [open, display, optionLabels]);

  /* Opens downward; Ariakit flips it above on its own once the composer sits
     low enough in the viewport that there is no room below. */
  return (
    <Ariakit.PopoverProvider store={popover}>
      {/* Named on hover like the mic and send buttons: closed, the trigger shows
          only the level, which says nothing about what it sets. */}
      <Ariakit.PopoverDisclosure
        ref={disclosureRef}
        data-testid="composer-thinking-button"
        onClick={(event) => event.stopPropagation()}
        disabled={disabled}
        aria-label={localize('com_ui_composer_thinking_value', { 0: display })}
        render={
          <TooltipAnchor
            description={localize('com_ui_composer_thinking')}
            render={<button type="button" />}
          />
        }
        className={cn(
          'flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-sm transition-colors',
          'hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary',
          'text-text-primary',
          open && 'bg-surface-hover',
        )}
      >
        {/* Closed, the button hugs its label so it takes no more room in the bar
            than it needs. Open, it widens to the longest label and the text
            centres, so changing levels while the popup is up never shifts the
            row. The label itself swaps plainly: a keyed crossfade dipped it to
            transparent mid-change, which read as a flicker rather than polish. */}
        <span
          className="relative block overflow-hidden ease-out"
          style={{
            width: slotWidth,
            /* Written inline, so a stylesheet's reduced-motion rule cannot
               reach it: the label takes its new width at once instead. */
            transition: `width ${reducedMotion ? 0 : RESIZE_MS}ms ${EASE}`,
          }}
        >
          <span
            ref={ghostsRef}
            aria-hidden="true"
            className="pointer-events-none invisible absolute left-0 top-0 w-max"
          >
            {optionLabels.map((text) => (
              <span key={text} className="block whitespace-nowrap">
                {text}
              </span>
            ))}
          </span>
          <span
            ref={currentRef}
            aria-hidden="true"
            className="pointer-events-none invisible absolute left-0 top-0 w-max whitespace-nowrap"
          >
            {display}
          </span>
          {/* Always centred: flipping alignment as the width animated made the
              label jump sideways mid-transition. Closed the slot is exactly the
              label's width, so centred and left are identical anyway. */}
          <span className="block whitespace-nowrap text-center">{display}</span>
        </span>
        {/* Turns to point at the popup, which is the only cue that the button
            and the panel below it are one control. */}
        <ChevronDown
          className={cn('animate-composer-icon size-3 shrink-0 opacity-60', open && '-rotate-180')}
          aria-hidden="true"
        />
      </Ariakit.PopoverDisclosure>
      <Ariakit.Popover
        portal
        data-chat-pane-portal={index}
        gutter={8}
        unmountOnHide
        onClick={(event) => event.stopPropagation()}
        /* Without this the trigger could not close the popup: mousedown on it
           counts as "outside", so Ariakit hid the popup and the button's own
           click immediately re-opened it. Excluding the trigger leaves a single
           clean toggle. */
        hideOnInteractOutside={(event) => !disclosureRef.current?.contains(event.target as Node)}
        aria-label={localize('com_ui_composer_thinking_value', { 0: display })}
        /* `border-light` resolves to the same value as `surface-tertiary`, so
           the edge was invisible against the popup's own background. */
        className="animate-composer-popover z-50 rounded-2xl border border-border-medium bg-surface-tertiary shadow-lg outline-none"
      >
        <Effort setting={setting} conversation={conversation} value={value} onChange={onChange} />
      </Ariakit.Popover>
    </Ariakit.PopoverProvider>
  );
}

/**
 * Reasoning effort in the composer footer, the one model parameter worth
 * reaching for mid-conversation, which otherwise lives three clicks away in the
 * parameters panel under a different name per provider.
 *
 * Model and agent selection deliberately stay in the header; this owns effort
 * only. Renders nothing at all for models that expose no reasoning parameter,
 * and nothing when `interface.parameters` is off (the same gate as the
 * Parameters side panel; model specs default that flag to false).
 *
 * Split in two so the control's hooks are never behind that early return.
 */
interface ThinkingProps {
  index: number;
  disabled: boolean;
  hasAddedConversation: boolean;
}

function Thinking({ index, disabled, hasAddedConversation }: ThinkingProps) {
  const { conversation } = useChatContext();
  const { data: startupConfig } = useGetStartupConfig();
  const parametersEnabled = startupConfig?.interface?.parameters;
  const reasoning = useComposerReasoning({
    conversation: conversation ?? null,
    index,
    hasAddedConversation,
    enabled: parametersEnabled,
  });

  if (parametersEnabled !== true || reasoning == null) {
    return null;
  }

  if (reasoning.setting.type !== 'enum' || reasoning.setting.options?.length === 0) {
    return (
      <ReasoningControl
        index={index}
        setting={reasoning.setting}
        value={reasoning.value}
        disabled={disabled}
        onChange={reasoning.setValue}
      />
    );
  }

  return (
    <ThinkingControl
      index={index}
      setting={reasoning.setting}
      conversation={conversation ?? null}
      value={reasoning.value}
      disabled={disabled}
      onChange={reasoning.setValue}
    />
  );
}

export default memo(Thinking);
