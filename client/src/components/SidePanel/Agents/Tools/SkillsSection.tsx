import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Radio } from '@librechat/client';
import { ChevronRight, Plus, X } from 'lucide-react';
import { useFormContext, useWatch } from 'react-hook-form';
import { SkillsScope, resolveAgentSkillsScope } from 'librechat-data-provider';
import type { TSkillSummary } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { TranslationKeys } from '~/hooks/useLocalize';
import type { AgentItem } from './items/types';
import type { AgentForm } from '~/common';
import { useLocalize, useAuthContext, useSkillActiveState } from '~/hooks';
import { useSkillsInfiniteQuery } from '~/data-provider';
import { buildSkillItems } from './items/catalog';
import { getIconForItem } from './items/icons';
import { cn } from '~/utils';

interface Props {
  /** Selected skills, resolved to catalog items by the parent's shared lookup. */
  items: AgentItem[];
  onInfo: (item: AgentItem) => void;
  onRemove: (item: AgentItem) => void;
  onAdd: () => void;
}

/** Segment order is fixed: least to most exposure. */
const MODES = [SkillsScope.none, SkillsScope.all, SkillsScope.selected] as const;

const MODE_LABELS: Record<SkillsScope, TranslationKeys> = {
  [SkillsScope.none]: 'com_ui_skills_mode_off',
  [SkillsScope.all]: 'com_ui_skills_mode_all',
  [SkillsScope.selected]: 'com_ui_skills_mode_selected',
};

const ROW = 'flex items-center gap-2.5 px-3 py-2.5';
const CHIP = 'flex size-[26px] shrink-0 items-center justify-center rounded-md';

/**
 * Which count phrasing the header row uses.
 *
 * While pages remain the number describes what has been loaded, not a floor on
 * what is available. `hasNextPage` tracks raw pagination, and the rows are
 * filtered to the runtime-active ones, so the later pages may add nothing: 30
 * active skills followed only by deactivated ones would read as "30+
 * available" while 30 is the true total. Reporting the loaded count instead
 * cannot overstate the catalog.
 */
function availableCountKey(count: number, hasMore: boolean): TranslationKeys {
  if (hasMore) {
    return count === 1
      ? 'com_ui_skills_available_count_loaded_one'
      : 'com_ui_skills_available_count_loaded';
  }
  return count === 1 ? 'com_ui_skills_available_count_one' : 'com_ui_skills_available_count';
}

function SkillIcon({ item }: { item: AgentItem }) {
  const { Icon, colorClass } = getIconForItem(item);
  return (
    <span className={cn(CHIP, colorClass)} aria-hidden="true">
      <Icon className="size-3.5" />
    </span>
  );
}

/**
 * Height-morphing reveal. `Collapse` tweens `grid-template-rows` between `0fr`
 * and `1fr`, which animates opening and closing but snaps whenever the content
 * itself changes size — so swapping All for Selected jumped straight to the new
 * height. Measuring the content and driving an explicit height makes every
 * change a single tween, including a mode swap and the available-skills expand.
 */
function MorphHeight({ open, children }: { open: boolean; children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  /** Held off for one frame so a section that mounts already open lands at its
   *  height instead of animating up from zero. */
  const [animate, setAnimate] = useState(false);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (el == null) {
      return;
    }
    setHeight(el.offsetHeight);
    const frame = requestAnimationFrame(() => setAnimate(true));
    if (typeof ResizeObserver === 'undefined') {
      return () => cancelAnimationFrame(frame);
    }
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      aria-hidden={!open || undefined}
      inert={!open ? '' : undefined}
      style={{ height: open ? height : 0 }}
      className={cn(
        'overflow-hidden',
        animate &&
          'transition-[height] [transition-duration:var(--resize-dur)] [transition-timing-function:var(--resize-ease)] motion-reduce:transition-none',
      )}
    >
      {/** Spacing lives inside the measured box so it collapses away with it. */}
      <div ref={contentRef} className="pt-2">
        {children}
      </div>
    </div>
  );
}

export default function SkillsSection({ items, onInfo, onRemove, onAdd }: Props) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  /** The count is only as trustworthy as the per-user overrides behind it:
   *  until they resolve the hook reports every skill active, which would list
   *  a deliberately deactivated owned or deployment skill as available. */
  const {
    isActive,
    isLoading: statesLoading,
    isError: statesError,
    refetch: refetchStates,
  } = useSkillActiveState();
  const { setValue, control } = useFormContext<AgentForm>();
  const [allExpanded, setAllExpanded] = useState(false);

  const skillsValue = useWatch({ control, name: 'skills' });
  const skillsEnabledValue = useWatch({ control, name: 'skills_enabled' });
  const skillsScopeValue = useWatch({ control, name: 'skills_scope' });
  /** Legacy agents persist no explicit scope; the shared resolver maps their
   *  enabled + allowlist shape onto one of the three modes. */
  const mode = resolveAgentSkillsScope(skillsValue, skillsEnabledValue, skillsScopeValue);

  /** Which body the single collapse holds. It lags `none` on purpose: only one
   *  wrapper animates, so switching All <-> Selected swaps content at a fixed
   *  height with no vertical motion, while Off still tweens open and closed
   *  with the outgoing body still mounted to collapse against. */
  const [bodyMode, setBodyMode] = useState(mode === SkillsScope.none ? SkillsScope.selected : mode);
  if (mode !== SkillsScope.none && mode !== bodyMode) {
    setBodyMode(mode);
  }

  const authoringEnabledValue = useWatch({ control, name: 'skill_authoring_enabled' });

  /** Two shapes the section has to reconcile with what it displays. Neither
   *  dirties the form: they are normalizations the user did not ask for, and
   *  they must not light up Save on an untouched agent.
   *
   *  1. `skills_enabled` with no explicit scope, where the meaning depends on
   *     whether the allowlist is empty. Pin the resolved scope so the next
   *     save persists the new shape.
   *  2. Either capability flag left on under a resolved Off, which
   *     `skills_enabled: true` with `skills_scope: none` produces through the
   *     API. `skillDeps` exposes the skill-authoring tools for either flag, so
   *     that shape runs with skills the section reports as disabled, and
   *     clicking the already-selected Off segment cannot clear it. Off means
   *     no skills at all, which is what selecting Off already writes. */
  useEffect(() => {
    if (skillsEnabledValue === true && skillsScopeValue === undefined) {
      setValue('skills_scope', mode, { shouldDirty: false });
    }
    if (mode !== SkillsScope.none) {
      return;
    }
    if (skillsEnabledValue === true) {
      setValue('skills_enabled', false, { shouldDirty: false });
    }
    if (authoringEnabledValue === true) {
      setValue('skill_authoring_enabled', false, { shouldDirty: false });
    }
  }, [mode, skillsEnabledValue, skillsScopeValue, authoringEnabledValue, setValue]);

  /** Only `all` needs the deployment-wide catalog, for the count and the
   *  read-only list. Other modes never fetch it. Shares its cache with the
   *  picker, which uses the same query key. */
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isError, refetch } =
    useSkillsInfiniteQuery({ limit: 100 }, { enabled: mode === SkillsScope.all });

  /** The first page is enough for the collapsed header; the rest is only worth
   *  fetching once the list is open. The accessible catalog is unbounded and
   *  the endpoint caps a page at 100, so paging it eagerly would cost a serial
   *  request per 100 skills merely to view an All-scoped agent. */
  useEffect(() => {
    if (isError || mode !== SkillsScope.all || !allExpanded) {
      return;
    }
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [mode, allExpanded, hasNextPage, isFetchingNextPage, isError, fetchNextPage]);

  /** The list endpoint returns every skill the user can VIEW, but the runtime
   *  injects only the ones `resolveSkillActive` keeps: a per-user override in
   *  `skillStates`, else the owner/`defaultActiveOnShare` default. Counting the
   *  raw list would promise skills the agent will never receive, so this shares
   *  the same `isActive` predicate the chat-side picker filters on. */
  const availableSkills = useMemo(() => {
    const all: TSkillSummary[] = [];
    const seen = new Set<string>();
    for (const page of data?.pages ?? []) {
      for (const skill of page.skills) {
        if (seen.has(skill._id) || !isActive(skill)) {
          continue;
        }
        seen.add(skill._id);
        all.push(skill);
      }
    }
    return buildSkillItems(all, user?.id);
  }, [data?.pages, user?.id, isActive]);

  /** The mode is the single source of truth for catalog exposure, so each
   *  segment writes it outright. `skills` is deliberately left alone: `all` and
   *  `off` ignore the allowlist at runtime, which is what lets a return to
   *  `selected` restore the previous picks. */
  const handleModeChange = useCallback(
    (next: string) => {
      const scope = next as SkillsScope;
      /** Compared against the resolved mode, not the persisted scope: a
       *  disabled agent that kept `skills_scope: all` renders as Off, and
       *  matching on the raw field would swallow the click that re-enables it
       *  while `Radio` moved its own selection. */
      if (scope === mode) {
        return;
      }
      setValue('skills_enabled', scope !== SkillsScope.none, { shouldDirty: true });
      setValue('skills_scope', scope, { shouldDirty: true });
      /** Authoring is a separate capability, but `off` must mean no skills at
       *  all — leaving it set would still inject the skill-authoring tools. */
      if (scope === SkillsScope.none) {
        setValue('skill_authoring_enabled', false, { shouldDirty: true });
      }
    },
    [mode, setValue],
  );

  const modeOptions = useMemo(
    () => MODES.map((value) => ({ value, label: localize(MODE_LABELS[value]) })),
    [localize],
  );

  /** Both requests have to land before the catalog can be described: the
   *  skills themselves, and the overrides that decide which of them the
   *  runtime would actually inject. */
  const catalogError = isError || statesError === true;
  const catalogLoading = data == null || statesLoading === true;
  const count = availableSkills.length;
  const countLabel = catalogLoading
    ? localize('com_ui_loading')
    : localize(availableCountKey(count, hasNextPage === true), { count });

  const handleRetry = useCallback(() => {
    void refetch();
    void refetchStates?.();
  }, [refetch, refetchStates]);

  /** Once something is selected the list carries its own affordance in the
   *  header, so the dashed card is only the empty state. */
  const showAddInHeader = mode === SkillsScope.selected && items.length > 0;

  return (
    <div className="mb-3 flex w-full flex-col">
      <div className="flex items-center justify-between gap-3">
        <span
          id="skills-mode-label"
          className="block text-xs font-medium uppercase tracking-wide text-text-secondary"
        >
          {localize('com_ui_skills')}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {showAddInHeader && (
            <button
              type="button"
              onClick={onAdd}
              aria-label={localize('com_ui_skills_add_row')}
              className="flex size-7 items-center justify-center rounded-lg text-text-secondary transition hover:bg-surface-secondary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
            >
              <Plus className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          <Radio
            options={modeOptions}
            value={mode}
            onChange={handleModeChange}
            buttonClassName="!h-7 !px-2.5 !text-xs"
            aria-labelledby="skills-mode-label"
          />
        </div>
      </div>

      {/** One animator for the whole body: opening from Off, swapping All for
       *   Selected, and expanding the available list all tween the same
       *   measured height. */}
      <MorphHeight open={mode !== SkillsScope.none}>
        {bodyMode === SkillsScope.all && catalogError && (
          <>
            {/** A failed catalog request must not read as an empty catalog: the
             *  agent still uses every skill it can reach at runtime, so report
             *  the failure and offer a retry instead of a count derived from
             *  missing data. Mirrors the picker's alert. */}
            <div
              role="alert"
              className={cn(
                ROW,
                'justify-between rounded-lg border-[0.5px] border-border-light text-sm text-text-secondary',
              )}
            >
              <span className="truncate">{localize('com_ui_skills_load_error')}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleRetry}
                className="shrink-0"
              >
                {localize('com_ui_retry')}
              </Button>
            </div>
          </>
        )}
        {bodyMode === SkillsScope.all && !catalogError && (
          <div className="overflow-hidden rounded-lg border-[0.5px] border-border-light">
            <button
              type="button"
              onClick={() => setAllExpanded((prev) => !prev)}
              aria-expanded={allExpanded}
              aria-controls="skills-all-list"
              className={cn(
                ROW,
                'w-full text-left transition-colors hover:bg-surface-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring-primary',
              )}
            >
              <ChevronRight
                className={cn(
                  'size-4 shrink-0 text-text-secondary transition-transform',
                  allExpanded && 'rotate-90',
                )}
                aria-hidden="true"
              />
              <span className="truncate text-sm text-text-primary">{countLabel}</span>
            </button>
            {/** Mounted only while expanded: an always-present wrapper left the
             *   container's divider stacked on its bottom border. */}
            {allExpanded && (
              <ul
                id="skills-all-list"
                className="divide-y-[0.5px] divide-border-light border-t-[0.5px] border-border-light"
              >
                {availableSkills.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => onInfo(item)}
                      className={cn(
                        ROW,
                        // `transition-none` beats the global `all` transition, so
                        // the highlight lands on the frame the pointer enters.
                        'w-full text-left transition-none hover:bg-surface-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring-primary',
                      )}
                    >
                      <SkillIcon item={item} />
                      <span className="truncate text-sm text-text-secondary">{item.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {bodyMode !== SkillsScope.all && (
          <div className="flex flex-col gap-1.5">
            {/** Rows own their hover so the whole item highlights, not just the
             *   name. `has-[...]` drops it while the remove button is hovered,
             *   leaving only that button lit. */}
            {items.length > 0 && (
              <ul className="divide-y-[0.5px] divide-border-light overflow-hidden rounded-lg border-[0.5px] border-border-light">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center transition-colors hover:bg-surface-secondary has-[[data-skill-remove]:hover]:bg-transparent"
                  >
                    <button
                      type="button"
                      onClick={() => onInfo(item)}
                      className={cn(
                        ROW,
                        'min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring-primary',
                      )}
                    >
                      <SkillIcon item={item} />
                      <span className="truncate text-sm text-text-primary">{item.name}</span>
                    </button>
                    <button
                      type="button"
                      data-skill-remove=""
                      onClick={() => onRemove(item)}
                      aria-label={localize('com_ui_skills_remove', { name: item.name })}
                      className="mr-2 flex size-6 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-surface-tertiary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {/** Same dashed card `dev` and `main` use for "No skills yet". Only
             *   the empty state: once rows exist, Add lives in the header. */}
            {items.length === 0 && (
              <button
                type="button"
                onClick={onAdd}
                className="flex w-full flex-col items-center gap-1 rounded-xl border border-dashed border-border-light px-2 py-4 text-text-secondary transition-colors hover:border-border-medium hover:bg-surface-secondary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span className="text-xs">{localize('com_ui_skills_add_row')}</span>
                <span className="text-[11px] text-text-secondary">
                  {localize('com_ui_skills_empty_hint')}
                </span>
              </button>
            )}
          </div>
        )}
      </MorphHeight>
    </div>
  );
}
