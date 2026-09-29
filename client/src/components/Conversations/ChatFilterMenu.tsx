import { memo, useCallback, useId, useMemo, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { useAtomValue, useSetAtom } from 'jotai';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { BookmarkFilledIcon, BookmarkIcon } from '@radix-ui/react-icons';
import { TooltipAnchor, buttonVariants, usePopoverZIndex } from '@librechat/client';
import {
  Archive,
  ArrowDownAZ,
  CalendarPlus,
  Check,
  Clock,
  ListFilter,
  MessagesSquare,
  RotateCcw,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { ChatFilterStatus, ChatSortDirection, ChatSortField } from './chatFilters';
import type { TranslationKeys } from '~/hooks';
import {
  chatFilterCountAtom,
  chatFilterStatusAtom,
  chatFilterTagsAtom,
  chatSortAtom,
  isAlphabeticalSort,
  resetChatFiltersAtom,
  setChatFilterStatusAtom,
  sortFieldsFor,
  toggleChatFilterTagAtom,
} from './chatFilters';
import { useGetConversationTags } from '~/data-provider';
import { useHasAccess, useLocalize } from '~/hooks';
import { cn } from '~/utils';

const itemClassName =
  'flex w-full cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-2 text-sm text-text-primary outline-none data-[active-item]:bg-surface-hover md:py-1.5';

const groupLabelClassName = 'px-2 pb-1 pt-1.5 text-xs font-medium text-text-secondary';

/** Keeps every row's label on the same x, checked or not. */
const CheckSlot = ({ checked }: { checked: boolean }) =>
  checked ? (
    <Check className="ml-auto size-4 shrink-0 text-text-primary" aria-hidden="true" />
  ) : (
    <span className="ml-auto size-4 shrink-0" aria-hidden="true" />
  );

type ChoiceProps = {
  label: string;
  icon: ReactNode;
  checked: boolean;
  onSelect: () => void;
};

/** One exclusive choice. `hideOnClick` stays off: adjusting two facets in a row is
 *  the common case, and a menu that closes on the first click makes that four clicks. */
const Choice = ({ label, icon, checked, onSelect }: ChoiceProps) => (
  <Ariakit.MenuItem
    role="menuitemradio"
    aria-checked={checked}
    hideOnClick={false}
    onClick={onSelect}
    className={itemClassName}
  >
    <span className="shrink-0 text-text-secondary" aria-hidden="true">
      {icon}
    </span>
    <span className="truncate">{label}</span>
    <CheckSlot checked={checked} />
  </Ariakit.MenuItem>
);

const STATUS_OPTIONS: Array<{ value: ChatFilterStatus; label: TranslationKeys; icon: ReactNode }> =
  [
    {
      value: 'active',
      label: 'com_ui_active_chats',
      icon: <MessagesSquare className="size-4" />,
    },
    { value: 'archived', label: 'com_nav_archived_chats', icon: <Archive className="size-4" /> },
  ];

const SORT_OPTIONS: Record<ChatSortField, { label: TranslationKeys; icon: ReactNode }> = {
  updatedAt: { label: 'com_ui_sort_updated', icon: <Clock className="size-4" /> },
  createdAt: { label: 'com_ui_sort_created', icon: <CalendarPlus className="size-4" /> },
  title: { label: 'com_ui_sort_title', icon: <ArrowDownAZ className="size-4" /> },
  archivedAt: { label: 'com_nav_archive_created_at', icon: <Archive className="size-4" /> },
};

/** Bookmarks are their own query and their own permission, so they mount with the
 *  open menu rather than with the sidebar. */
const BookmarkChoices = memo(() => {
  const localize = useLocalize();
  const tags = useAtomValue(chatFilterTagsAtom);
  const toggleTag = useSetAtom(toggleChatFilterTagAtom);
  const { data } = useGetConversationTags();

  /** A bookmark no chat carries filters the list down to nothing. */
  const bookmarks = useMemo(() => data?.filter((tag) => tag.count > 0) ?? [], [data]);

  if (bookmarks.length === 0) {
    return (
      <Ariakit.MenuItem
        disabled={true}
        className={cn(itemClassName, 'cursor-default text-text-secondary')}
      >
        <span className="truncate text-xs">{localize('com_ui_no_bookmarks_title')}</span>
      </Ariakit.MenuItem>
    );
  }

  return (
    <>
      {bookmarks.map((bookmark) => {
        const checked = tags.includes(bookmark.tag);
        return (
          <Ariakit.MenuItem
            key={bookmark.tag}
            role="menuitemcheckbox"
            aria-checked={checked}
            hideOnClick={false}
            onClick={() => toggleTag(bookmark.tag)}
            className={itemClassName}
          >
            <span className="shrink-0 text-text-secondary" aria-hidden="true">
              {checked ? (
                <BookmarkFilledIcon className="size-4" />
              ) : (
                <BookmarkIcon className="size-4" />
              )}
            </span>
            <span className="truncate">{bookmark.tag}</span>
            <span className="ml-auto shrink-0 text-xs tabular-nums text-text-tertiary">
              {bookmark.count}
            </span>
          </Ariakit.MenuItem>
        );
      })}
    </>
  );
});

BookmarkChoices.displayName = 'BookmarkChoices';

/**
 * Every way the chats list can be narrowed or reordered, in one menu beside the
 * Chats heading: which chats (active or archived), what orders them, and which
 * bookmarks they must carry. It replaces the bookmark-only control that used to sit
 * next to the search field, so filtering lives where the list it filters is labelled.
 */
const ChatFilterMenu = () => {
  const localize = useLocalize();
  const menuId = useId();
  const zIndex = usePopoverZIndex();
  const [isOpen, setIsOpen] = useState(false);

  const status = useAtomValue(chatFilterStatusAtom);
  const sort = useAtomValue(chatSortAtom);
  const activeCount = useAtomValue(chatFilterCountAtom);
  const setStatus = useSetAtom(setChatFilterStatusAtom);
  const setSort = useSetAtom(chatSortAtom);
  const resetFilters = useSetAtom(resetChatFiltersAtom);

  const hasAccessToBookmarks = useHasAccess({
    permissionType: PermissionTypes.BOOKMARKS,
    permission: Permissions.USE,
  });

  const alphabetical = isAlphabeticalSort(sort.field);

  /** Ascending means A first for titles and oldest first for instants, so the same
   *  two values need two different pairs of labels. */
  const directionOptions = useMemo<Array<{ value: ChatSortDirection; label: string }>>(
    () =>
      alphabetical
        ? [
            { value: 'asc', label: localize('com_ui_sort_a_z') },
            { value: 'desc', label: localize('com_ui_sort_z_a') },
          ]
        : [
            { value: 'desc', label: localize('com_ui_sort_newest') },
            { value: 'asc', label: localize('com_ui_sort_oldest') },
          ],
    [alphabetical, localize],
  );

  const selectField = useCallback(
    (field: ChatSortField) => {
      /** Switching between an instant and a title keeps the direction's meaning rather
       *  than its value: newest-first reads as Z→A otherwise. */
      const keepsMeaning = isAlphabeticalSort(field) === isAlphabeticalSort(sort.field);
      const flipped = sort.direction === 'desc' ? 'asc' : 'desc';
      const direction = keepsMeaning ? sort.direction : flipped;
      setSort({ field, direction });
    },
    [setSort, sort.direction, sort.field],
  );

  const triggerLabel =
    activeCount > 0
      ? localize('com_ui_filters_active', { count: activeCount })
      : localize('com_ui_filter_and_sort_chats');

  return (
    <Ariakit.MenuProvider open={isOpen} setOpen={setIsOpen} placement="bottom-end" focusLoop={true}>
      <TooltipAnchor
        description={localize('com_ui_filter_and_sort_chats')}
        render={
          <Ariakit.MenuButton
            id="chat-filter-menu-button"
            aria-label={triggerLabel}
            aria-pressed={activeCount > 0}
            data-testid="chat-filter-menu"
            /** Matches the Projects heading's actions — it sits beside a section heading too. */
            className={cn(
              buttonVariants({ variant: 'section-action', size: 'icon-xs' }),
              'relative shrink-0',
              (isOpen || activeCount > 0) && 'bg-surface-active-alt text-text-primary',
            )}
          >
            <ListFilter aria-hidden="true" className="size-4" />
            {activeCount > 0 && (
              <span
                className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-text-primary"
                aria-hidden="true"
              />
            )}
          </Ariakit.MenuButton>
        }
      />
      <Ariakit.Menu
        id={menuId}
        portal={true}
        gutter={8}
        unmountOnHide={true}
        className="popover-ui min-w-56 max-w-72"
        /** Portaled beside modal dialog layers, which disable pointer events on body. */
        style={{ zIndex, pointerEvents: 'auto' }}
      >
        <Ariakit.MenuGroup>
          <Ariakit.MenuGroupLabel className={groupLabelClassName}>
            {localize('com_ui_show')}
          </Ariakit.MenuGroupLabel>
          {STATUS_OPTIONS.map((option) => (
            <Choice
              key={option.value}
              label={localize(option.label)}
              icon={option.icon}
              checked={status === option.value}
              onSelect={() => setStatus(option.value)}
            />
          ))}
        </Ariakit.MenuGroup>

        <Ariakit.MenuSeparator className="my-1 h-px border-border-medium" />

        <Ariakit.MenuGroup>
          <Ariakit.MenuGroupLabel className={groupLabelClassName}>
            {localize('com_ui_sort_chats_by')}
          </Ariakit.MenuGroupLabel>
          {sortFieldsFor(status).map((field) => (
            <Choice
              key={field}
              label={localize(SORT_OPTIONS[field].label)}
              icon={SORT_OPTIONS[field].icon}
              checked={sort.field === field}
              onSelect={() => selectField(field)}
            />
          ))}
        </Ariakit.MenuGroup>

        <Ariakit.MenuSeparator className="my-1 h-px border-border-medium" />

        <Ariakit.MenuGroup>
          <Ariakit.MenuGroupLabel className={groupLabelClassName}>
            {localize('com_ui_sort_order')}
          </Ariakit.MenuGroupLabel>
          {directionOptions.map((option) => (
            <Choice
              key={option.value}
              label={option.label}
              icon={
                <span className="flex size-4 items-center justify-center text-xs tabular-nums">
                  {option.value === 'asc' ? '↑' : '↓'}
                </span>
              }
              checked={sort.direction === option.value}
              onSelect={() => setSort({ field: sort.field, direction: option.value })}
            />
          ))}
        </Ariakit.MenuGroup>

        {hasAccessToBookmarks && (
          <>
            <Ariakit.MenuSeparator className="my-1 h-px border-border-medium" />
            <Ariakit.MenuGroup>
              <Ariakit.MenuGroupLabel className={groupLabelClassName}>
                {localize('com_ui_bookmarks')}
              </Ariakit.MenuGroupLabel>
              <BookmarkChoices />
            </Ariakit.MenuGroup>
          </>
        )}

        <Ariakit.MenuSeparator className="my-1 h-px border-border-medium" />
        <Ariakit.MenuItem
          hideOnClick={false}
          disabled={activeCount === 0}
          onClick={() => resetFilters()}
          className={cn(itemClassName, 'text-text-secondary aria-disabled:opacity-50')}
          data-testid="chat-filter-reset"
        >
          <RotateCcw className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{localize('com_ui_clear_filters')}</span>
        </Ariakit.MenuItem>
      </Ariakit.Menu>
    </Ariakit.MenuProvider>
  );
};

export default memo(ChatFilterMenu);
