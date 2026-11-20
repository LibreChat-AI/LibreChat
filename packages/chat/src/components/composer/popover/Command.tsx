import { useId, useRef, useEffect } from 'react';
import { Input, Spinner, useRemScale } from '@librechat/client';
import type { Dispatch, ReactNode, SetStateAction, KeyboardEvent } from 'react';
import type { CommandListProps, CommandListRow } from '../../../react/input';
import type { MentionItemProps } from '../MentionItem';
import { useComposerHost } from '../../../react/input';
import MentionItem from '../MentionItem';

const ROW_HEIGHT = 44;
const MAX_LIST_HEIGHT = 160;
const BLUR_CLOSE_DELAY = 150;

/** One entry a command popover lists. */
export type CommandOption = {
  type: string;
  value: string;
  label?: string;
  description?: string;
  icon?: ReactNode;
};

/** Why a popover asks to close: the key that closed it, or focus leaving its input. */
export type CommandDismissReason = 'escape' | 'backspace' | 'commit' | 'blur';

export interface CommandPopoverProps {
  type: NonNullable<MentionItemProps['type']>;
  /** Localized placeholder, also the listbox's accessible name. */
  placeholder: string;
  inputRef: (node: HTMLInputElement | null) => void;
  searchValue: string;
  onSearchChange: (value: string) => void;
  open: boolean;
  onOpen: () => void;
  matches: CommandOption[];
  activeIndex: number;
  onActiveIndexChange: Dispatch<SetStateAction<number>>;
  isLoading?: boolean;
  /** A message shown under the search field while open, such as an empty or failed list. */
  notice?: ReactNode;
  /** Enter or Tab on an option, or a click; the key event lets the caller decide its default. */
  onSelect: (option: CommandOption, event?: KeyboardEvent<HTMLInputElement>) => void;
  /** The popover asks to close; a key event is present unless focus left the input. */
  onDismiss: (reason: CommandDismissReason, event?: KeyboardEvent<HTMLInputElement>) => void;
}

/** Without a host list every option renders, inside the scrolling listbox. */
function PlainList({ count, renderRow }: CommandListProps): React.JSX.Element {
  return (
    <>
      {Array.from({ length: count }, (_, index) =>
        renderRow({ index, key: `${index}`, style: {} }),
      )}
    </>
  );
}

/** A search field that filters a list of composer commands, driven by the keyboard as a combobox:
 *  arrows move the active option, Enter or Tab picks it, Escape or Backspace on an empty search
 *  closes. Rows go through the host's windowed list when it supplies one. */
export default function CommandPopover({
  type,
  placeholder,
  inputRef,
  searchValue,
  onSearchChange,
  open,
  onOpen,
  matches,
  activeIndex,
  onActiveIndexChange,
  isLoading = false,
  notice,
  onSelect,
  onDismiss,
}: CommandPopoverProps): React.JSX.Element {
  const listboxId = useId();
  const remScale = useRemScale();
  const { renderCommandList } = useComposerHost();
  const listRef = useRef<HTMLDivElement | null>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelBlurClose = () => {
    if (blurTimer.current) {
      clearTimeout(blurTimer.current);
    }
    blurTimer.current = null;
  };

  useEffect(() => cancelBlurClose, []);

  useEffect(() => {
    onActiveIndexChange((prev) => Math.min(prev, Math.max(matches.length - 1, 0)));
  }, [matches.length, onActiveIndexChange]);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView({ behavior: 'instant', block: 'nearest' });
  }, [activeIndex, matches]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      onDismiss('escape', e);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (matches.length === 0) {
        return;
      }
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      onActiveIndexChange((prev) => (prev + step + matches.length) % matches.length);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const option = matches[activeIndex];
      if (option == null) {
        onDismiss('commit', e);
        return;
      }
      onSelect(option, e);
      return;
    }
    if (e.key === 'Backspace' && searchValue === '') {
      onDismiss('backspace', e);
    }
  };

  const showList = open && matches.length > 0;
  const activeId = showList ? `${type}-item-${activeIndex}` : undefined;

  const renderRow = ({ index, key, style }: CommandListRow): ReactNode => {
    const option = matches[index];
    return (
      <MentionItem
        key={key}
        type={type}
        role="option"
        index={index}
        style={style}
        name={option.label ?? ''}
        icon={option.icon}
        description={option.description}
        isActive={index === activeIndex}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          cancelBlurClose();
          onSelect(option);
        }}
      />
    );
  };

  const listProps: CommandListProps = {
    count: matches.length,
    activeIndex,
    rowHeight: ROW_HEIGHT * remScale,
    height: Math.min(matches.length * ROW_HEIGHT, MAX_LIST_HEIGHT) * remScale,
    renderRow,
  };

  return (
    <div className="absolute bottom-28 z-10 w-full space-y-2">
      <div className="popover border-border-light bg-surface-tertiary-alt rounded-theme-popover border p-2 shadow-lg">
        <Input
          ref={inputRef}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listboxId}
          aria-activedescendant={activeId}
          placeholder={placeholder}
          variant="embedded"
          className="mb-1"
          autoComplete="off"
          value={searchValue}
          onKeyDown={handleKeyDown}
          onChange={(e) => onSearchChange(e.target.value)}
          onFocus={onOpen}
          onBlur={() => {
            blurTimer.current = setTimeout(() => onDismiss('blur'), BLUR_CLOSE_DELAY);
          }}
        />
        {open && isLoading && matches.length === 0 && (
          <div className="text-text-primary flex h-32 items-center justify-center">
            <Spinner />
          </div>
        )}
        {open && notice != null && (
          <div role="status" className="text-text-secondary p-4 text-center text-sm">
            {notice}
          </div>
        )}
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={placeholder}
          hidden={!showList}
          className="max-h-40 overflow-y-auto"
        >
          {showList &&
            (renderCommandList ? renderCommandList(listProps) : <PlainList {...listProps} />)}
        </div>
      </div>
    </div>
  );
}
