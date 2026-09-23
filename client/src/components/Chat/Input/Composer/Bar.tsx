import React, { memo, useMemo, useState, useCallback } from 'react';
import * as Ariakit from '@ariakit/react';
import { Mic, Plus, Check, Square, ChevronDown } from 'lucide-react';
import { MCPIcon, IconButton, TooltipAnchor, SendIcon } from '@librechat/client';
import type { TConversation, EModelEndpoint, EndpointFileConfig } from 'librechat-data-provider';
import type { PaletteEntry, PaletteMode } from '~/hooks/Input/usePaletteEntries';
import type { Dictation } from '~/hooks/Input/useDictation';
import type { ExtendedFile, FileSetter } from '~/common';
import usePaletteEntries from '~/hooks/Input/usePaletteEntries';
import MCPConfigDialog from '~/components/MCP/MCPConfigDialog';
import useElementSize from '~/hooks/Generic/useElementSize';
import useChipPacking from '~/hooks/Input/useChipPacking';
import { useBadgeRowContext } from '~/Providers';
import TokenUsage from '../TokenUsage';
import { useLocalize } from '~/hooks';
import Thinking from './Thinking';
import Palette from './Palette';
import { cn } from '~/utils';
import Chip from './Chip';

/** Stable identity so the memo below is not defeated when tools are hidden. */
const EMPTY_ENTRIES: PaletteEntry[] = [];

/** Matches the rows' `gap-1.5`, which the split arithmetic has to account for. */
const CHIP_GAP = 6;
/**
 * Key of the aggregate MCP menu chip. Server rows are keyed `mcp:${serverName}`
 * (`usePaletteEntries`), so this cannot live in that namespace: a server named
 * `pinned` would produce the same key, and the bar would render two entries
 * with one React key and one packing-width slot.
 */
export const PINNED_MCP_KEY = 'aggregate:mcp';

/**
 * Whether every chip fits on the button row beside the `+` and the controls.
 *
 * All or nothing: chips share that row only while they are few enough to need
 * no row of their own. Once they do not fit they all move to a row above, so
 * the buttons keep a row of their own rather than being crowded by whichever
 * two or three chips happened to be left over.
 */
export function chipsFitInline<T extends { key: string }>(
  entries: T[],
  widths: Record<string, number>,
  capacity: number,
): boolean {
  if (entries.length === 0) {
    return true;
  }
  if (capacity <= 0) {
    return false;
  }
  let used = 0;
  for (const entry of entries) {
    const width = widths[entry.key];
    /* Before the first measuring pass nothing is known, so everything stays on
       one row, the same unmeasured state the packing order starts from. */
    if (width == null) {
      return true;
    }
    used += width + (used > 0 ? CHIP_GAP : 0);
    if (used > capacity) {
      return false;
    }
  }
  return true;
}

export function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Named sub-modes stay on the chip (Artifacts, MCP). Icon-only actions such
 *  as web-search Configure belong on the palette row, not behind a chevron. */
export function chipMenuModes(modes?: PaletteMode[]) {
  return modes?.filter((mode) => mode.icon == null) ?? [];
}

/** Projects palette state into the persistent quick controls in one pass. */
export function projectBarEntries(
  entries: PaletteEntry[],
  pinnedMcpEntry?: PaletteEntry,
): PaletteEntry[] {
  const projected: PaletteEntry[] = [];
  const mcpModes: PaletteMode[] = [];

  for (const entry of entries) {
    if (entry.section === 'skill') {
      continue;
    }
    if (entry.section === 'mcp') {
      mcpModes.push({
        id: entry.itemId,
        label: entry.label,
        active: entry.active,
        onSelect: entry.onSelect,
      });
    }
    if (entry.active || entry.pinned) {
      projected.push(entry);
    }
  }

  if (pinnedMcpEntry != null && mcpModes.length > 0) {
    projected.push({ ...pinnedMcpEntry, modes: mcpModes });
  }

  return projected;
}

interface RoundButtonProps {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  primary?: boolean;
  disabled?: boolean;
}

function RoundButton({
  label,
  onClick,
  children,
  primary = false,
  disabled = false,
}: RoundButtonProps) {
  return (
    <TooltipAnchor
      description={label}
      disabled={disabled}
      render={
        <IconButton
          label={label}
          size="md"
          variant={primary ? 'primary' : 'ghost'}
          onClick={onClick}
          disabled={disabled}
        >
          {/* IconButton owns its own text color; this fills the button so the
              icon (currentColor) starts muted and brightens on hover, without
              restyling the primitive itself. */}
          <span
            className={cn(
              'flex h-full w-full items-center justify-center',
              !primary && 'text-text-secondary hover:text-text-primary transition-colors',
            )}
          >
            {children}
          </span>
        </IconButton>
      }
    />
  );
}

/**
 * Sub-mode switch carried on the chip itself, so Artifacts' generation mode can
 * be changed without reopening the palette. Real menu items, unlike the
 * pointer-only pills inside the palette's `option` rows.
 */
interface ChipModesProps {
  modes: PaletteMode[];
  menuLabel?: string;
}

export function ChipModes({ modes, menuLabel }: ChipModesProps) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const active = modes.find((mode) => mode.active);

  return (
    <Ariakit.MenuProvider open={open} setOpen={setOpen} placement="bottom">
      <Ariakit.MenuButton
        aria-label={
          active != null
            ? localize('com_ui_mode_value', { 0: active.label })
            : (menuLabel ?? localize('com_ui_mode'))
        }
        onClick={(e) => e.stopPropagation()}
        className="text-text-secondary hover:bg-surface-tertiary hover:text-text-primary focus-visible:ring-border-xheavy -mr-0.5 flex shrink-0 items-center gap-0.5 rounded px-1 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-hidden"
      >
        {active != null && <span className="max-w-[7rem] truncate">{active.label}</span>}
        <ChevronDown
          className={cn('animate-composer-icon size-3 shrink-0 opacity-70', open && '-rotate-180')}
          aria-hidden="true"
        />
      </Ariakit.MenuButton>
      {/* Same entrance as the palette and the thinking popup, and the same
          anchored origin, so it grows out of the chip in whichever direction it
          ends up opening. */}
      <Ariakit.Menu
        portal
        gutter={6}
        unmountOnHide
        onClick={(event) => event.stopPropagation()}
        className="animate-composer-popover border-border-light bg-presentation z-50 min-w-[10rem] rounded-xl border p-1 shadow-lg outline-hidden"
      >
        {modes.map((mode) => (
          <Ariakit.MenuItem
            key={mode.id}
            hideOnClick={false}
            role="menuitemradio"
            aria-checked={mode.active}
            onClick={mode.onSelect}
            className="text-text-secondary data-[active-item]:bg-surface-hover data-[active-item]:text-text-primary flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm"
          >
            <span className="truncate">{mode.label}</span>
            {mode.active && <Check className="size-4 shrink-0" aria-hidden="true" />}
          </Ariakit.MenuItem>
        ))}
      </Ariakit.Menu>
    </Ariakit.MenuProvider>
  );
}

interface BarProps {
  index: number;
  isRTL: boolean;
  disabled: boolean;
  agentId?: string | null;
  endpoint?: string | null;
  endpointType?: EModelEndpoint | string;
  endpointFileConfig?: EndpointFileConfig;
  useResponsesApi?: boolean;
  conversationId: string;
  conversation: TConversation | null;
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  setFilesLoading: React.Dispatch<React.SetStateAction<boolean>>;
  canAttach: boolean;
  /** The composer box, which the palette anchors to instead of its own button. */
  anchorRef: React.RefObject<HTMLElement>;
  /** Mirrors the old `showEphemeralBadges` gate: agents and assistants carry
   *  their own tool config, and a spec can suppress the row outright. */
  showTools: boolean;
  isSubmitting: boolean;
  showSpeech: boolean;
  speechDisabled: boolean;
  hasAddedConversation: boolean;
  /** Code approval and review controls supplied by the composer shell. */
  approvalSlot?: React.ReactNode;
  /** Send, stop or the during-run split button, decided by the caller. */
  actionSlot: React.ReactNode;
  /** Owned by `ChatForm`, which also paints the trace over the textarea. */
  dictation: Dictation;
}

/**
 * The composer's action bar. The palette and the chips for whatever tools are
 * currently on sit left; model/effort, context, speech and send sit right.
 * Inactive tools appear only when pinned as persistent quick controls.
 */
function Bar({
  index,
  isRTL,
  disabled,
  agentId,
  endpoint,
  endpointType,
  endpointFileConfig,
  useResponsesApi,
  conversationId,
  conversation,
  files,
  setFiles,
  setFilesLoading,
  canAttach,
  anchorRef,
  showTools,
  isSubmitting,
  showSpeech,
  speechDisabled,
  hasAddedConversation,
  approvalSlot,
  actionSlot,
  dictation,
}: BarProps) {
  const localize = useLocalize();
  const context = useBadgeRowContext();
  /* Latched on the palette's first open and never released: the skills catalog
     is only walked for composers whose palette was actually used, and closing
     it keeps the pages cached rather than refetching per open. */
  const [catalogWanted, setCatalogWanted] = useState(false);
  const [catalogOpenRevision, setCatalogOpenRevision] = useState(0);
  const onPaletteOpen = useCallback(() => {
    setCatalogWanted(true);
    setCatalogOpenRevision((revision) => revision + 1);
  }, []);
  const allEntries = usePaletteEntries({
    conversationId,
    agentId,
    enabled: showTools || agentId != null,
    toolsEnabled: showTools,
    catalogEnabled: catalogWanted,
    catalogOpenRevision,
  });

  /* Servers with required variables open this before they can be selected; it
     lives here rather than in the palette so dismissing the popover mid-config
     does not unmount the dialog. */
  const mcpConfigProps = context?.mcpServerManager?.getConfigDialogProps();
  /* `usePaletteEntries` already returns nothing once `enabled` is false, so the
     gate lives in one place rather than being re-applied to its result here. */
  const entries = allEntries;

  const manager = context?.mcpServerManager;
  const pinnedMcpEntry = useMemo<PaletteEntry | undefined>(() => {
    if (manager?.isPinned !== true) {
      return undefined;
    }
    const { placeholderText, setIsPinned } = manager;
    return {
      key: PINNED_MCP_KEY,
      itemType: 'mcp',
      itemId: 'mcp',
      label: placeholderText || localize('com_ui_mcp_servers'),
      icon: <MCPIcon className="h-4 w-4" aria-hidden="true" />,
      section: 'mcp',
      active: true,
      pinned: true,
      onSelect: () => setIsPinned(false),
    };
  }, [manager, localize]);

  /* Catalog skills are excluded: a picked skill is staged context for the next
     turn, so it belongs in the tray above the textarea with files and quotes.
     Built-in tool pins remain visible while off. The legacy aggregate MCP pin
     remains one server menu alongside any selected server chips. */
  const barEntries = useMemo(
    () => projectBarEntries(entries, pinnedMcpEntry),
    [entries, pinnedMcpEntry],
  );
  /* Catalog order puts long skill and MCP names mid-row, stranding the rest of
     that row; packing widest-first fills the rows instead. */
  const { ordered: packedEntries, rootRef, widths } = useChipPacking(barEntries);

  const { ref: rowRef, width: rowWidth } = useElementSize<HTMLDivElement>();
  const { ref: plusRef, width: plusWidth } = useElementSize<HTMLSpanElement>();
  const { ref: controlsRef, width: controlsWidth } = useElementSize<HTMLDivElement>();

  /* A row of their own once they need one, and it runs the full width of the
     composer (the `+` corner included), since the buttons are on the row below
     it rather than in the flow. */
  const inlineChips = useMemo(
    () =>
      chipsFitInline(packedEntries, widths, rowWidth - plusWidth - controlsWidth - CHIP_GAP * 2),
    [packedEntries, widths, rowWidth, plusWidth, controlsWidth],
  );
  const dictating = dictation.active || dictation.transcribing;

  /* Spoken rather than shown: the recording state is otherwise carried only by
     two buttons quietly changing their names, which a reader will not re-read
     for a control that already has focus. The elapsed seconds stay out of it,
     since a region that changes every second is read every second. */
  let dictationStatus = '';
  if (dictation.transcribing) {
    dictationStatus = localize('com_ui_transcribing');
  } else if (dictating) {
    dictationStatus = localize('com_ui_listening');
  }

  /* The arrangement is frozen for the length of a recording. The controls
     shrink to just the elapsed time while one runs, which would otherwise let
     chips qualify for the bottom row and re-mount there mid-animation: a chip
     that changes parent restarts from its new parent's resting state, which is
     no transition at all. */
  const [restingInline, setRestingInline] = useState(true);
  if (!dictating && restingInline !== inlineChips) {
    setRestingInline(inlineChips);
  }
  const chipsInline = dictating ? restingInline : inlineChips;
  const above = chipsInline ? EMPTY_ENTRIES : packedEntries;
  const inline = chipsInline ? packedEntries : EMPTY_ENTRIES;

  const rowClass = cn(
    'flex flex-wrap items-center gap-1.5',
    isRTL ? 'flex-row-reverse' : 'flex-row',
  );
  const barClass = 'flex flex-col gap-1.5 px-2 pb-2';

  const renderChip = (entry: PaletteEntry) => {
    const pinnedInactive = entry.pinned && !entry.active;
    const isPinnedMcp = entry.key === PINNED_MCP_KEY;
    const menuModes = chipMenuModes(entry.modes);
    const modeMenu =
      menuModes.length > 0 ? (
        <ChipModes modes={menuModes} menuLabel={isPinnedMcp ? entry.label : undefined} />
      ) : null;
    const activate = pinnedInactive ? (
      <IconButton
        label={localize('com_ui_select_var', { 0: entry.label })}
        size="xs"
        className="-mr-1"
        onClick={entry.onSelect}
      >
        {/* Matches the chip's own `tone="surface"` text color: IconButton owns
            its own color, so the glyph carries it directly rather than
            inheriting through the button. */}
        <Plus className="text-text-secondary size-3" aria-hidden="true" />
      </IconButton>
    ) : null;

    return (
      <Chip
        key={entry.key}
        label={entry.label}
        icon={entry.icon}
        trailing={
          modeMenu != null || activate != null ? (
            <span className="flex items-center gap-0.5">
              {modeMenu}
              {activate}
            </span>
          ) : undefined
        }
        onRemove={pinnedInactive ? entry.onUnpin : entry.onSelect}
        removeLabel={
          isPinnedMcp || pinnedInactive
            ? localize('com_ui_unpin')
            : localize('com_ui_remove_var', { 0: entry.label })
        }
        data-testid={`composer-active-${entry.itemType}`}
      />
    );
  };

  return (
    <div ref={rootRef} className={barClass}>
      {/* Full-width rows, so the chips run right across the composer including
          the corner the `+` sits in. Labelled the same as the row below: one
          set of tools that happens to need two rows to fit.

          Wrapped in a `0fr`/`1fr` grid rather than dropped outright while
          dictating: height has nothing to animate between unless something
          supplies the two ends, and this supplies them without measuring. */}
      <div
        aria-hidden={above.length === 0 || dictating}
        {...(above.length === 0 || dictating ? { inert: '' } : {})}
        className={cn(
          'grid transition-all duration-200 ease-out motion-reduce:transition-none',
          above.length > 0 && !dictating
            ? 'grid-rows-[1fr] opacity-100'
            : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="overflow-hidden">
          {/* Travels down as the row above closes over it, so the chips read as
              moving out of the way rather than being wiped from the bottom up. */}
          <div
            role="list"
            aria-label={localize('com_ui_composer_tools')}
            className={cn(
              rowClass,
              'pb-1.5 transition-transform duration-200 ease-out',
              dictating ? 'translate-y-3' : 'translate-y-0',
            )}
          >
            {above.map(renderChip)}
          </div>
        </div>
      </div>
      <div ref={rowRef} className={rowClass}>
        {/* Never unmounted, so its glyph can turn into the close mark rather
            than one icon being swapped for another. */}
        <span ref={plusRef} className="shrink-0">
          <Palette
            index={index}
            entries={entries}
            disabled={disabled}
            dictating={dictating}
            onOpened={onPaletteOpen}
            onCancel={dictation.cancel}
            agentId={agentId}
            endpoint={endpoint}
            endpointType={endpointType}
            endpointFileConfig={endpointFileConfig}
            useResponsesApi={useResponsesApi}
            conversationId={conversationId}
            conversation={conversation}
            files={files}
            setFiles={setFiles}
            setFilesLoading={setFilesLoading}
            canAttach={canAttach}
            anchorRef={anchorRef}
          />
        </span>
        {/* A box rather than `contents` so it has something to move: the split
            only puts chips here when they all fit on this line, so wrapping as
            one unit and wrapping as siblings come to the same layout. */}
        <div
          role="list"
          aria-label={localize('com_ui_composer_tools')}
          aria-hidden={dictating}
          /* Hidden from a reader and unreachable by a pointer, but every chip
             still holds a remove button that Tab would land on. `inert` is what
             takes those out of the tab order along with everything else. */
          {...(dictating ? { inert: '' } : {})}
          className={cn(
            'flex min-w-0 flex-wrap items-center gap-1.5',
            'transition duration-200 ease-out motion-reduce:transition-none',
            dictating ? 'pointer-events-none translate-y-3 opacity-0' : 'translate-y-0 opacity-100',
          )}
        >
          {inline.map(renderChip)}
        </div>
        {/* Auto margin on the main-start side, so the group sits at the end of
            the row whether or not chips share it.

            The mic and the send button hold their places through a recording:
            each takes over the job next to it (stop, and stop-and-send) rather
            than being replaced by a control that slides in somewhere else. Only
            what has no job during a recording actually moves. */}
        <div
          ref={controlsRef}
          className={cn('flex shrink-0 items-center gap-1.5', isRTL ? 'mr-auto' : 'ml-auto')}
        >
          {/* One cell holding both: the settled controls drop out of it as the
              elapsed time rises into their place, and the row keeps one width
              throughout so nothing beside it shifts. */}
          <div className="grid">
            <div
              aria-hidden={dictating}
              {...(dictating ? { inert: '' } : {})}
              className={cn(
                'col-start-1 row-start-1 flex items-center justify-end gap-1.5',
                'transition duration-200 ease-out motion-reduce:transition-none',
                dictating
                  ? 'pointer-events-none translate-y-3 opacity-0'
                  : 'translate-y-0 opacity-100',
              )}
            >
              <Thinking
                index={index}
                disabled={disabled}
                hasAddedConversation={hasAddedConversation}
              />
              <TokenUsage index={index} conversation={conversation} isSubmitting={isSubmitting} />
            </div>
            {/* Arrives and leaves in depth. The elapsed time is not one of the
                things that stepped aside, so it has nowhere to travel from:
                it comes forward into the row and recedes back out of it. */}
            <div
              aria-hidden={!dictating}
              {...(dictating ? {} : { inert: '' })}
              className={cn(
                'col-start-1 row-start-1 flex origin-center items-center justify-end px-1',
                'transition duration-200 ease-out motion-reduce:transition-none',
                dictating ? 'scale-100 opacity-100' : 'pointer-events-none scale-90 opacity-0',
              )}
            >
              <span className="text-text-secondary text-xs tabular-nums" aria-hidden="true">
                {dictation.transcribing
                  ? localize('com_ui_transcribing')
                  : formatElapsed(dictation.elapsed)}
              </span>
            </div>
          </div>
          {approvalSlot}
          <span role="status" aria-live="polite" className="sr-only">
            {dictationStatus}
          </span>
          {showSpeech && (
            <RoundButton
              label={dictating ? localize('com_ui_stop') : localize('com_ui_use_micrphone')}
              onClick={dictating ? dictation.stopToComposer : dictation.start}
              /* Once the take is handed to the transcriber there is nothing left
                 to stop, and pressing either of these again would only rewrite
                 how a take that has already been committed gets spent. Cancel,
                 on the `+`, stays live: an external transcription in flight can
                 still be thrown away. */
              disabled={
                dictation.transcribing ||
                (!dictating && (speechDisabled || dictation.startDisabled))
              }
            >
              {dictating ? (
                <Square className="size-4 fill-current" aria-hidden="true" />
              ) : (
                <Mic className="size-5" aria-hidden="true" />
              )}
            </RoundButton>
          )}
          {dictating ? (
            <RoundButton
              primary
              label={localize('com_nav_send_message')}
              onClick={dictation.stopAndSend}
              disabled={dictation.transcribing}
            >
              <SendIcon size={18} />
            </RoundButton>
          ) : (
            actionSlot
          )}
        </div>
      </div>
      {mcpConfigProps && (
        <MCPConfigDialog
          {...mcpConfigProps}
          conversationId={conversationId}
          storageContextKey={context?.storageContextKey}
        />
      )}
    </div>
  );
}

export default memo(Bar);
