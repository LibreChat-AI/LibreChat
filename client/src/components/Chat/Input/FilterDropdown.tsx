import React, { useState, useMemo, useCallback } from 'react';
import * as Ariakit from '@ariakit/react';
import { useRecoilState } from 'recoil';
import { ko, enUS } from 'date-fns/locale';
import { format, parseISO } from 'date-fns';
import { DayPicker } from 'react-day-picker';
import { Briefcase, Check, FileText, Filter, X } from 'lucide-react';
import { TooltipAnchor } from '@librechat/client';
import type {
  ExtensionGroup,
  LibraryFilter,
  PeriodFilterPreset,
  PeriodFilterState,
} from '~/store/filters';
import { DEFAULT_PERIOD_FILTER } from '~/store/filters';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import { displayNameOf } from '~/utils/displayName';
import store from '~/store';
import type { BklDocSelection, BklMatterSelection } from '~/store/bkl';
import {
  filterMatters as fuzzyFilterMatters,
  useBklDocsQuery,
  useBklMattersQuery,
} from '~/data-provider/Matters/queries';
import type { BklDoc, BklMatter } from '~/data-provider/Matters/queries';

interface FilterDropdownProps {
  disabled?: boolean;
}

type DateField = 'start' | 'end';
type FilterTab = 'period' | 'extension' | 'matter' | 'document';

interface QuickOption {
  preset: Exclude<PeriodFilterPreset, 'custom'>;
  labelKey: string;
}

const QUICK_OPTIONS: QuickOption[] = [
  { preset: 'all', labelKey: 'com_ui_period_all' },
  { preset: 'last_3_months', labelKey: 'com_ui_period_last_3_months' },
  { preset: 'last_6_months', labelKey: 'com_ui_period_last_6_months' },
  { preset: 'last_1_year', labelKey: 'com_ui_period_last_1_year' },
  { preset: 'last_3_years', labelKey: 'com_ui_period_last_3_years' },
  { preset: 'last_5_years', labelKey: 'com_ui_period_last_5_years' },
];

// 문서 검색 FilterBar 와 동일한 6-chip 옵션. 백엔드에서 group → 실제 확장자로 전개.
const EXTENSION_OPTIONS: { id: ExtensionGroup; label: string; hint: string }[] = [
  { id: 'pdf', label: 'PDF', hint: 'pdf' },
  { id: 'msg', label: 'MSG', hint: 'msg' },
  { id: 'docx', label: 'DOCX', hint: 'doc/docx' },
  { id: 'hwpx', label: 'HWPX', hint: 'hwp/hwpx' },
  { id: 'pptx', label: 'PPTX', hint: 'ppt/pptx' },
  { id: 'other', label: '기타', hint: 'other' },
];

// iManage 라이브러리 선택 — matter: M 라이브러리(사건 문서), knowledge: DB 라이브러리(지식 DB)
const LIBRARY_OPTIONS: { id: LibraryFilter; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'matter', label: 'M 라이브러리' },
  { id: 'knowledge', label: 'DB 라이브러리' },
];

const DATE_FMT = 'yyyy-MM-dd';

/** 아래로 펼치기 위해 필요한 최소 높이(px). 이보다 좁으면 위로 연다. */
const MIN_DROPDOWN_SPACE = 340;

const parseDate = (value: string | null): Date | undefined => {
  if (!value) return undefined;
  try {
    return parseISO(value);
  } catch {
    return undefined;
  }
};

const isActiveFilter = (state: PeriodFilterState): boolean =>
  state.preset !== DEFAULT_PERIOD_FILTER.preset ||
  state.startDate !== null ||
  state.endDate !== null ||
  (state.extensionGroups && state.extensionGroups.length > 0) ||
  (state.library ?? 'all') !== 'all';

const stopMenuInputEvent = (event: React.SyntheticEvent<HTMLInputElement>) => {
  event.stopPropagation();
};

interface DateTriggerProps {
  label: string;
  value: string | null;
  placeholderKey: string;
  isOpen: boolean;
  onToggle: () => void;
}

const DateTrigger = React.forwardRef<HTMLButtonElement, DateTriggerProps>(
  ({ label, value, placeholderKey, isOpen, onToggle }, ref) => {
    const localize = useLocalize();
    return (
      <button
        ref={ref}
        type="button"
        onClick={onToggle}
        className={cn(
          'flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md border border-border-light bg-surface-primary px-2.5 py-1.5 text-left transition-colors',
          'hover:border-border-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50',
          isOpen && 'border-blue-500',
        )}
      >
        <span className="text-[10px] font-medium uppercase tracking-wide text-text-secondary">
          {label}
        </span>
        <span className="w-full truncate whitespace-nowrap text-sm tabular-nums text-text-primary">
          {value ?? (
            <span className="text-text-secondary">
              {localize(placeholderKey as Parameters<typeof localize>[0])}
            </span>
          )}
        </span>
      </button>
    );
  },
);
DateTrigger.displayName = 'DateTrigger';

const FilterDropdown = ({ disabled }: FilterDropdownProps) => {
  const localize = useLocalize();
  const isDisabled = disabled ?? false;
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<FilterTab>('period');
  const [activeField, setActiveField] = useState<DateField | null>(null);
  const [periodFilter, setPeriodFilter] = useRecoilState(store.periodFilter);
  const [filterMatters, setFilterMatters] = useRecoilState(store.filterBklMatters);
  const [filterDocs, setFilterDocs] = useRecoilState(store.filterBklDocs);
  const [matterSearch, setMatterSearch] = useState('');
  const [docSearch, setDocSearch] = useState('');
  const { data: mattersData } = useBklMattersQuery(isOpen && activeTab === 'matter');
  const { data: docsData, isFetching: isDocsFetching } = useBklDocsQuery(
    docSearch,
    isOpen && activeTab === 'document',
  );

  // 기본은 버튼 아래로 펼친다. 채팅 화면처럼 버튼이 뷰포트 하단에 붙어
  // 아래 공간이 부족할 때만 위로 연다 (열기 직전 pointerdown 시점에 계산).
  const [placement, setPlacement] = useState<'bottom-start' | 'top-start'>('bottom-start');
  const menu = Ariakit.useMenuStore({ open: isOpen, setOpen: setIsOpen, placement });

  // 패널 밖(채팅 입력창 포함) 어디를 눌러도 닫히도록 capture 단계에서 감지.
  // Ariakit 자체 outside-click 은 중간에서 stopPropagation 하는 요소(채팅
  // 입력 영역 등)에 막힐 수 있어, 채팅창을 클릭해도 안 닫히는 문제가 있었다.
  React.useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      const { popoverElement, disclosureElement } = menu.getState();
      if (popoverElement?.contains(target) || disclosureElement?.contains(target)) {
        return;
      }
      setIsOpen(false);
    };
    // 키보드 포커스가 채팅 입력창으로 이동해도 닫는다.
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      const { popoverElement, disclosureElement } = menu.getState();
      if (popoverElement?.contains(target) || disclosureElement?.contains(target)) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
    };
  }, [isOpen, menu]);

  const handleSelectPreset = useCallback(
    (preset: Exclude<PeriodFilterPreset, 'custom'>) => {
      setPeriodFilter((prev) => ({
        ...prev,
        preset,
        startDate: null,
        endDate: null,
      }));
      setActiveField(null);
    },
    [setPeriodFilter],
  );

  const handleSelectDate = useCallback(
    (field: DateField, day: Date | undefined) => {
      const value = day ? format(day, DATE_FMT) : null;
      setPeriodFilter((prev) => {
        if (field === 'start') {
          const nextEnd =
            value && prev.endDate && new Date(value) > new Date(prev.endDate)
              ? null
              : prev.endDate;
          return { ...prev, preset: 'custom', startDate: value, endDate: nextEnd };
        }
        const nextStart =
          value && prev.startDate && new Date(value) < new Date(prev.startDate)
            ? null
            : prev.startDate;
        return { ...prev, preset: 'custom', startDate: nextStart, endDate: value };
      });
      setActiveField(null);
    },
    [setPeriodFilter],
  );

  const handleSelectLibrary = useCallback(
    (id: LibraryFilter) => {
      setPeriodFilter((prev) => ({ ...prev, library: id }));
    },
    [setPeriodFilter],
  );

  const toggleExt = useCallback(
    (id: ExtensionGroup) => {
      setPeriodFilter((prev) => {
        const set = new Set(prev.extensionGroups ?? []);
        if (set.has(id)) set.delete(id);
        else set.add(id);
        return { ...prev, extensionGroups: Array.from(set) };
      });
    },
    [setPeriodFilter],
  );

  const handleClear = useCallback(() => {
    setPeriodFilter(DEFAULT_PERIOD_FILTER);
    setFilterMatters([]);
    setFilterDocs([]);
    setMatterSearch('');
    setDocSearch('');
    setActiveField(null);
  }, [setFilterDocs, setFilterMatters, setPeriodFilter]);

  const toggleField = useCallback(
    (field: DateField) => setActiveField((prev) => (prev === field ? null : field)),
    [],
  );

  const isActive = useMemo(
    () => isActiveFilter(periodFilter) || filterMatters.length > 0 || filterDocs.length > 0,
    [filterDocs.length, filterMatters.length, periodFilter],
  );

  const dpLocale = useMemo(() => {
    if (typeof navigator !== 'undefined') {
      const stored = localStorage.getItem('lang') ?? '';
      if (stored.includes('ko') || navigator.language.startsWith('ko')) {
        return ko;
      }
    }
    return enUS;
  }, []);

  const startDate = useMemo(() => parseDate(periodFilter.startDate), [periodFilter.startDate]);
  const endDate = useMemo(() => parseDate(periodFilter.endDate), [periodFilter.endDate]);

  const activeSelected = activeField === 'start' ? startDate : endDate;
  const activeDefaultMonth = activeSelected ?? startDate ?? endDate ?? new Date();

  const activeDisabled = useMemo(() => {
    if (activeField === 'start' && endDate) {
      return { after: endDate };
    }
    if (activeField === 'end' && startDate) {
      return { before: startDate };
    }
    return undefined;
  }, [activeField, startDate, endDate]);

  const selectedExts = periodFilter.extensionGroups ?? [];
  const isPeriodActive =
    periodFilter.preset !== DEFAULT_PERIOD_FILTER.preset ||
    periodFilter.startDate !== null ||
    periodFilter.endDate !== null;
  const tabs: { id: FilterTab; label: string; count?: number; active: boolean }[] = [
    { id: 'period', label: '기간', active: isPeriodActive },
    {
      id: 'extension',
      label: localize('com_document_search_filter_extension'),
      count: selectedExts.length,
      active: selectedExts.length > 0,
    },
    { id: 'matter', label: '사건', count: filterMatters.length, active: filterMatters.length > 0 },
    { id: 'document', label: '문서', count: filterDocs.length, active: filterDocs.length > 0 },
  ];
  const handleSelectTab = useCallback((tab: FilterTab) => {
    setActiveTab(tab);
    setActiveField(null);
  }, []);
  const matterCandidates: BklMatter[] = useMemo(() => {
    if (!mattersData || !matterSearch.trim()) return [];
    const exclude = new Set(filterMatters.map((m) => m.matter_uid));
    return fuzzyFilterMatters(mattersData.matters, matterSearch, 8).filter(
      (m) => !exclude.has(m.matter_uid),
    );
  }, [filterMatters, matterSearch, mattersData]);
  const docCandidates: BklDoc[] = useMemo(() => {
    if (!docsData || !docSearch.trim()) return [];
    const exclude = new Set(filterDocs.map((d) => d.doc_id));
    return docsData.docs.filter((d) => !exclude.has(d.doc_id)).slice(0, 8);
  }, [docSearch, docsData, filterDocs]);

  const addMatter = useCallback(
    (m: BklMatter) => {
      const item: BklMatterSelection = {
        matter_uid: m.matter_uid,
        label: m.case_number || m.matter_uid,
        sub: m.client || m.case_alias || undefined,
      };
      setFilterMatters((prev) =>
        prev.some((p) => p.matter_uid === item.matter_uid) ? prev : [...prev, item],
      );
      setMatterSearch('');
    },
    [setFilterMatters],
  );
  const addDoc = useCallback(
    (doc: BklDoc) => {
      const item: BklDocSelection = {
        doc_id: doc.doc_id,
        // 표시용 라벨 — OCR 파생 .md 제거 (doc_id 는 원본 유지)
        label: displayNameOf(doc) || doc.imanage_doc_id || doc.doc_id,
      };
      setFilterDocs((prev) =>
        prev.some((p) => p.doc_id === item.doc_id) || prev.length >= 5 ? prev : [...prev, item],
      );
      setDocSearch('');
    },
    [setFilterDocs],
  );

  return (
    <Ariakit.MenuProvider store={menu}>
      <TooltipAnchor
        render={
          <Ariakit.MenuButton
            disabled={isDisabled}
            id="filter-dropdown-button"
            aria-label="Filters"
            onPointerDown={(event: React.PointerEvent<HTMLButtonElement>) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const spaceBelow = window.innerHeight - rect.bottom;
              setPlacement(spaceBelow >= MIN_DROPDOWN_SPACE ? 'bottom-start' : 'top-start');
            }}
            className={cn(
              'flex size-9 items-center justify-center rounded-full p-1 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-opacity-50',
              (isOpen || isActive) && 'bg-surface-hover',
            )}
          >
            <div className="flex w-full items-center justify-center gap-2">
              <Filter
                className={cn('size-5', isActive && 'text-blue-500')}
                aria-hidden="true"
              />
            </div>
          </Ariakit.MenuButton>
        }
        id="filter-dropdown-button"
        description={localize('com_ui_filters')}
        disabled={isDisabled}
      />
      <Ariakit.Menu
        portal
        unmountOnHide
        gutter={4}
        composite={false}
        /* placement 는 열기 직전에 직접 계산하므로 자동 flip 은 끈다.
           가용 높이를 넘으면 패널 자체가 스크롤된다. */
        flip={false}
        hideOnHoverOutside={false}
        className="popover-ui z-50 w-[320px] !overflow-y-auto !p-2"
        style={{ maxHeight: 'min(560px, var(--popover-available-height, 560px))' }}
      >
        {/* 헤더 — 제목 + 닫기 버튼 */}
        <div className="mb-1.5 flex items-center justify-between px-0.5">
          <span className="text-xs font-semibold text-text-primary">필터</span>
          <button
            type="button"
            aria-label="필터 닫기"
            onClick={() => setIsOpen(false)}
            className="flex size-6 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-opacity-50"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* 라이브러리(검색 범위) 세그먼트 — 탭과 무관하게 상시 노출 */}
        <div className="mb-2 px-0.5">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
            검색 범위
          </div>
          <div
            role="radiogroup"
            aria-label="라이브러리 선택"
            className="grid grid-cols-3 gap-1 rounded-xl bg-surface-secondary p-1"
          >
            {LIBRARY_OPTIONS.map((opt) => {
              const selected = (periodFilter.library ?? 'all') === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => handleSelectLibrary(opt.id)}
                  className={cn(
                    'rounded-lg px-2 py-1.5 text-xs font-medium text-text-secondary transition-colors',
                    'hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-opacity-50',
                    selected && 'bg-surface-primary text-text-primary shadow-sm',
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        <div
          role="tablist"
          aria-label="필터 범주"
          className="mb-2 grid grid-cols-4 gap-1 rounded-xl bg-surface-secondary p-1"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => handleSelectTab(tab.id)}
              className={cn(
                'relative rounded-lg px-2 py-1.5 text-xs font-medium text-text-secondary transition-colors',
                'hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-opacity-50',
                activeTab === tab.id && 'bg-surface-primary text-text-primary shadow-sm',
              )}
            >
              <span>{tab.label}</span>
              {tab.count ? (
                <span className="ml-1 rounded-full bg-blue-500 px-1.5 py-0.5 text-[10px] leading-none text-white">
                  {tab.count}
                </span>
              ) : tab.active ? (
                <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle" />
              ) : null}
            </button>
          ))}
        </div>

        <div className="max-h-[420px] overflow-y-auto px-0.5 pb-1">
          {activeTab === 'period' && (
            <>
              {QUICK_OPTIONS.map((option) => {
                const isSelected =
                  periodFilter.preset === option.preset &&
                  periodFilter.startDate === null &&
                  periodFilter.endDate === null;
                return (
                  <Ariakit.MenuItem
                    key={option.preset}
                    hideOnClick={false}
                    onClick={() => handleSelectPreset(option.preset)}
                    className="group flex w-full cursor-pointer items-center justify-between gap-5 rounded-lg px-3 py-2 text-sm text-text-primary outline-none hover:bg-surface-hover focus:bg-surface-hover md:px-2.5"
                  >
                    <span>{localize(option.labelKey as Parameters<typeof localize>[0])}</span>
                    {isSelected && (
                      <Check className="h-4 w-4 text-text-primary" aria-hidden="true" />
                    )}
                  </Ariakit.MenuItem>
                );
              })}
              <Ariakit.MenuSeparator className="my-1 h-px border-border-medium" />
              <div className="flex items-center justify-between px-2.5 py-1">
                <span className="text-xs font-medium text-text-secondary">
                  {localize('com_ui_period_custom')}
                </span>
                {periodFilter.preset === 'custom' && (
                  <Check className="h-4 w-4 text-text-primary" aria-hidden="true" />
                )}
              </div>
              <div className="flex items-center gap-1.5 px-1 pb-1">
                <DateTrigger
                  label={localize('com_ui_period_start')}
                  value={periodFilter.startDate}
                  placeholderKey="com_ui_period_pick"
                  isOpen={activeField === 'start'}
                  onToggle={() => toggleField('start')}
                />
                <DateTrigger
                  label={localize('com_ui_period_end')}
                  value={periodFilter.endDate}
                  placeholderKey="com_ui_period_pick"
                  isOpen={activeField === 'end'}
                  onToggle={() => toggleField('end')}
                />
              </div>
              {activeField && (
                <div
                  className="rdp-bkl mx-1 mb-1 mt-1 rounded-lg border border-border-light bg-surface-primary p-1"
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <DayPicker
                    mode="single"
                    selected={activeSelected}
                    onSelect={(d) => handleSelectDate(activeField, d)}
                    locale={dpLocale}
                    numberOfMonths={1}
                    defaultMonth={activeDefaultMonth}
                    disabled={activeDisabled}
                    showOutsideDays
                    weekStartsOn={0}
                  />
                </div>
              )}
            </>
          )}

          {activeTab === 'extension' && (
            <>
              <div className="grid grid-cols-2 gap-2 px-1.5 pb-1 pt-0.5">
                {EXTENSION_OPTIONS.map((opt) => {
                  const active = selectedExts.includes(opt.id);
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => toggleExt(opt.id)}
                      aria-pressed={active}
                      title={opt.hint}
                      className={cn(
                        'inline-flex h-9 items-center justify-center gap-1 rounded-full border px-3 text-xs font-medium transition-colors',
                        active
                          ? 'border-text-primary bg-text-primary text-surface-primary'
                          : 'border-border-medium bg-surface-primary text-text-secondary hover:border-border-heavy hover:text-text-primary',
                      )}
                    >
                      {active && <Check className="h-3 w-3" aria-hidden="true" />}
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {activeTab === 'matter' && (
            <div className="px-1.5 pb-1">
              <div className="mb-1 flex flex-wrap gap-1">
                {filterMatters.map((m) => (
                  <button
                    key={m.matter_uid}
                    type="button"
                    onClick={() =>
                      setFilterMatters((prev) =>
                        prev.filter((item) => item.matter_uid !== m.matter_uid),
                      )
                    }
                    className="inline-flex max-w-full items-center gap-1 rounded-full border border-border-medium px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
                  >
                    <Briefcase className="h-3 w-3" />
                    <span className="truncate">{m.label}</span>
                    <X className="h-3 w-3" />
                  </button>
                ))}
              </div>
              <input
                value={matterSearch}
                onChange={(e) => setMatterSearch(e.target.value)}
                placeholder="사건명/사건번호 검색"
                className="w-full rounded-md border border-border-light bg-surface-primary px-2 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
                onKeyDown={(e) => e.stopPropagation()}
                onBeforeInput={stopMenuInputEvent}
                onPointerDown={stopMenuInputEvent}
                onMouseDown={stopMenuInputEvent}
                onClick={stopMenuInputEvent}
              />
              {matterCandidates.length > 0 && (
                <div className="mt-1 max-h-56 overflow-y-auto rounded-md border border-border-light">
                  {matterCandidates.map((m) => (
                    <button
                      key={m.matter_uid}
                      type="button"
                      onClick={() => addMatter(m)}
                      className="block w-full px-2 py-1.5 text-left text-xs hover:bg-surface-hover"
                    >
                      <div className="truncate font-medium">
                        {m.case_alias || m.case_number || m.matter_uid}
                      </div>
                      <div className="truncate text-text-tertiary">{m.client || m.case_name}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'document' && (
            <div className="px-1.5 pb-1">
              <div className="mb-1 flex flex-wrap gap-1">
                {filterDocs.map((d) => (
                  <button
                    key={d.doc_id}
                    type="button"
                    onClick={() =>
                      setFilterDocs((prev) => prev.filter((item) => item.doc_id !== d.doc_id))
                    }
                    className="inline-flex max-w-full items-center gap-1 rounded-full border border-border-medium px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
                  >
                    <FileText className="h-3 w-3" />
                    <span className="max-w-40 truncate">{d.label}</span>
                    <X className="h-3 w-3" />
                  </button>
                ))}
              </div>
              <input
                value={docSearch}
                onChange={(e) => setDocSearch(e.target.value)}
                placeholder="문서명/문서번호 검색"
                className="w-full rounded-md border border-border-light bg-surface-primary px-2 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
                onKeyDown={(e) => e.stopPropagation()}
                onBeforeInput={stopMenuInputEvent}
                onPointerDown={stopMenuInputEvent}
                onMouseDown={stopMenuInputEvent}
                onClick={stopMenuInputEvent}
              />
              {docSearch.trim().length >= 2 && (
                <div className="mt-1 max-h-56 overflow-y-auto rounded-md border border-border-light">
                  {isDocsFetching && (
                    <div className="px-2 py-2 text-xs text-text-tertiary">문서 검색 중...</div>
                  )}
                  {docCandidates.map((doc) => (
                    <button
                      key={doc.doc_id}
                      type="button"
                      onClick={() => addDoc(doc)}
                      className="block w-full px-2 py-1.5 text-left text-xs hover:bg-surface-hover"
                    >
                      <div className="truncate font-medium">
                        {displayNameOf(doc) || doc.doc_id}
                      </div>
                      <div className="truncate text-text-tertiary">
                        {doc.imanage_doc_id || doc.doc_id}
                      </div>
                    </button>
                  ))}
                  {!isDocsFetching && docCandidates.length === 0 && (
                    <div className="px-2 py-2 text-xs text-text-tertiary">
                      일치하는 문서가 없습니다.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {isActive && (
          <>
            <Ariakit.MenuSeparator className="my-1 h-px border-border-medium" />
            <Ariakit.MenuItem
              onClick={handleClear}
              className="group flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-secondary outline-none hover:bg-surface-hover focus:bg-surface-hover md:px-2.5"
            >
              <X className="h-4 w-4" aria-hidden="true" />
              <span>{localize('com_ui_period_clear')}</span>
            </Ariakit.MenuItem>
          </>
        )}
      </Ariakit.Menu>
    </Ariakit.MenuProvider>
  );
};

export default React.memo(FilterDropdown);
