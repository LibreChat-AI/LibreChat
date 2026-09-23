import { memo, useCallback, useId, useMemo, useRef, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { useAtomValue, useSetAtom } from 'jotai';
import { BookmarkFilledIcon, BookmarkIcon } from '@radix-ui/react-icons';
import { TooltipAnchor, buttonVariants, usePopoverZIndex } from '@librechat/client';
import { alternateName, PermissionTypes, Permissions } from 'librechat-data-provider';
import {
  Archive,
  ArrowDownAZ,
  ArrowUpDown,
  CalendarPlus,
  CalendarRange,
  Check,
  ChevronRight,
  Clock,
  ListFilter,
  MessagesSquare,
  Paperclip,
  Search,
  Share2,
  Plug,
  RotateCcw,
  SlidersHorizontal,
} from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import type { ChatFilterStatus, ChatSortDirection, ChatSortField } from './chatFilters';
import type { TranslationKeys } from '~/hooks';
import type { DateRange } from './facets';
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
import {
  createdRangeAtom,
  DATE_RANGE_OPTIONS,
  endpointFilterAtom,
  facetFilterCountAtom,
  hasAttachmentsAtom,
  resetFacetsAtom,
  sharedOnlyAtom,
  toggleEndpointFilterAtom,
  updatedRangeAtom,
} from './facets';
import { useGetConversationTags, useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import MinimalIcon from '~/components/Endpoints/MinimalIcon';
import { useHasAccess, useLocalize } from '~/hooks';
import { cn } from '~/utils';

const itemClassName =
  'flex w-full cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-2 text-sm text-text-primary outline-hidden data-[active-item]:bg-surface-hover md:py-1.5';

/** A property row: name on the left, its current value on the right, submenu behind it. */
const rowClassName = cn(itemClassName, 'aria-expanded:bg-surface-hover');

const groupLabelClassName = 'px-2 pb-1 pt-1.5 text-xs font-medium text-text-secondary';

/** Keeps every row's label on the same x, checked or not. */
const CheckSlot = ({ checked }: { checked: boolean }) =>
  checked ? (
    <Check className="text-text-primary ml-auto size-4 shrink-0" aria-hidden="true" />
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
    <span className="text-text-secondary shrink-0" aria-hidden="true">
      {icon}
    </span>
    <span className="truncate">{label}</span>
    <CheckSlot checked={checked} />
  </Ariakit.MenuItem>
);

type ToggleProps = {
  label: string;
  icon: ReactNode;
  checked: boolean;
  onSelect: () => void;
};

/** A facet that is simply on or off, so it needs no submenu of its own. */
const Toggle = ({ label, icon, checked, onSelect }: ToggleProps) => (
  <Ariakit.MenuItem
    role="menuitemcheckbox"
    aria-checked={checked}
    hideOnClick={false}
    onClick={onSelect}
    className={itemClassName}
  >
    <span className="text-text-secondary shrink-0" aria-hidden="true">
      {icon}
    </span>
    <span className="truncate">{label}</span>
    <CheckSlot checked={checked} />
  </Ariakit.MenuItem>
);

type PropertyRowProps = {
  icon: ReactNode;
  label: string;
  value: string;
  valueIcon?: ReactNode;
  testId?: string;
  initialFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
};

/**
 * One facet of the list, collapsed to a single row that reads as a sentence:
 * "Sort: Updated". The choices live in the submenu, so the menu opens showing
 * what the list is doing rather than every option it could take.
 */
const PropertyRow = ({
  icon,
  label,
  value,
  valueIcon,
  testId,
  initialFocus,
  children,
}: PropertyRowProps) => {
  const zIndex = usePopoverZIndex();

  return (
    <Ariakit.MenuProvider placement="right-start" focusLoop={true}>
      <Ariakit.MenuButton
        render={<Ariakit.MenuItem />}
        data-testid={testId}
        className={rowClassName}
      >
        <span className="text-text-secondary shrink-0" aria-hidden="true">
          {icon}
        </span>
        <span className="shrink-0">{label}</span>
        <span className="text-text-secondary ml-auto flex min-w-0 items-center gap-1.5 pl-4">
          {valueIcon}
          <span className="truncate">{value}</span>
          <ChevronRight className="text-text-tertiary size-4 shrink-0" aria-hidden="true" />
        </span>
      </Ariakit.MenuButton>
      <Ariakit.Menu
        portal={true}
        gutter={4}
        shift={-8}
        unmountOnHide={true}
        initialFocus={initialFocus}
        /** Portaled beside modal dialog layers, which disable pointer events on body. */
        className="popover-ui pointer-events-auto max-w-72 min-w-48"
        style={{ zIndex }}
      >
        {children}
      </Ariakit.Menu>
    </Ariakit.MenuProvider>
  );
};

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

const DirectionGlyph = ({ direction }: { direction: ChatSortDirection }) => (
  <span className="flex size-4 shrink-0 items-center justify-center text-xs" aria-hidden="true">
    {direction === 'asc' ? '↑' : '↓'}
  </span>
);

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
        className={cn(itemClassName, 'text-text-secondary cursor-default')}
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
            <span className="text-text-secondary shrink-0" aria-hidden="true">
              {checked ? (
                <BookmarkFilledIcon className="size-4" />
              ) : (
                <BookmarkIcon className="size-4" />
              )}
            </span>
            <span className="truncate">{bookmark.tag}</span>
            <span className="text-text-tertiary ml-auto shrink-0 text-xs tabular-nums">
              {bookmark.count}
            </span>
          </Ariakit.MenuItem>
        );
      })}
    </>
  );
});

BookmarkChoices.displayName = 'BookmarkChoices';

/** One selectable value inside a facet, as the cross-category search sees it. */
type FilterOption = {
  id: string;
  label: string;
  checked: boolean;
  /** Multi-select facets render as checkboxes; a date window is one of a set. */
  multiple: boolean;
  icon: ReactNode;
  onSelect: () => void;
};

type DateFacetProps = {
  label: string;
  icon: ReactNode;
  value: DateRange;
  onSelect: (value: DateRange) => void;
};

/** Updated and Created take the same windows, so they are one component twice. */
const DateFacet = ({ label, icon, value, onSelect }: DateFacetProps) => {
  const localize = useLocalize();
  const selected = DATE_RANGE_OPTIONS.find((option) => option.value === value);

  return (
    <PropertyRow icon={icon} label={label} value={localize(selected?.label ?? 'com_ui_any_time')}>
      <Ariakit.MenuGroup>
        <Ariakit.MenuGroupLabel className={groupLabelClassName}>{label}</Ariakit.MenuGroupLabel>
        {DATE_RANGE_OPTIONS.map((option) => (
          <Choice
            key={option.value}
            label={localize(option.label)}
            icon={<CalendarRange className="size-4" />}
            checked={value === option.value}
            onSelect={() => onSelect(option.value)}
          />
        ))}
      </Ariakit.MenuGroup>
    </PropertyRow>
  );
};

/** The endpoints this deployment actually serves, named the way the rest of the app
 *  names them. A chat matches if it used any of the chosen ones. */
const EndpointFacet = memo(() => {
  const localize = useLocalize();
  const selected = useAtomValue(endpointFilterAtom);
  const toggleEndpoint = useSetAtom(toggleEndpointFilterAtom);
  const { data: endpointsConfig } = useGetEndpointsQuery();

  const endpoints = useMemo(
    () =>
      Object.keys(endpointsConfig ?? {})
        .filter((endpoint) => endpointsConfig?.[endpoint] != null)
        .map((endpoint) => ({
          value: endpoint,
          label: (alternateName[endpoint] as string | undefined) ?? endpoint,
        })),
    [endpointsConfig],
  );

  const value = useMemo(() => {
    if (selected.length === 0) {
      return localize('com_ui_any');
    }
    if (selected.length === 1) {
      return (alternateName[selected[0]] as string | undefined) ?? selected[0];
    }
    return localize('com_ui_selected_count', { count: selected.length });
  }, [localize, selected]);

  return (
    <PropertyRow
      icon={<Plug className="size-4" />}
      label={localize('com_ui_endpoint')}
      value={value}
    >
      <Ariakit.MenuGroup>
        <Ariakit.MenuGroupLabel className={groupLabelClassName}>
          {localize('com_ui_endpoint')}
        </Ariakit.MenuGroupLabel>
        {endpoints.map((endpoint) => (
          <Toggle
            key={endpoint.value}
            label={endpoint.label}
            icon={
              <MinimalIcon
                size={16}
                model={null}
                isCreatedByUser={false}
                endpoint={endpoint.value}
                endpointsConfig={endpointsConfig}
                className="size-4"
              />
            }
            checked={selected.includes(endpoint.value)}
            onSelect={() => toggleEndpoint(endpoint.value)}
          />
        ))}
      </Ariakit.MenuGroup>
    </PropertyRow>
  );
});

EndpointFacet.displayName = 'EndpointFacet';

/**
 * A facet list long enough to scan is long enough to search. The field owns focus
 * when the submenu opens, so typing narrows immediately, and ArrowDown hands the
 * keyboard back to the rows rather than stranding it in the input.
 */
const FacetSearch = ({
  value,
  onChange,
  inputRef,
}: {
  value: string;
  onChange: (next: string) => void;
  inputRef?: RefObject<HTMLInputElement>;
}) => {
  const localize = useLocalize();
  const menu = Ariakit.useMenuContext();
  const inputId = useId();

  return (
    <div className="px-1 pt-0.5 pb-1.5">
      <label className="sr-only" htmlFor={inputId}>
        {localize('com_ui_search_filters')}
      </label>
      <div className="text-text-secondary focus-within:text-text-primary flex items-center gap-2 rounded-lg px-1">
        <Search className="size-4 shrink-0" aria-hidden="true" />
        <input
          id={inputId}
          ref={inputRef}
          type="text"
          value={value}
          autoComplete="off"
          placeholder={localize('com_ui_search_filters')}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown') {
              return;
            }
            event.preventDefault();
            menu?.move(menu.first());
          }}
          className="text-text-primary placeholder:text-text-tertiary w-full bg-transparent py-1 text-sm outline-hidden"
        />
      </div>
    </div>
  );
};

/**
 * Everything that narrows the list, one level in: bookmarks, the two date windows,
 * the endpoint a chat ran on, and the two flags. Keeping them here rather than at the
 * root is what lets the menu grow a facet without growing a screenful.
 */
const FilterFacets = ({
  showBookmarks,
  searchRef,
}: {
  showBookmarks: boolean;
  searchRef?: RefObject<HTMLInputElement>;
}) => {
  const localize = useLocalize();
  const [search, setSearch] = useState('');
  const updatedRange = useAtomValue(updatedRangeAtom);
  const createdRange = useAtomValue(createdRangeAtom);
  const hasAttachments = useAtomValue(hasAttachmentsAtom);
  const sharedOnly = useAtomValue(sharedOnlyAtom);
  const tags = useAtomValue(chatFilterTagsAtom);
  const facetCount = useAtomValue(facetFilterCountAtom);
  const selectedEndpoints = useAtomValue(endpointFilterAtom);
  const setUpdatedRange = useSetAtom(updatedRangeAtom);
  const setCreatedRange = useSetAtom(createdRangeAtom);
  const setHasAttachments = useSetAtom(hasAttachmentsAtom);
  const setSharedOnly = useSetAtom(sharedOnlyAtom);
  const setTags = useSetAtom(chatFilterTagsAtom);
  const toggleTag = useSetAtom(toggleChatFilterTagAtom);
  const toggleEndpoint = useSetAtom(toggleEndpointFilterAtom);
  const resetFacets = useSetAtom(resetFacetsAtom);

  /** Searching reaches into the categories, so both lists have to be here rather than
   *  inside the submenu that normally owns them. Both are cached queries. */
  const { data: bookmarkData } = useGetConversationTags();
  const { data: endpointsConfig } = useGetEndpointsQuery();
  /** A deployment with sharing switched off has no shared chats to filter to. */
  const { data: startupConfig } = useGetStartupConfig();
  const showShared = startupConfig?.sharedLinksEnabled === true;

  const query = search.trim().toLowerCase();

  /**
   * Every value a person can filter by, flattened. A query matches an option by its own
   * name or by the name of the category it belongs to, so "endpoint" offers every
   * endpoint and "anthropic" offers the one.
   */
  const results = useMemo(() => {
    if (query === '') {
      return [];
    }

    const groups: Array<{ category: string; options: FilterOption[] }> = [];
    const collect = (category: string, options: FilterOption[]) => {
      const categoryMatches = category.toLowerCase().includes(query);
      const matched = categoryMatches
        ? options
        : options.filter((option) => option.label.toLowerCase().includes(query));
      if (matched.length > 0) {
        groups.push({ category, options: matched });
      }
    };

    if (showBookmarks) {
      collect(
        localize('com_ui_bookmarks'),
        (bookmarkData ?? [])
          .filter((bookmark) => bookmark.count > 0)
          .map((bookmark) => ({
            id: `bookmark:${bookmark.tag}`,
            label: bookmark.tag,
            checked: tags.includes(bookmark.tag),
            multiple: true,
            icon: tags.includes(bookmark.tag) ? <BookmarkFilledIcon /> : <BookmarkIcon />,
            onSelect: () => toggleTag(bookmark.tag),
          })),
      );
    }

    const dateOptions = (value: DateRange, onSelect: (next: DateRange) => void) =>
      DATE_RANGE_OPTIONS.map((option) => ({
        id: `${option.value}`,
        label: localize(option.label),
        checked: value === option.value,
        multiple: false,
        icon: <CalendarRange />,
        onSelect: () => onSelect(option.value),
      }));

    collect(
      localize('com_ui_sort_updated'),
      dateOptions(updatedRange, setUpdatedRange).map((option) => ({
        ...option,
        id: `updated:${option.id}`,
      })),
    );
    collect(
      localize('com_ui_sort_created'),
      dateOptions(createdRange, setCreatedRange).map((option) => ({
        ...option,
        id: `created:${option.id}`,
      })),
    );

    collect(
      localize('com_ui_endpoint'),
      Object.keys(endpointsConfig ?? {})
        .filter((endpoint) => endpointsConfig?.[endpoint] != null)
        .map((endpoint) => ({
          id: `endpoint:${endpoint}`,
          label: (alternateName[endpoint] as string | undefined) ?? endpoint,
          checked: selectedEndpoints.includes(endpoint),
          multiple: true,
          icon: (
            <MinimalIcon
              size={16}
              model={null}
              isCreatedByUser={false}
              endpoint={endpoint}
              endpointsConfig={endpointsConfig}
              className="size-4"
            />
          ),
          onSelect: () => toggleEndpoint(endpoint),
        })),
    );

    /** A flag is its own category and its own single option. */
    collect(localize('com_ui_attachments'), [
      {
        id: 'has-attachments',
        label: localize('com_ui_has_attachments'),
        checked: hasAttachments,
        multiple: true,
        icon: <Paperclip />,
        onSelect: () => setHasAttachments(!hasAttachments),
      },
    ]);

    if (showShared) {
      collect(localize('com_ui_sharing'), [
        {
          id: 'shared-only',
          label: localize('com_ui_shared_only'),
          checked: sharedOnly,
          multiple: true,
          icon: <Share2 />,
          onSelect: () => setSharedOnly(!sharedOnly),
        },
      ]);
    }

    return groups;
  }, [
    query,
    showBookmarks,
    localize,
    bookmarkData,
    tags,
    toggleTag,
    updatedRange,
    setUpdatedRange,
    createdRange,
    setCreatedRange,
    endpointsConfig,
    selectedEndpoints,
    toggleEndpoint,
    hasAttachments,
    setHasAttachments,
    showShared,
    sharedOnly,
    setSharedOnly,
  ]);

  const facets = [
    showBookmarks ? <BookmarkFacet key="bookmarks" /> : null,
    <DateFacet
      key="updated"
      label={localize('com_ui_sort_updated')}
      icon={<Clock className="size-4" />}
      value={updatedRange}
      onSelect={setUpdatedRange}
    />,
    <DateFacet
      key="created"
      label={localize('com_ui_sort_created')}
      icon={<CalendarPlus className="size-4" />}
      value={createdRange}
      onSelect={setCreatedRange}
    />,
    <EndpointFacet key="endpoint" />,
  ].filter(Boolean);

  const flags = [
    <Toggle
      key="attachments"
      label={localize('com_ui_has_attachments')}
      icon={<Paperclip className="size-4" />}
      checked={hasAttachments}
      onSelect={() => setHasAttachments(!hasAttachments)}
    />,
    showShared ? (
      <Toggle
        key="shared"
        label={localize('com_ui_shared_only')}
        icon={<Share2 className="size-4" />}
        checked={sharedOnly}
        onSelect={() => setSharedOnly(!sharedOnly)}
      />
    ) : null,
  ].filter(Boolean);

  /** The reset belongs to what this submenu owns: the facets and the bookmarks,
   *  not the sort and the view sitting a level up. */
  const narrowingCount = facetCount + (tags.length > 0 ? 1 : 0);
  const clearFilters = () => {
    resetFacets();
    setTags([]);
  };

  return (
    <>
      <FacetSearch value={search} onChange={setSearch} inputRef={searchRef} />

      {query === '' ? (
        <>
          {facets}
          <Ariakit.MenuSeparator className="border-border-medium my-1 h-px" />
          {flags}
        </>
      ) : (
        <>
          {results.map((group) => (
            <Ariakit.MenuGroup key={group.category}>
              <Ariakit.MenuGroupLabel className={groupLabelClassName}>
                {group.category}
              </Ariakit.MenuGroupLabel>
              {group.options.map((option) =>
                option.multiple ? (
                  <Toggle
                    key={option.id}
                    label={option.label}
                    icon={option.icon}
                    checked={option.checked}
                    onSelect={option.onSelect}
                  />
                ) : (
                  <Choice
                    key={option.id}
                    label={option.label}
                    icon={option.icon}
                    checked={option.checked}
                    onSelect={option.onSelect}
                  />
                ),
              )}
            </Ariakit.MenuGroup>
          ))}
          {results.length === 0 && (
            <Ariakit.MenuItem
              disabled={true}
              className={cn(itemClassName, 'text-text-secondary cursor-default')}
            >
              <span className="truncate text-xs">{localize('com_ui_no_results_found')}</span>
            </Ariakit.MenuItem>
          )}
        </>
      )}

      <Ariakit.MenuSeparator className="border-border-medium my-1 h-px" />
      <Ariakit.MenuItem
        hideOnClick={false}
        disabled={narrowingCount === 0}
        onClick={clearFilters}
        className={cn(itemClassName, 'text-text-secondary aria-disabled:opacity-50')}
        data-testid="chat-filter-reset"
      >
        <RotateCcw className="size-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{localize('com_ui_clear_filters')}</span>
      </Ariakit.MenuItem>
    </>
  );
};

/** Bookmarks keep their own row so the count of chosen tags stays visible one level up. */
const BookmarkFacet = () => {
  const localize = useLocalize();
  const tags = useAtomValue(chatFilterTagsAtom);

  /** One bookmark names itself; several are worth a count, none reads as "None". */
  const value = useMemo(() => {
    if (tags.length === 0) {
      return localize('com_ui_none');
    }
    if (tags.length === 1) {
      return tags[0];
    }
    return localize('com_ui_selected_count', { count: tags.length });
  }, [localize, tags]);

  return (
    <PropertyRow
      icon={<BookmarkIcon className="size-4" />}
      label={localize('com_ui_bookmarks')}
      value={value}
      testId="chat-filter-bookmarks"
    >
      <Ariakit.MenuGroup>
        <Ariakit.MenuGroupLabel className={groupLabelClassName}>
          {localize('com_ui_bookmarks')}
        </Ariakit.MenuGroupLabel>
        <BookmarkChoices />
      </Ariakit.MenuGroup>
    </PropertyRow>
  );
};

/**
 * Every way the chats list can be narrowed or reordered, in one menu beside the
 * Chats heading: which chats (active or archived), what orders them, and what they
 * must match. Each facet is a row carrying its current value, so the menu is read at
 * a glance and only the facet being changed expands.
 */
const ChatFilterMenu = () => {
  const localize = useLocalize();
  const menuId = useId();
  const zIndex = usePopoverZIndex();
  const facetSearchRef = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  const status = useAtomValue(chatFilterStatusAtom);
  const sort = useAtomValue(chatSortAtom);
  const tags = useAtomValue(chatFilterTagsAtom);
  const activeCount = useAtomValue(chatFilterCountAtom);
  const facetCount = useAtomValue(facetFilterCountAtom);
  const setStatus = useSetAtom(setChatFilterStatusAtom);
  const setSort = useSetAtom(chatSortAtom);
  const resetFilters = useSetAtom(resetChatFiltersAtom);
  const resetAllFacets = useSetAtom(resetFacetsAtom);

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

  const statusOption = STATUS_OPTIONS.find((option) => option.value === status);

  /** Bookmarks sit inside Filter now, so the row counts them alongside the rest. */
  const narrowingCount = facetCount + (tags.length > 0 ? 1 : 0);
  const filterValue =
    narrowingCount === 0
      ? localize('com_ui_none')
      : localize('com_ui_active_count', { count: narrowingCount });

  const totalCount = activeCount + facetCount;

  /** The header's Reset undoes the whole menu, sort and view included; the one inside
   *  Filter clears only what that submenu owns. */
  const resetAll = useCallback(() => {
    resetFilters();
    resetAllFacets();
  }, [resetAllFacets, resetFilters]);

  const triggerLabel =
    totalCount > 0
      ? localize('com_ui_filters_active', { count: totalCount })
      : localize('com_ui_filter_and_sort_chats');

  return (
    <Ariakit.MenuProvider open={isOpen} setOpen={setIsOpen} placement="bottom-end" focusLoop={true}>
      <TooltipAnchor
        description={localize('com_ui_filter_and_sort_chats')}
        render={
          <Ariakit.MenuButton
            id="chat-filter-menu-button"
            aria-label={triggerLabel}
            aria-pressed={totalCount > 0}
            data-testid="chat-filter-menu"
            /** Matches the Projects heading's actions — it sits beside a section heading too. */
            className={cn(
              buttonVariants({ variant: 'section-action', size: 'icon-xs' }),
              'relative shrink-0',
              (isOpen || totalCount > 0) && 'bg-surface-active-alt text-text-primary',
            )}
          >
            <ListFilter aria-hidden="true" className="size-4" />
            {totalCount > 0 && (
              <span
                className="bg-text-primary absolute top-0.5 right-0.5 size-1.5 rounded-full"
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
        aria-label={localize('com_ui_filter_and_sort_chats')}
        className="popover-ui max-w-80 min-w-60"
        /** Portaled beside modal dialog layers, which disable pointer events on body. */
        style={{ zIndex, pointerEvents: 'auto' }}
      >
        <div className="flex items-center justify-between gap-2 px-2 pt-0.5 pb-1.5">
          <span className="text-text-secondary text-xs font-medium">
            {localize('com_ui_chat_list')}
          </span>
          <Ariakit.MenuItem
            hideOnClick={false}
            disabled={totalCount === 0}
            onClick={resetAll}
            data-testid="chat-filter-reset-all"
            className={cn(
              /** The size and radius of the chip the empty state offers, so the two
               *  ways out of a filter are the same control in two places. It stays a
               *  MenuItem: a button here would leave the menu's arrow keys behind. */
              buttonVariants({ variant: 'ghost', size: 'xs' }),
              'text-text-secondary cursor-pointer font-medium outline-hidden',
              'aria-disabled:hover:text-text-secondary aria-disabled:opacity-50',
              'data-[active-item]:bg-surface-hover data-[active-item]:text-text-primary',
            )}
          >
            {localize('com_ui_reset')}
          </Ariakit.MenuItem>
        </div>

        <PropertyRow
          icon={<MessagesSquare className="size-4" />}
          label={localize('com_ui_show')}
          value={statusOption ? localize(statusOption.label) : ''}
          testId="chat-filter-show"
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
        </PropertyRow>

        <PropertyRow
          icon={<ArrowUpDown className="size-4" />}
          label={localize('com_ui_sort')}
          value={localize(SORT_OPTIONS[sort.field].label)}
          valueIcon={<DirectionGlyph direction={sort.direction} />}
          testId="chat-filter-sort"
        >
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

          <Ariakit.MenuSeparator className="border-border-medium my-1 h-px" />

          <Ariakit.MenuGroup>
            <Ariakit.MenuGroupLabel className={groupLabelClassName}>
              {localize('com_ui_sort_order')}
            </Ariakit.MenuGroupLabel>
            {directionOptions.map((option) => (
              <Choice
                key={option.value}
                label={option.label}
                icon={<DirectionGlyph direction={option.value} />}
                checked={sort.direction === option.value}
                onSelect={() => setSort({ field: sort.field, direction: option.value })}
              />
            ))}
          </Ariakit.MenuGroup>
        </PropertyRow>

        <PropertyRow
          icon={<SlidersHorizontal className="size-4" />}
          label={localize('com_ui_filter')}
          value={filterValue}
          testId="chat-filter-facets"
          initialFocus={facetSearchRef}
        >
          <FilterFacets showBookmarks={hasAccessToBookmarks} searchRef={facetSearchRef} />
        </PropertyRow>
      </Ariakit.Menu>
    </Ariakit.MenuProvider>
  );
};

export default memo(ChatFilterMenu);
