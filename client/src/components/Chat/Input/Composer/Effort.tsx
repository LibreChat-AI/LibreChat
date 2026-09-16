import { memo, useRef, useMemo, useState, useEffect, useCallback, useLayoutEffect } from 'react';
import { CircleHelp } from 'lucide-react';
import { Constants, reasoningOverrideSchema } from 'librechat-data-provider';
import {
  HoverCard,
  IconButton,
  HoverCardTrigger,
  HoverCardContent,
  HoverCardPortal,
} from '@librechat/client';
import type { SettingDefinition, TConversation, TReasoningOverride } from 'librechat-data-provider';
import type { CSSProperties } from 'react';
import type { LocalizeFunction } from '~/common';
import type { TranslationKeys } from '~/hooks';
import useReducedMotion from '~/hooks/Generic/useReducedMotion';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/** Values represented outside the graded track. Their provider mapping names
 *  the separate mode, which can be Auto, Off, or another provider label, while
 *  the slider itself only expresses "how much".
 *
 *  `none` is deliberately NOT here: it is a real setting meaning "do not reason
 *  at all", and swallowing it hid the track's own first stop. */
const UNGRADED_VALUES = new Set(['unset', 'auto', '']);

const TRACK_H = 24;
/** The thumb overhangs the rail slightly at rest and grows while held, so the
 *  row is sized to the largest it can get and the rail is banded inside it. */
const THUMB = 28;
const THUMB_ACTIVE = 32;
/** The fill clears before the thumb that covers it starts to fade. */
const FILL_FADE_MS = 90;
/** Which way each arrow key moves along the track. */
const ARROW_STEP: Record<string, number | undefined> = {
  ArrowLeft: -1,
  ArrowUp: -1,
  ArrowRight: 1,
  ArrowDown: 1,
};

const THUMB_FADE_MS = 140;
/**
 * `enumMappings` maps a raw value to a translation KEY, not to display text:
 * rendering it directly is what leaks `com_ui_medium` into the UI. Shared with
 * the trigger button, which is the only place the level is named.
 */
export function resolveEffortLabel(
  setting: SettingDefinition,
  value: string,
  localize: LocalizeFunction,
): string {
  const mapped = setting.enumMappings?.[value];
  if (mapped != null) {
    const key = String(mapped);
    const translated = localize(key as TranslationKeys);
    if (translated !== '' && translated !== key) {
      return translated;
    }
  }
  if (UNGRADED_VALUES.has(value)) {
    return localize('com_ui_auto');
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

interface EffortProps {
  setting: SettingDefinition;
  conversation: TConversation | null;
  value?: TReasoningOverride;
  onChange: (value: TReasoningOverride) => void;
}

/**
 * Reasoning effort as a filled track running from faster to smarter.
 *
 * The stops are named choices, not a continuum, so the interactive layer is a
 * radiogroup of segment hit-targets, giving correct arrow-key and screen-reader
 * behaviour for free, with pointer drag layered on top so the thumb can also
 * be swept the way a touch control behaves.
 *
 * The level is deliberately not named in here: the button that opens this owns
 * that, so the value never appears in two places at once.
 */
function Effort({ setting, conversation, value, onChange }: EffortProps) {
  const localize = useLocalize();
  const trackRef = useRef<HTMLDivElement>(null);
  /** Ref drives the gesture (pointermove fires before a state flush would land);
   *  the state only feeds styling. */
  const draggingRef = useRef(false);
  const reducedMotion = useReducedMotion();
  /** One per stop, so an arrow key can move focus along with the selection. */
  const stopRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [dragging, setDragging] = useState(false);

  const { levels, ungradedValue } = useMemo(() => {
    const options = (setting.options ?? []).map(String);
    return {
      levels: options.filter((option) => !UNGRADED_VALUES.has(option)),
      ungradedValue: options.find((option) => UNGRADED_VALUES.has(option)),
    };
  }, [setting.options]);

  /* Same resolution as the trigger: an untouched conversation falls back to
     the setting's possibly admin-overridden default, not to the separate mode. */
  const raw =
    value?.key === setting.key
      ? value.value
      : (conversation?.[setting.key as keyof TConversation] ?? setting.default);
  const current = raw == null ? undefined : String(raw);
  const isUngraded = current == null || UNGRADED_VALUES.has(current);
  const activeIndex = isUngraded ? -1 : levels.indexOf(current);

  /* The graded level the separate mode was turned on from. Two jobs: that mode
     has no position on the rail, so the fill and thumb hold this one while they
     fade (without it the thumb unmounted instantly and left the fill briefly
     naked, which flashed green), and switching the separate mode off returns here
     instead of dumping the user on the lowest level.

     Held as a value rather than an index, and scoped to the conversation it was
     seen in: the option list differs per model, so an index carried across a
     model switch would point at a different level or none at all. Anything that
     no longer resolves falls back to the first level. */
  const conversationKey = conversation?.conversationId ?? '';
  const settingKey = `${setting.key}\u0000${conversation?.endpoint ?? ''}\u0000${conversation?.model ?? ''}\u0000${conversation?.spec ?? ''}`;
  const [remembered, setRemembered] = useState<{
    conversationKey: string;
    settingKey: string;
    value: string;
  } | null>(null);
  if (
    activeIndex >= 0 &&
    current != null &&
    (remembered?.value !== current ||
      remembered.conversationKey !== conversationKey ||
      remembered.settingKey !== settingKey)
  ) {
    setRemembered({ conversationKey, settingKey, value: current });
  } else if (
    remembered != null &&
    remembered.settingKey === settingKey &&
    remembered.conversationKey !== conversationKey &&
    (remembered.conversationKey === '' || remembered.conversationKey === Constants.NEW_CONVO)
  ) {
    /* A new chat carries a placeholder id until its first message lands. The
       level chosen before sending is still the same user in the same thread, so
       it follows the conversation into its real id rather than being dropped. */
    setRemembered({ conversationKey, settingKey, value: remembered.value });
  }
  const rememberedIndex =
    remembered != null &&
    remembered.conversationKey === conversationKey &&
    remembered.settingKey === settingKey
      ? levels.indexOf(remembered.value)
      : -1;
  const restoreIndex = rememberedIndex >= 0 ? rememberedIndex : 0;
  const shownIndex = activeIndex >= 0 ? activeIndex : restoreIndex;
  const initialShownIndex = useRef(shownIndex);

  useLayoutEffect(() => {
    stopRefs.current[initialShownIndex.current]?.focus();
  }, []);

  const select = useCallback(
    (nextValue: string) => {
      const parsed = reasoningOverrideSchema.safeParse({ key: setting.key, value: nextValue });
      if (parsed.success) {
        onChange(parsed.data);
      }
    },
    [onChange, setting.key],
  );
  const label = useCallback(
    (value: string) => resolveEffortLabel(setting, value, localize),
    [setting, localize],
  );
  const activeUngradedValue =
    current != null && UNGRADED_VALUES.has(current) ? current : ungradedValue;
  const ungradedLabel =
    activeUngradedValue != null ? label(activeUngradedValue) : localize('com_ui_auto');

  /**
   * Nearest stop to a pointer position, so a sweep snaps rather than drifts.
   *
   * Writes are coalesced to one per frame: a burst of moves within a single
   * task would each write from the same stale conversation snapshot, and an
   * earlier value could land last. Only the newest index is ever committed.
   */
  const pendingRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const selectFromPointer = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || levels.length === 0) {
        return;
      }
      const rect = track.getBoundingClientRect();
      const usable = rect.width - THUMB;
      if (usable <= 0) {
        return;
      }
      const ratio = (clientX - rect.left - THUMB / 2) / usable;
      pendingRef.current = Math.round(Math.min(1, Math.max(0, ratio)) * (levels.length - 1));
      if (frameRef.current != null) {
        return;
      }
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        const index = pendingRef.current;
        pendingRef.current = null;
        if (index != null && levels[index] != null) {
          select(levels[index]);
        }
      });
    },
    [levels, select],
  );

  useEffect(
    () => () => {
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
      }
    },
    [],
  );

  if (levels.length === 0) {
    return null;
  }

  const ratioOf = (index: number) => (levels.length === 1 ? 1 : index / (levels.length - 1));
  const offset = (ratio: number, fromRight = false) => {
    const percent = (fromRight ? 1 - ratio : ratio) * 100;
    const pixels = THUMB * (fromRight ? ratio - 0.5 : 0.5 - ratio);
    const roundedPercent = Number(percent.toFixed(6));
    const roundedPixels = Number(Math.abs(pixels).toFixed(6));
    return `calc(${roundedPercent}% ${pixels < 0 ? '-' : '+'} ${roundedPixels}px)`;
  };
  const hitArea = (index: number): CSSProperties => {
    const previousBoundary = ratioOf(index - 0.5);
    const nextBoundary = ratioOf(index + 0.5);
    return {
      left: index === 0 ? 0 : offset(previousBoundary),
      right: index === levels.length - 1 ? 0 : offset(nextBoundary, true),
    };
  };
  /* Anchored on the resting thumb size so its edge is flush with the rail at
     either end; while held it grows a couple of pixels past, which reads as the
     thumb lifting rather than as a misaligned track. */
  const centerOf = (index: number) =>
    `calc(${THUMB / 2}px + ${ratioOf(index)} * (100% - ${THUMB}px))`;
  /* Ends half a rail-height PAST the thumb's centre, which puts the fill's own
     rounded cap concentric with the thumb. The cap's radius (TRACK_H / 2) is
     smaller than the thumb's, so the thumb geometrically contains it at every
     position, including the first stop where the fill disappears entirely
     beneath it.
     That containment holds mid-animation too, because the offset is constant:
     collapsing to zero at the first stop instead left the fill briefly wider
     than the thumb could cover, which flashed green on the way down. */
  const fillWidth = (index: number) =>
    `calc(${THUMB / 2 + TRACK_H / 2}px + ${ratioOf(index)} * (100% - ${THUMB}px))`;

  /* `descriptionCode` is what says whether this is a translation key or the
     literal text an admin wrote. Translating it either way sent literal text
     through i18next, which reads anything before a colon as a namespace and
     silently drops it. */
  let descriptionText: string | undefined;
  if (setting.description != null && setting.description !== '') {
    descriptionText =
      setting.descriptionCode === true
        ? localize(setting.description as TranslationKeys)
        : setting.description;
  }
  const thumbSize = dragging ? THUMB_ACTIVE : THUMB;
  /* The track's motion is written inline, where a stylesheet's reduced-motion
     rule cannot reach it, so the durations collapse here instead. */
  let moveMs = dragging ? 75 : 150;
  let fadeMs = FILL_FADE_MS;
  let thumbFadeMs = THUMB_FADE_MS;
  if (reducedMotion) {
    moveMs = 0;
    fadeMs = 0;
    thumbFadeMs = 0;
  }

  return (
    <div className="w-[268px] p-3">
      <div
        ref={trackRef}
        role="radiogroup"
        aria-label={localize('com_ui_composer_thinking')}
        /* The rail is built on physical left offsets and clientX math, so the
           axis is explicitly LTR; the hint row below carries the same dir so
           "Faster" stays over the low end in RTL locales too. */
        dir="ltr"
        style={{ height: THUMB_ACTIVE }}
        onPointerDown={(e) => {
          /* Capture keeps the sweep alive past the track's edges. It throws for
             pointers the element never saw, which must not abort the gesture. */
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* no capture available: the drag still tracks via pointermove */
          }
          draggingRef.current = true;
          setDragging(true);
          selectFromPointer(e.clientX);
        }}
        onPointerMove={(e) => {
          if (draggingRef.current) {
            selectFromPointer(e.clientX);
          }
        }}
        onPointerUp={(e) => {
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            /* nothing was captured */
          }
          draggingRef.current = false;
          setDragging(false);
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
          setDragging(false);
        }}
        className={cn(
          'relative w-full touch-none select-none transition-opacity duration-200',
          dragging ? 'cursor-grabbing' : 'cursor-pointer',
          /* Muted while the provider is deciding, so it reads as "not set by
             you" instead of "set to the lowest". Touching it takes over. */
          isUngraded && 'opacity-60',
        )}
      >
        <span
          aria-hidden="true"
          style={{ height: TRACK_H }}
          className={cn(
            'absolute inset-x-0 top-1/2 -translate-y-1/2 rounded-full transition-colors',
            /* The border is always present and only its colour changes. Adding
               the border class on the way into the separate mode flipped its width 0 -> 1px
               with the colour animating up from `currentColor`, which flashed
               white, and the extra pixel nudged the centred label. */
            'border border-dashed',
            /* Not `surface-tertiary`: the popover itself is that colour now,
               and the rail would vanish into it. */
            isUngraded
              ? 'border-border-heavy bg-transparent'
              : 'border-transparent bg-border-medium',
          )}
        />
        {/* The semantic accent keeps the track intentional in every theme.
            Always mounted: unmounting it at the first stop made the fill snap
            out of existence on the way down instead of shrinking, which reads
            as a glitch. */}
        <span
          aria-hidden="true"
          style={{
            height: TRACK_H,
            width: fillWidth(shownIndex),
            opacity: isUngraded ? 0 : 1,
            /* Fades out faster than the thumb above it, so it is already gone
               before the thumb starts uncovering the rail. */
            transition: `width ${moveMs}ms ease-out, opacity ${fadeMs}ms ease-out`,
          }}
          className="absolute left-0 top-1/2 -translate-y-1/2 rounded-full bg-accent-primary"
        />

        {!isUngraded &&
          levels.map((value, index) => (
            <span
              key={`stop-${value}`}
              aria-hidden="true"
              style={{ left: centerOf(index) }}
              className={cn(
                'absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-50 transition-colors',
                index < activeIndex ? 'bg-surface-fixed' : 'bg-text-secondary',
              )}
            />
          ))}

        {/* The ungraded mode has no position on the track, so the rail names it
            outright rather than looking broken. */}
        {isUngraded && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] font-medium uppercase tracking-wide text-text-secondary"
          >
            {ungradedLabel}
          </span>
        )}

        {/* Always mounted: unmounting it on the way into the ungraded mode pulled
            the cover off the fill mid-fade. It holds still until the fill has
            gone, then fades itself. */}
        <span
          aria-hidden="true"
          style={{
            left: centerOf(shownIndex),
            height: thumbSize,
            width: thumbSize,
            opacity: isUngraded ? 0 : 1,
            transition: [
              `left ${moveMs}ms ease-out`,
              `height ${moveMs}ms ease-out`,
              `width ${moveMs}ms ease-out`,
              `opacity ${thumbFadeMs}ms ease-out ${isUngraded ? `${fadeMs}ms` : '0ms'}`,
            ].join(', '),
          }}
          className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-surface-fixed shadow-md"
        />

        {levels.map((value, index) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={!isUngraded && index === activeIndex}
            aria-label={label(value)}
            /* One stop for the whole group, as a radiogroup is meant to have:
               Tab reaches the current level and leaves, and the arrow keys move
               between them. In the ungraded mode no level is checked, so the one that
               would be restored takes the tab stop. */
            tabIndex={index === shownIndex ? 0 : -1}
            onKeyDown={(event) => {
              const step = ARROW_STEP[event.key];
              if (step === undefined) {
                return;
              }
              event.preventDefault();
              const next = Math.min(Math.max(index + step, 0), levels.length - 1);
              select(levels[next]);
              stopRefs.current[next]?.focus();
            }}
            ref={(node) => {
              stopRefs.current[index] = node;
            }}
            onClick={() => select(value)}
            style={hitArea(index)}
            className="absolute inset-y-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text-primary"
          />
        ))}
      </div>

      {/* One slot holding both footers: the axis hints belong to the gesture and
          the Thinking row to the resting state, so they crossfade in place
          rather than stacking. Grid keeps the height of the taller of the two. */}
      <div className="mt-1.5 grid">
        <div
          aria-hidden="true"
          dir="ltr"
          className={cn(
            'col-start-1 row-start-1 flex items-center justify-between text-[11px] text-text-secondary transition-opacity duration-150',
            dragging ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          <span>{localize('com_ui_composer_effort_faster')}</span>
          <span>{localize('com_ui_composer_effort_smarter')}</span>
        </div>

        <div
          className={cn(
            'col-start-1 row-start-1 flex items-center justify-between gap-2 transition-opacity duration-150',
            dragging ? 'pointer-events-none opacity-0' : 'opacity-100',
          )}
        >
          <span className="text-sm text-text-secondary">
            {localize('com_ui_composer_thinking')}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {/* Always present so the separate mode reads as something the user
                can turn on and off rather than as a one-way escape hatch. */}
            {ungradedValue != null && (
              <button
                type="button"
                aria-pressed={isUngraded}
                onClick={() => select(isUngraded ? levels[restoreIndex] : ungradedValue)}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] transition-colors',
                  isUngraded
                    ? 'bg-accent-primary/15 text-accent-primary'
                    : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                )}
              >
                {label(ungradedValue)}
              </button>
            )}
            {descriptionText != null && descriptionText !== '' && (
              <HoverCard openDelay={200}>
                <HoverCardTrigger asChild>
                  {/* A button rather than a bare span: this is the only place
                      the provider's own explanation of the parameter appears,
                      and hovering was the only way to reach it. */}
                  <IconButton
                    label={localize('com_ui_more_info')}
                    size="xs"
                    className="text-text-secondary"
                  >
                    <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
                  </IconButton>
                </HoverCardTrigger>
                <HoverCardPortal>
                  <HoverCardContent side="top" className="w-72 text-sm">
                    {descriptionText}
                  </HoverCardContent>
                </HoverCardPortal>
              </HoverCard>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

export default memo(Effort);
