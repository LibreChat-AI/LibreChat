import { useMemo, useState, useCallback, useEffect } from 'react';
import { Plus, Search } from 'lucide-react';
import { useFormContext, useWatch } from 'react-hook-form';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import {
  Radio,
  Input,
  Label,
  Button,
  OGDialog,
  OGDialogTitle,
  OGDialogContent,
  OGDialogDescription,
  useMediaQuery,
} from '@librechat/client';
import type { TSkill, TSkillSummary } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks/useLocalize';
import type { CategoryOption } from './CategoryFilter';
import type { AgentItem } from './items/types';
import type { AgentForm } from '~/common';
import { useLocalize, useHasAccess, useAuthContext, useToolFavorites } from '~/hooks';
import { CreateSkillDialog } from '~/components/Skills/dialogs';
import { useSkillsInfiniteQuery } from '~/data-provider';
import MarketplaceCatalog from './MarketplaceCatalog';
import { CategoryIcon } from '~/components/Prompts';
import { buildSkillItems } from './items/catalog';
import ItemDialog from './ItemDialog/ItemDialog';
import { applyFilter } from './items/filtering';
import CategoryFilter from './CategoryFilter';
import { itemKey } from './items/selectors';
import { cn } from '~/utils';

interface SkillsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
}

type SkillView = 'marketplace' | 'mine' | 'favorites';

const VIEWS: Array<{ value: SkillView; labelKey: TranslationKeys }> = [
  { value: 'marketplace', labelKey: 'com_ui_all_proper' },
  { value: 'mine', labelKey: 'com_ui_tools_view_made_by_you' },
  { value: 'favorites', labelKey: 'com_ui_tools_view_favorites' },
];

export default function SkillsDialog({ open, onOpenChange, agentId }: SkillsDialogProps) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { control, getValues, setValue } = useFormContext<AgentForm>();
  /** The header's two layouts read in different orders, so the breakpoint selects
   *  which DOM order renders; same query as the marketplace dialog's rail. */
  const isDesktop = useMediaQuery('(min-width: 768px)');

  const hasSkillsAccess = useHasAccess({
    permissionType: PermissionTypes.SKILLS,
    permission: Permissions.USE,
  });
  const hasCreateAccess = useHasAccess({
    permissionType: PermissionTypes.SKILLS,
    permission: Permissions.CREATE,
  });
  const {
    data: skillsData,
    isLoading: isLoadingSkills,
    isError: isSkillsError,
    fetchNextPage,
    refetch: refetchSkills,
    hasNextPage,
    isFetchingNextPage,
  } = useSkillsInfiniteQuery({ limit: 100 }, { enabled: hasSkillsAccess });
  const { favoriteKeys, toggle: toggleFavorite } = useToolFavorites();

  useEffect(() => {
    if (isSkillsError) {
      return;
    }
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, isSkillsError, fetchNextPage]);

  const handleRetrySkills = useCallback(() => {
    void refetchSkills();
  }, [refetchSkills]);

  const skillsField = useWatch({ control, name: 'skills' });
  const selectedIds = useMemo(
    () => new Set(((skillsField ?? []) as string[]).map((id) => itemKey({ kind: 'skill', id }))),
    [skillsField],
  );

  const [view, setView] = useState<SkillView>('marketplace');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | 'all'>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<AgentItem | null>(null);

  const skills = useMemo(() => {
    const allSkills: TSkillSummary[] = [];
    const seen = new Set<string>();
    for (const page of skillsData?.pages ?? []) {
      for (const skill of page.skills) {
        if (seen.has(skill._id)) {
          continue;
        }
        seen.add(skill._id);
        allSkills.push(skill);
      }
    }
    return allSkills;
  }, [skillsData?.pages]);

  const catalog = useMemo(() => buildSkillItems(skills, user?.id), [skills, user?.id]);

  const categoryOptions = useMemo<CategoryOption[]>(() => {
    const seen = new Set<string>();
    const options: CategoryOption[] = [];
    for (const item of catalog) {
      if (item.kind !== 'skill') {
        continue;
      }
      const value = item.skill.category;
      if (!value || seen.has(value)) {
        continue;
      }
      seen.add(value);
      options.push({
        value,
        label: value,
        icon: <CategoryIcon category={value} className="size-4" />,
      });
    }
    return options;
  }, [catalog]);

  const filtered = useMemo(
    () =>
      applyFilter(
        catalog,
        { search, kind: 'skill', category, view },
        { favoritedIds: favoriteKeys },
      ),
    [catalog, search, category, view, favoriteKeys],
  );

  /** Only the allowlist changes here: the section's mode control owns
   *  `skills_enabled` and `skills_scope`, and the picker is reachable only from
   *  `selected` mode. */
  const applySkillsSelection = useCallback(
    (next: string[]) => {
      setValue('skills', next, { shouldDirty: true });
    },
    [setValue],
  );

  const handleSkillCreated = useCallback(
    (skill: TSkill) => {
      const current = (getValues('skills') ?? []) as string[];
      applySkillsSelection(Array.from(new Set([...current, skill._id])));
      setView('mine');
    },
    [getValues, applySkillsSelection],
  );

  const handleToggle = useCallback(
    (item: AgentItem) => {
      const current = (getValues('skills') ?? []) as string[];
      if (selectedIds.has(itemKey(item))) {
        applySkillsSelection(current.filter((id) => id !== item.id));
        return;
      }
      applySkillsSelection(Array.from(new Set([...current, item.id])));
    },
    [getValues, applySkillsSelection, selectedIds],
  );

  const viewOptions = useMemo(
    () => VIEWS.map((option) => ({ value: option.value, label: localize(option.labelKey) })),
    [localize],
  );

  const emptyKey: TranslationKeys | undefined =
    !search.trim() && category === 'all' && view === 'marketplace'
      ? 'com_ui_no_skills_found'
      : undefined;

  /** The header is one row from md and two below it, and the two read in different
   *  orders, so the breakpoint picks the DOM order rather than `order-*` reshuffling
   *  one. Each control is built once and placed by whichever branch renders. */
  const viewRadio = (
    <Radio
      wrap
      options={viewOptions}
      value={view}
      onChange={(value) => {
        setView(value as SkillView);
        setCategory('all');
      }}
      className="p-1"
      aria-labelledby="skills-view-label"
    />
  );
  const createButton = hasCreateAccess ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => setCreateOpen(true)}
      aria-label={localize('com_ui_create_skill')}
      className={cn('h-[42px] w-[42px] shrink-0 p-0', !isDesktop && 'ml-auto')}
    >
      <Plus className="size-4" aria-hidden="true" />
    </Button>
  ) : null;
  const filterField = (
    <div
      className={cn('flex items-center gap-2', isDesktop ? 'min-w-0 grow basis-0' : 'basis-full')}
    >
      <div className="relative min-w-0 flex-1">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 z-[1] size-4 -translate-y-1/2 text-text-tertiary"
          aria-hidden="true"
        />
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={localize('com_ui_search_skills')}
          aria-label={localize('com_ui_search_skills')}
          className="h-[42px] bg-transparent pl-9"
        />
      </div>
      <CategoryFilter options={categoryOptions} value={category} onChange={setCategory} />
    </div>
  );

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent className="w-11/12 max-w-[900px] overflow-hidden rounded-2xl border-border-medium p-0 shadow-xl md:max-h-[92vh]">
        <OGDialogDescription className="sr-only">
          {localize('com_ui_skills_dialog_description')}
        </OGDialogDescription>
        <div className="flex h-[80dvh] max-h-[760px] flex-col">
          <div className="flex flex-col gap-3 border-b border-border-light px-4 pb-3 pt-4 md:px-6 md:pb-4 md:pt-5">
            <div className="flex items-center gap-2 pr-10">
              <OGDialogTitle className="text-base font-semibold text-text-primary">
                {localize('com_ui_skills')}
              </OGDialogTitle>
            </div>

            {/* DOM order is the order each breakpoint reads in, so tab order follows
                the eye: from md the row is create, field, radio, exactly as before;
                below md the radio and the create button take the first line and the
                field the second. `order-*` would have kept one subtree, but it left
                desktop tabbing from the rightmost radio back to the create button. */}
            <div className="flex flex-wrap items-center gap-2">
              <Label id="skills-view-label" className="sr-only">
                {localize('com_ui_skills_filter')}
              </Label>
              {isDesktop ? (
                <>
                  {createButton}
                  {filterField}
                  {viewRadio}
                </>
              ) : (
                <>
                  {viewRadio}
                  {createButton}
                  {filterField}
                </>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 md:px-6 md:py-4">
            {isSkillsError && (
              <div
                role="alert"
                className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-border-medium px-3 py-2 text-sm text-text-secondary"
              >
                <span>{localize('com_ui_skills_load_error')}</span>
                <Button type="button" variant="outline" onClick={handleRetrySkills}>
                  {localize('com_ui_retry')}
                </Button>
              </div>
            )}
            <MarketplaceCatalog
              items={filtered}
              selectedIds={selectedIds}
              onToggle={handleToggle}
              onConfigure={setDetailItem}
              view={view}
              isLoadingSkills={isLoadingSkills || isFetchingNextPage}
              skillsInView={view !== 'mine'}
              favoriteKeys={favoriteKeys}
              onToggleFavorite={toggleFavorite}
              emptyKey={emptyKey}
              ariaLabel={localize('com_ui_skills')}
            />
          </div>
        </div>
        <ItemDialog item={detailItem} agentId={agentId} onClose={() => setDetailItem(null)} />
        <CreateSkillDialog
          isOpen={createOpen}
          setIsOpen={setCreateOpen}
          onCreated={handleSkillCreated}
        />
      </OGDialogContent>
    </OGDialog>
  );
}
