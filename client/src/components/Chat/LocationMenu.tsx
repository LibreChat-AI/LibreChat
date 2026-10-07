import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Loader2, MapPin, Pencil, Search } from 'lucide-react';
import { dataService, QueryKeys } from 'librechat-data-provider';
import type { IFarmerProfile } from 'librechat-data-provider'; // adjust to wherever IFarmerProfile lives
import { useSaveFarmerProfileMutation } from '~/data-provider'; // adjust import path if different
import { useAuthContext } from '~/hooks';
import { cn } from '~/utils';

type Level = 'state' | 'district' | 'blockName' | 'villageName' | 'nearestKVK';
type Option = { code: number | string; name: string };
type Draft = Record<Level, string>;

// Display order
const LEVELS: Level[] = ['state', 'district', 'blockName', 'villageName', 'nearestKVK'];
const LABELS: Record<Level, string> = {
  state: 'State',
  district: 'District',
  blockName: 'Block',
  villageName: 'Village',
  nearestKVK: 'Nearest KVK',
};

// A level is locked until all its ancestors have a value.
// KVK hangs off the district, so it does not depend on block/village.
const ANCESTORS: Record<Level, Level[]> = {
  state: [],
  district: ['state'],
  blockName: ['state', 'district'],
  villageName: ['state', 'district', 'blockName'],
  nearestKVK: ['state', 'district'],
};

// Changing a level clears everything that belongs to it.
const DESCENDANTS: Record<Level, Level[]> = {
  state: ['district', 'blockName', 'villageName', 'nearestKVK'],
  district: ['blockName', 'villageName', 'nearestKVK'],
  blockName: ['villageName'],
  villageName: [],
  nearestKVK: [],
};

const baseUrl = import.meta.env.VITE_AJRASAKHA_SERVER_URL ?? '';
const asList = (d: unknown): Option[] => (Array.isArray(d) ? d : []);

const norm = (s: string) => s.trim().toLowerCase();
const same = (a: string, b: string) => norm(a) === norm(b);
const findByName = (list: Option[], name: string) =>
  name ? list.find((o) => norm(o.name) === norm(name)) : undefined;

const draftFromProfile = (p?: IFarmerProfile): Draft => ({
  state: p?.state ?? '',
  district: p?.district ?? '',
  blockName: p?.blockName ?? '',
  villageName: p?.villageName ?? '',
  nearestKVK: p?.nearestKVK ?? '',
});

const missingAncestor = (level: Level, d: Draft): Level | undefined =>
  ANCESTORS[level].find((l) => !d[l]);

export default function LocationMenu({ isSmallScreen }: { isSmallScreen?: boolean }) {
  const { user } = useAuthContext();
  const queryClient = useQueryClient();
  const profile = user?.farmerProfile as IFarmerProfile | undefined;

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Level | null>(null);
  const [draft, setDraft] = useState<Draft>(() => draftFromProfile(profile));
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const original = draftFromProfile(profile);
  const stateChanged = !same(draft.state, original.state);
  const districtChanged = !same(draft.district, original.district);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Reset the draft every time the panel opens
  useEffect(() => {
    if (open) {
      setDraft(draftFromProfile(profile));
      setEditing(null);
      setSearch('');
      setError('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Position the portaled panel under the trigger
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 16);
    setPos({
      top: rect.bottom + 8,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    });
  }, [open]);

  // Close on outside click / Escape / resize
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  // ---- Location data (same query keys as the registration form, so the cache is shared) ----
  const { data: states = [], isFetching: statesLoading } = useQuery<Option[]>({
    queryKey: ['states'],
    queryFn: async () => {
      try {
        return asList(await dataService.getLocationStates(baseUrl));
      } catch (e) {
        console.error('Failed to fetch states', e);
        return [];
      }
    },
    enabled: open,
    staleTime: Infinity,
  });
  const stateObj = findByName(states, draft.state);

  const { data: districts = [], isFetching: districtsLoading } = useQuery<Option[]>({
    queryKey: ['districts', stateObj?.code, draft.state],
    queryFn: async () => {
      try {
        return asList(await dataService.getLocationDistricts(baseUrl, stateObj!.code));
      } catch (e) {
        console.error('Failed to fetch districts', e);
        return [];
      }
    },
    enabled: open && stateObj?.code !== undefined,
    staleTime: Infinity,
  });
  const districtObj = findByName(districts, draft.district);

  const { data: blocks = [], isFetching: blocksLoading } = useQuery<Option[]>({
    queryKey: ['subdistricts', districtObj?.code, draft.district],
    queryFn: async () => {
      try {
        return asList(await dataService.getLocationBlocks(baseUrl, districtObj!.code));
      } catch (e) {
        console.error('Failed to fetch subdistricts', e);
        return [];
      }
    },
    enabled: open && districtObj?.code !== undefined,
    staleTime: Infinity,
  });
  const blockObj = findByName(blocks, draft.blockName);

  const { data: villages = [], isFetching: villagesLoading } = useQuery<Option[]>({
    queryKey: ['villages', blockObj?.code, draft.blockName],
    queryFn: async () => {
      try {
        return asList(await dataService.getLocationVillages(baseUrl, blockObj!.code));
      } catch (e) {
        console.error('Failed to fetch villages', e);
        return [];
      }
    },
    enabled: open && blockObj?.code !== undefined,
    staleTime: Infinity,
  });

  // KVKs are keyed by district (same mapping as the registration form)
  const { data: kvks = [], isFetching: kvksLoading } = useQuery<Option[]>({
    queryKey: ['kvks', districtObj?.code, draft.district],
    queryFn: async () => {
      try {
        const data = await dataService.getLocationKvks(baseUrl, districtObj!.code);
        return Array.isArray(data)
          ? data.map((k: any) => ({
              code: k.kvkId,
              name: k.kvkAddress ? `${k.kvkName}, ${k.kvkAddress}` : k.kvkName,
            }))
          : [];
      } catch (e) {
        console.error('Failed to fetch KVKs', e);
        return [];
      }
    },
    enabled: open && districtObj?.code !== undefined,
    staleTime: Infinity,
  });

  const optionsByLevel: Record<Level, string[]> = {
    state: states.map((s) => s.name),
    district: districts.map((d) => d.name),
    blockName: blocks.map((b) => b.name),
    villageName: villages.map((v) => v.name),
    nearestKVK: kvks.map((k) => k.name),
  };
  const loadingByLevel: Record<Level, boolean> = {
    state: statesLoading,
    district: districtsLoading,
    blockName: blocksLoading,
    villageName: villagesLoading,
    nearestKVK: kvksLoading,
  };

  // ---- Save ----
  const saveMutation = useSaveFarmerProfileMutation({
    onSuccess: (_data: unknown, v: Partial<IFarmerProfile>) => {
      const lower = (s = '') => s.trim().toLowerCase();
      // The API only returns a message, so mirror what the backend stored
      queryClient.setQueryData([QueryKeys.user], (old: any) =>
        old
          ? {
              ...old,
              farmerProfile: {
                ...old.farmerProfile,
                state: lower(v.state),
                district: lower(v.district),
                blockName: lower(v.blockName),
                villageName: lower(v.villageName),
                nearestKVK: (v.nearestKVK ?? '').trim(),
              },
            }
          : old,
      );
      queryClient.invalidateQueries([QueryKeys.user]);
      setOpen(false);
    },
    onError: (e: unknown) => {
      console.error('Failed to update location', e);
      setError('Could not save your location. Please try again.');
    },
  });

  const lockedReason = (level: Level): string | null => {
    const missing = missingAncestor(level, draft);
    return missing ? `Select ${LABELS[missing]} first` : null;
  };

  const pick = (level: Level, value: string) => {
    setSearch('');
    if (same(value, draft[level])) {
      setEditing(null);
      return;
    }
    const next: Draft = { ...draft, [level]: value };
    DESCENDANTS[level].forEach((l) => (next[l] = '')); // children belong to the old parent
    setDraft(next);

    // Guide the user to the next level that is now empty and unlocked (if any)
    const after = LEVELS.slice(LEVELS.indexOf(level) + 1).find(
      (l) => !next[l] && !missingAncestor(l, next),
    );
    setEditing(after ?? null);
  };

  const dirty = LEVELS.some((l) => !same(draft[l], original[l]));

  // Nothing above the changed level changed: any partial edit is fine (e.g. only the village).
  // State or district changed: the chain under it was cleared, so it must be completed,
  // except levels the API has no options for. A level still loading counts as missing.
  const mustCompleteChain = stateChanged || districtChanged;
  const missingRequired = mustCompleteChain
    ? LEVELS.some(
        (l) =>
          !draft[l] &&
          (l === 'state' || l === 'district' || loadingByLevel[l] || optionsByLevel[l].length > 0),
      )
    : !draft.state || !draft.district;

  const canSave = dirty && !missingRequired && !saveMutation.isLoading;

  const handleSave = () => {
    if (!profile) return;
    setError('');
    // Partial update: the controller only $sets the fields that are present
    saveMutation.mutate({
      state: draft.state,
      district: draft.district,
      blockName: draft.blockName,
      villageName: draft.villageName,
      nearestKVK: draft.nearestKVK,
    } as IFarmerProfile);
  };

  const filtered = useMemo(() => {
    if (!editing) return [];
    const q = search.trim().toLowerCase();
    const list = optionsByLevel[editing];
    return q ? list.filter((o) => o.toLowerCase().includes(q)) : list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, search, states, districts, blocks, villages, kvks]);

  if (!profile) return null;

  const summary = (
    isSmallScreen
      ? [profile.district, profile.state]
      : [profile.villageName, profile.blockName, profile.district, profile.state]
  )
    .filter(Boolean)
    .join(', ');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex max-w-[16rem] items-center gap-1.5 rounded-lg border border-border-light bg-surface-primary px-2.5 py-1.5 text-sm font-medium text-text-primary hover:bg-surface-hover sm:max-w-sm"
      >
        <MapPin className="h-4 w-4 shrink-0 text-text-secondary" />
        <span className="truncate capitalize">{summary || 'Set location'}</span>
        <ChevronDown
          className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Edit location"
            style={{ top: pos.top, left: pos.left, width: Math.min(320, window.innerWidth - 16) }}
            className="fixed z-[110] rounded-xl border border-border-light bg-surface-primary p-2 text-sm font-normal text-text-primary shadow-lg"
          >
            <ul className="flex flex-col">
              {LEVELS.map((level) => {
                const isEditing = editing === level;
                const reason = lockedReason(level);
                const changed = !same(draft[level], original[level]);
                return (
                  <li key={level} className="rounded-lg">
                    <div className="flex items-center justify-between gap-2 px-2 py-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-xs text-text-secondary">
                          {LABELS[level]}
                          {changed && (
                            <span className="rounded bg-surface-hover px-1 text-[10px] font-medium text-text-primary">
                              Changed
                            </span>
                          )}
                        </div>
                        <div
                          title={draft[level] || undefined}
                          className={cn(
                            'truncate font-medium',
                            level !== 'nearestKVK' && 'capitalize',
                            !draft[level] && 'text-text-tertiary',
                          )}
                        >
                          {draft[level] || `Select ${LABELS[level]}`}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={!!reason}
                        onClick={() => {
                          setSearch('');
                          setEditing(isEditing ? null : level);
                        }}
                        title={reason ?? `Edit ${LABELS[level]}`}
                        className="rounded-md p-1.5 text-text-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                    </div>

                    {isEditing && (
                      <div className="mx-2 mb-2 rounded-lg border border-border-light">
                        <div className="flex items-center gap-2 border-b border-border-light px-2 py-1.5">
                          <Search className="h-4 w-4 text-text-secondary" />
                          <input
                            autoFocus
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder={`Search ${LABELS[level]}…`}
                            className="w-full bg-transparent outline-none placeholder:text-text-tertiary"
                          />
                        </div>
                        <div className="max-h-48 overflow-y-auto py-1">
                          {loadingByLevel[level] ? (
                            <div className="flex items-center gap-2 px-3 py-2 text-text-secondary">
                              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                            </div>
                          ) : filtered.length === 0 ? (
                            <div className="px-3 py-2 text-text-secondary">No options found</div>
                          ) : (
                            filtered.map((name) => (
                              <button
                                key={name}
                                type="button"
                                onClick={() => pick(level, name)}
                                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-surface-hover"
                              >
                                <span className="break-words">{name}</span>
                                {same(name, draft[level]) && <Check className="h-4 w-4 shrink-0" />}
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {mustCompleteChain && (
              <p className="px-2 pb-1 text-xs text-text-secondary">
                You changed the {stateChanged ? 'state' : 'district'}, so please update the
                remaining fields below it.
              </p>
            )}
            {error && <p className="px-2 pb-1 text-xs text-red-500">{error}</p>}

            <div className="mt-1 flex justify-end gap-2 border-t border-border-light px-2 pt-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-1.5 hover:bg-surface-hover"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!canSave}
                onClick={handleSave}
                className="flex items-center gap-1.5 rounded-md bg-surface-submit px-3 py-1.5 text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saveMutation.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                Save
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
