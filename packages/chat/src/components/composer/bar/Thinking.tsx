import { memo, useRef, useMemo, useState, useEffect, useLayoutEffect } from 'react';
import * as Ariakit from '@ariakit/react';
import { ChevronDown } from 'lucide-react';
import { Button, TooltipAnchor, useMediaQuery, useLocalize, cn } from '@librechat/client';
import type { TConversation, SettingDefinition, TReasoningOverride } from 'librechat-data-provider';
import type { NamedExoticComponent } from 'react';
import Effort, { effortRank, resolveEffortLabel } from './Effort';

export interface ThinkingControlProps {
  index: number;
  setting: SettingDefinition;
  conversation: TConversation | null;
  value?: TReasoningOverride;
  disabled: boolean;
  onChange: (value: TReasoningOverride) => void;
}

/** Past the longest label roll (280ms in the app's stylesheet), with room for a busy frame. */
const LABEL_ROLL_FALLBACK_MS = 400;

/** The label roll's state: the word shown, the one leaving, and which way they move. */
type LabelState = {
  text: string;
  rank: number;
  previous: string | null;
  up: boolean;
  turn: number;
};

/** The conversation's stored value for a setting key, read without widening its type. */
function readSetting(conversation: TConversation | null, key: string): unknown {
  if (conversation == null) {
    return undefined;
  }
  const fields: Record<string, unknown> = conversation;
  return fields[key];
}

/**
 * The composer's thinking-level button and its popup: the trigger names the level the next turn
 * runs at, and the popup holds the Effort track. The host resolves the setting, the value and
 * where a change is staged; this only renders them.
 */
function ThinkingControl({
  index,
  setting,
  conversation,
  value,
  disabled,
  onChange,
}: ThinkingControlProps) {
  const localize = useLocalize();
  /* Ariakit owns the open state rather than a controlled `open`/`setOpen` pair:
     with the controlled form, hide-on-interact-outside fired on mousedown and
     the disclosure's own click re-opened it, so a second click never closed the
     popup. */
  /* Above the composer on a phone, where the composer sits at the bottom of the
     screen and a popup below it would open off the edge or under the keyboard. */
  const isMobile = useMediaQuery('(max-width: 767px)');
  const popover = Ariakit.usePopoverStore({ placement: isMobile ? 'top' : 'bottom' });
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
      : (readSetting(conversation, setting.key) ?? setting.default);
  const currentValue = raw == null ? undefined : String(raw);
  const display =
    currentValue == null
      ? localize('com_ui_auto')
      : resolveEffortLabel(setting, currentValue, localize);

  /* The word on the button moves with the level: up for a higher one, down for
     a lower one, the outgoing word staying behind as a blurred ghost until it
     has cleared. `turn` restarts the animation for each change. */
  const rank = effortRank(setting, currentValue);
  const [label, setLabel] = useState<LabelState>({
    text: display,
    rank,
    previous: null,
    up: true,
    turn: 0,
  });
  if (label.text !== display) {
    setLabel({
      text: display,
      rank,
      previous: label.text,
      up: rank >= label.rank,
      turn: label.turn + 1,
    });
  }
  const clearPrevious = (turn: number) =>
    setLabel((state) => (state.turn === turn ? { ...state, previous: null } : state));

  /* The outgoing word normally leaves when its animation ends. The animation is defined by the
     host's stylesheet, so a host that does not load it would keep both words stacked in the
     slot; past the longest roll, the outgoing word is dropped either way. */
  const rolling = label.previous != null;
  useEffect(() => {
    if (!rolling) {
      return;
    }
    const turn = label.turn;
    const timer = window.setTimeout(
      () => setLabel((state) => (state.turn === turn ? { ...state, previous: null } : state)),
      LABEL_ROLL_FALLBACK_MS,
    );
    return () => window.clearTimeout(timer);
  }, [rolling, label.turn]);

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
        ? Math.max(
            0,
            ...Array.from(ghosts.children, (el) =>
              el instanceof HTMLElement ? el.offsetWidth : 0,
            ),
          )
        : 0;
    const measured = open ? widest : (currentRef.current?.offsetWidth ?? 0);
    if (measured > 0) {
      setSlotWidth(measured);
    }
  }, [open, display, optionLabels]);

  /* Opens downward on wider screens; Ariakit flips it above on its own once
     the composer sits low enough in the viewport that there is no room below. */
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
            render={<Button variant="composer-pill" />}
          />
        }
        className="flex shrink-0"
      >
        {/* Closed, the button hugs its label so it takes no more room in the bar
            than it needs. Open, it widens to the longest label and the text
            centres, so changing levels while the popup is up never shifts the
            row. A level change never dips the label to transparent (a plain
            keyed crossfade did, and read as a flicker): the new word arrives
            while the old one is still leaving, so one is always legible. */}
        <span
          /* `composer-slot-resize` runs on `animate-composer-popover`'s clock,
             so the button and the popup resize together. */
          className="composer-slot-resize relative block overflow-hidden"
          style={{ width: slotWidth }}
        >
          <span
            ref={ghostsRef}
            aria-hidden="true"
            className="pointer-events-none invisible absolute top-0 left-0 w-max"
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
            className="pointer-events-none invisible absolute top-0 left-0 w-max whitespace-nowrap"
          >
            {display}
          </span>
          {/* Always centred: flipping alignment as the width animated made the
              label jump sideways mid-transition. Closed the slot is exactly the
              label's width, so centred and left are identical anyway. */}
          <span className="grid text-center whitespace-nowrap">
            {label.previous != null && (
              <span
                key={`out-${label.turn}`}
                aria-hidden="true"
                onAnimationEnd={() => clearPrevious(label.turn)}
                className={cn(
                  'col-start-1 row-start-1',
                  label.up ? 'composer-label-out-up' : 'composer-label-out-down',
                )}
              >
                {label.previous}
              </span>
            )}
            <span
              key={`in-${label.turn}`}
              className={cn(
                'col-start-1 row-start-1',
                label.turn > 0 && (label.up ? 'composer-label-in-up' : 'composer-label-in-down'),
              )}
            >
              {display}
            </span>
          </span>
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
        hideOnInteractOutside={(event) =>
          !(event.target instanceof Node && disclosureRef.current?.contains(event.target) === true)
        }
        /* On a phone the button sits inside the composer, so opening above the
           button alone would cover the message field. It rises from the
           composer's top edge instead, still centred over its button. */
        getAnchorRect={
          isMobile
            ? (anchor) => {
                const button = anchor?.getBoundingClientRect();
                const composer = anchor?.closest('form')?.getBoundingClientRect();
                if (button == null || composer == null) {
                  return null;
                }
                return { x: button.x, y: composer.y, width: button.width, height: 0 };
              }
            : undefined
        }
        aria-label={localize('com_ui_composer_thinking_value', { 0: display })}
        /* `border-light` resolves to the same value as `surface-tertiary`, so
           the edge was invisible against the popup's own background. */
        className="animate-composer-popover border-border-medium bg-surface-tertiary rounded-theme-popover z-50 border shadow-lg outline-hidden"
      >
        <Effort setting={setting} conversation={conversation} value={value} onChange={onChange} />
      </Ariakit.Popover>
    </Ariakit.PopoverProvider>
  );
}

const MemoThinkingControl: NamedExoticComponent<ThinkingControlProps> = memo(ThinkingControl);

export default MemoThinkingControl;
