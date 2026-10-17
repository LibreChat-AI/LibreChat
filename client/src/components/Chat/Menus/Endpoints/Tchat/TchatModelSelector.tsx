import React, { useCallback, useMemo, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { useNavigate } from 'react-router-dom';
import { TooltipAnchor, useToastContext } from '@librechat/client';
import { Bot, Check, ChevronDown, ImageIcon, LayoutGrid, Pin, PinOff, Search } from 'lucide-react';
import { getConfigDefaults, isAgentsEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';
import type { TImageSpec, TModelSpec } from 'librechat-data-provider';
import type { Endpoint, ModelSelectorProps } from '~/common';
import type { ImageGenChoice } from './useImageGenChoice';
import type { ModelCatalog } from './useModelCatalog';
import { ModelSelectorProvider, useModelSelectorContext } from '../ModelSelectorContext';
import { buildOwnerGroups, formatModelLabel, getModelOwner, getOwner } from './owners';
import { useShortcutAriaKey, useShortcutHint } from '~/hooks/useKeyboardShortcuts';
import { ModelSelectorChatProvider } from '../ModelSelectorChatContext';
import useRepairImageModelChat from './useRepairImageModelChat';
import { useImageGenAvailable } from '~/hooks/Plugins';
import { getSpecAgentAvatarURL, cn } from '~/utils';
import { useFavorites, useLocalize } from '~/hooks';
import useImageGenChoice from './useImageGenChoice';
import useModelCatalog from './useModelCatalog';
import SpecIcon from '../components/SpecIcon';
import OwnerMark from './OwnerMark';

const defaultInterface = getConfigDefaults().interface;
const ALL = 'all';

interface Row {
  key: string;
  label: string;
  /** The raw model id, printed under the label so nothing is hidden by formatting. */
  detail?: string;
  /** Leading art, for rows whose group mark does not already say what they are. */
  mark?: React.ReactNode;
  selected: boolean;
  /** TensorGrid prices this model at zero. */
  free?: boolean;
  onSelect: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  searchText: string;
}

interface Group {
  id: string;
  label: string;
  caption?: string;
  mark: React.ReactNode;
  rows: Row[];
  /** Agents end with the marketplace, as in the stock selector. */
  marketplace?: boolean;
}

interface Current {
  label: string;
  caption?: string;
  detail?: string;
  free?: boolean;
  mark: React.ReactNode;
  /** Rail entry that owns the current selection. */
  groupId?: string;
}

const isAgentLike = (value?: string | null) =>
  isAgentsEndpoint(value) || isAssistantsEndpoint(value);

function EndpointArt({ endpoint, id, size }: { endpoint: Endpoint; id?: string; size: number }) {
  const avatar = id ? endpoint.modelIcons?.[id] : undefined;
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className="border-border-light bg-surface-primary text-text-primary inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg border"
    >
      {avatar ? (
        <img src={avatar} alt="" className="h-full w-full object-cover" />
      ) : (
        (endpoint.icon ?? <Bot className="size-4" />)
      )}
    </span>
  );
}

function SpecArt({ spec, size }: { spec: TModelSpec; size: number }) {
  const { endpointsConfig, agentsMap } = useModelSelectorContext();
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className="border-border-light bg-surface-primary inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg border"
    >
      <SpecIcon
        currentSpec={spec}
        endpointsConfig={endpointsConfig}
        agentAvatarURL={getSpecAgentAvatarURL(spec, agentsMap)}
      />
    </span>
  );
}

/** The image model Image Gen will use, shown beside the chat model on the trigger. */
interface ImageChoice {
  label: string;
  model: string;
}

/** Image Gen's own mark, for the group header and rail. */
function ImageMark({ size }: { size: number }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className="border-border-light bg-surface-primary text-text-primary inline-flex shrink-0 items-center justify-center rounded-lg border"
    >
      <ImageIcon style={{ width: size * 0.6, height: size * 0.6 }} />
    </span>
  );
}

interface GroupSources {
  imageSpecs: TImageSpec[];
  catalog: ModelCatalog;
  imageGenAvailable: boolean;
  imageGen: ImageGenChoice;
}

function useGroups({ imageSpecs, catalog, imageGenAvailable, imageGen }: GroupSources): {
  groups: Group[];
  current: Current | null;
  image: ImageChoice | null;
} {
  const localize = useLocalize();
  const {
    agentsMap,
    modelSpecs,
    mappedEndpoints,
    selectedValues,
    handleSelectSpec,
    handleSelectModel,
  } = useModelSelectorContext();
  const {
    isFavoriteModel,
    toggleFavoriteModel,
    isFavoriteAgent,
    toggleFavoriteAgent,
    isFavoriteSpec,
    toggleFavoriteSpec,
  } = useFavorites();

  return useMemo(() => {
    const endpoints = mappedEndpoints ?? [];
    const { endpoint: selEndpoint, model: selModel, modelSpec: selSpec } = selectedValues;
    const ownerGroups = buildOwnerGroups(endpoints, catalog.isChatModel);
    const listed = new Set(ownerGroups.flatMap((g) => g.models.map((m) => m.modelId)));

    const groups: Group[] = [];

    /** A spec that only names an endpoint and a listed model is that model's row; the rest stay presets. */
    const presets = (modelSpecs ?? []).filter(
      (spec) =>
        isAgentLike(spec.preset?.endpoint) || !spec.preset?.model || !listed.has(spec.preset.model),
    );
    if (presets.length > 0) {
      groups.push({
        id: 'presets',
        label: localize('com_endpoint_presets'),
        mark: <SpecArt spec={presets[0]} size={20} />,
        rows: presets.map((spec) => ({
          key: `spec::${spec.name}`,
          label: spec.label || spec.name,
          detail: spec.description,
          mark: <SpecArt spec={spec} size={28} />,
          selected: selSpec === spec.name,
          onSelect: () => handleSelectSpec(spec),
          pinned: isFavoriteSpec(spec.name),
          onTogglePin: () => toggleFavoriteSpec(spec.name),
          searchText: [spec.label, spec.name, spec.description].join(' ').toLowerCase(),
        })),
      });
    }

    for (const { owner, models } of ownerGroups) {
      groups.push({
        id: owner.id,
        label: owner.label,
        caption: owner.family,
        mark: <OwnerMark owner={owner.id} size={20} />,
        rows: models.map((model) => ({
          key: model.key,
          label: model.label,
          detail: model.modelId,
          selected: !isAgentLike(selEndpoint) && selModel === model.modelId,
          free: catalog.isFree(model.modelId),
          onSelect: () => handleSelectModel(model.endpoint, model.modelId),
          pinned: isFavoriteModel(model.modelId, model.endpoint.value),
          onTogglePin: () =>
            toggleFavoriteModel({ model: model.modelId, endpoint: model.endpoint.value }),
          /** A free model also answers a search for the tag's own word. */
          searchText: [
            model.label,
            model.modelId,
            owner.label,
            owner.family,
            catalog.isFree(model.modelId) ? localize('com_ui_free') : '',
          ]
            .join(' ')
            .toLowerCase(),
        })),
      });
    }

    /**
     * Image models cannot hold a chat, so picking one here turns on Image Gen
     * with that model and leaves the chat model as it is. Picking the active
     * one again turns Image Gen off.
     */
    let image: ImageChoice | null = null;
    if (imageGenAvailable && imageSpecs.length > 0) {
      const defaultSpec = imageSpecs.find((spec) => spec.default === true) ?? imageSpecs[0];
      const { selection } = imageGen;
      /** `true` (or a name that outlived its entry) means the default, as on the server. */
      let activeName: string | null = null;
      if (selection) {
        const named =
          typeof selection === 'string' && imageSpecs.some((spec) => spec.name === selection);
        activeName = named ? (selection as string) : defaultSpec.name;
      }
      const active = imageSpecs.find((spec) => spec.name === activeName);
      image = active ? { label: active.label, model: active.model } : null;
      const imageLabel = localize('com_ui_image_gen');
      groups.push({
        id: 'image',
        label: imageLabel,
        mark: <ImageMark size={20} />,
        rows: imageSpecs.map((spec) => ({
          key: `image::${spec.name}`,
          label: spec.label,
          detail: spec.model,
          mark: <OwnerMark owner={getModelOwner(spec.model)} size={28} />,
          selected: spec.name === activeName,
          free: catalog.isFree(spec.model),
          onSelect: () => imageGen.select(spec.name === activeName ? false : spec.name),
          searchText: [
            spec.label,
            spec.model,
            spec.description,
            imageLabel,
            getOwner(getModelOwner(spec.model)).label,
            catalog.isFree(spec.model) ? localize('com_ui_free') : '',
          ]
            .join(' ')
            .toLowerCase(),
        })),
      });
    }

    for (const endpoint of endpoints) {
      if (!isAgentLike(endpoint.value)) {
        continue;
      }
      const isAgents = isAgentsEndpoint(endpoint.value);
      const ids = (endpoint.models ?? []).map((m) => m.name);
      if (ids.length === 0 && endpoint.showMarketplace !== true) {
        continue;
      }
      groups.push({
        id: `endpoint::${endpoint.value}`,
        label: endpoint.label,
        mark: <EndpointArt endpoint={endpoint} size={20} />,
        marketplace: endpoint.showMarketplace === true,
        rows: ids.map((id) => {
          const name =
            endpoint.agentNames?.[id] ??
            endpoint.assistantNames?.[id] ??
            agentsMap?.[id]?.name ??
            id;
          return {
            key: `${endpoint.value}::${id}`,
            label: name,
            mark: <EndpointArt endpoint={endpoint} id={id} size={28} />,
            selected: selEndpoint === endpoint.value && selModel === id,
            onSelect: () => handleSelectModel(endpoint, id),
            pinned: isAgents ? isFavoriteAgent(id) : undefined,
            onTogglePin: isAgents ? () => toggleFavoriteAgent(id) : undefined,
            searchText: [name, endpoint.label].join(' ').toLowerCase(),
          };
        }),
      });
    }

    let current: Current | null = null;
    const selectedEndpoint = endpoints.find((e) => e.value === selEndpoint);
    if (selEndpoint && isAgentLike(selEndpoint) && selModel && selectedEndpoint) {
      current = {
        label:
          selectedEndpoint.agentNames?.[selModel] ??
          selectedEndpoint.assistantNames?.[selModel] ??
          agentsMap?.[selModel]?.name ??
          selModel,
        caption: selectedEndpoint.label,
        mark: <EndpointArt endpoint={selectedEndpoint} id={selModel} size={24} />,
        groupId: `endpoint::${selEndpoint}`,
      };
    } else if (selModel) {
      const owner = getOwner(getModelOwner(selModel));
      current = {
        label: formatModelLabel(selModel),
        caption: owner.label,
        detail: selModel,
        free: catalog.isFree(selModel),
        mark: <OwnerMark owner={owner.id} size={24} />,
        groupId: owner.id,
      };
    } else if (selSpec) {
      const spec = (modelSpecs ?? []).find((s) => s.name === selSpec);
      if (spec) {
        current = {
          label: spec.label || spec.name,
          mark: <SpecArt spec={spec} size={24} />,
          groupId: 'presets',
        };
      }
    }

    return { groups, current, image };
  }, [
    localize,
    agentsMap,
    modelSpecs,
    mappedEndpoints,
    selectedValues,
    handleSelectSpec,
    handleSelectModel,
    isFavoriteModel,
    toggleFavoriteModel,
    isFavoriteAgent,
    toggleFavoriteAgent,
    isFavoriteSpec,
    toggleFavoriteSpec,
    catalog,
    imageGenAvailable,
    imageGen,
    imageSpecs,
  ]);
}

/** Marks a model TensorGrid prices at zero. */
function FreeTag({ className }: { className?: string }) {
  const localize = useLocalize();
  return (
    <span
      className={cn(
        'border-border-medium text-2xs text-text-primary inline-flex shrink-0 items-center rounded-full border px-1.5 leading-4 font-medium',
        className,
      )}
    >
      {localize('com_ui_free')}
    </span>
  );
}

function ModelRow({ row, onPicked }: { row: Row; onPicked: () => void }) {
  const localize = useLocalize();
  return (
    <Ariakit.ComboboxItem
      focusOnHover
      setValueOnClick={false}
      hideOnClick={false}
      onClick={() => {
        row.onSelect();
        onPicked();
      }}
      className={cn(
        'group relative flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg border px-3 py-1.5 text-left outline-none',
        'data-[active-item]:bg-surface-hover',
        row.selected
          ? 'border-border-medium bg-surface-active-alt'
          : 'hover:bg-surface-hover border-transparent',
      )}
    >
      {row.mark}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-text-primary truncate text-sm font-medium">{row.label}</span>
          {row.free && <FreeTag />}
        </span>
        {row.detail && (
          <span className="text-text-secondary truncate font-mono text-xs">{row.detail}</span>
        )}
      </span>
      {row.onTogglePin && (
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            row.onTogglePin?.();
          }}
          aria-label={row.pinned ? localize('com_ui_unpin') : localize('com_ui_pin')}
          className={cn(
            'text-text-secondary hover:bg-surface-active hover:text-text-primary flex size-7 shrink-0 items-center justify-center rounded-md',
            row.pinned
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100 group-data-[active-item]:opacity-100',
          )}
        >
          {row.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
        </button>
      )}
      {row.selected && (
        <>
          <Check className="text-text-primary size-4 shrink-0" aria-hidden="true" />
          <Ariakit.VisuallyHidden>{localize('com_ui_current')}</Ariakit.VisuallyHidden>
        </>
      )}
    </Ariakit.ComboboxItem>
  );
}

const NO_IMAGE_SPECS: TImageSpec[] = [];

function TchatModelSelectorContent({ imageSpecs }: { imageSpecs: TImageSpec[] }) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const modelSelectorHint = useShortcutHint('openModelSelector', localize('com_ui_select_model'));
  const modelSelectorAriaKey = useShortcutAriaKey('openModelSelector');
  const { showToast } = useToastContext();
  const { modelSpecs, mappedEndpoints, selectedValues, handleSelectModel } =
    useModelSelectorContext();
  const catalog = useModelCatalog();
  const imageGenAvailable = useImageGenAvailable();
  const imageGen = useImageGenChoice((modelSpecs?.length ?? 0) > 0);
  const { groups, current, image } = useGroups({
    imageSpecs,
    catalog,
    imageGenAvailable,
    imageGen,
  });

  const onRepaired = useCallback(
    (from: string, to: string) =>
      showToast({
        message: localize('com_ui_image_model_moved', {
          0: formatModelLabel(from),
          1: formatModelLabel(to),
        }),
        status: 'info',
      }),
    [showToast, localize],
  );
  useRepairImageModelChat({
    catalog,
    selectedValues,
    mappedEndpoints,
    modelSpecs,
    imageSpecs,
    imageGenAvailable,
    imageGen,
    handleSelectModel,
    onRepaired,
  });

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<string>(ALL);

  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setSearch('');
      setFilter(ALL);
    }
  }, []);
  /** A pick closes the picker the same way dismissing it does, so it reopens clean. */
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const term = search.trim().toLowerCase();
  const marketplaceLabel = localize('com_agents_marketplace');
  const visible = useMemo(
    () =>
      groups
        .filter((group) => filter === ALL || group.id === filter)
        .map((group) => ({
          ...group,
          rows: term ? group.rows.filter((row) => row.searchText.includes(term)) : group.rows,
          marketplace:
            group.marketplace === true &&
            (!term ||
              marketplaceLabel.toLowerCase().includes(term) ||
              'marketplace'.includes(term)),
        }))
        .filter((group) => group.rows.length > 0 || group.marketplace),
    [groups, filter, term, marketplaceLabel],
  );
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const showCurrent = current != null && !term && filter === ALL;

  const trigger = (
    <TooltipAnchor
      description={modelSelectorHint}
      render={
        <button
          type="button"
          data-testid="model-selector-button"
          aria-keyshortcuts={modelSelectorAriaKey}
          aria-label={
            current
              ? `${localize('com_ui_select_model')}: ${current.label}`
              : localize('com_ui_select_model')
          }
          className={cn(
            'border-border-light text-text-primary my-1 flex h-9 max-w-full items-center gap-2 rounded-xl border py-1 pr-2.5 pl-1.5 text-sm',
            open ? 'bg-surface-active-alt' : 'bg-presentation hover:bg-surface-active-alt',
          )}
        >
          {current?.mark}
          <span className="truncate text-left font-medium">
            {current?.label ?? localize('com_ui_select_model')}
          </span>
          {current?.caption && (
            <span className="text-text-secondary hidden shrink-0 sm:inline">{current.caption}</span>
          )}
          {current?.free && <FreeTag />}
          {image && (
            <span
              title={`${localize('com_ui_image_gen')}: ${image.label}`}
              className="border-border-medium text-text-secondary flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs"
            >
              <ImageIcon className="size-3.5" aria-hidden="true" />
              <span className="hidden max-w-[10rem] truncate md:inline">{image.label}</span>
              <Ariakit.VisuallyHidden>
                {`${localize('com_ui_image_gen')}: ${image.label}`}
              </Ariakit.VisuallyHidden>
            </span>
          )}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'text-text-secondary size-4 shrink-0 transition-transform',
              open && 'rotate-180',
            )}
          />
        </button>
      }
    />
  );

  return (
    <div className="relative flex max-w-[60vw] min-w-0 flex-col items-center gap-2 sm:max-w-md">
      <Ariakit.PopoverProvider open={open} setOpen={onOpenChange} placement="bottom-start">
        <Ariakit.PopoverDisclosure render={trigger} />
        <Ariakit.Popover
          portal
          gutter={6}
          unmountOnHide
          aria-label={localize('com_ui_select_model')}
          className={cn(
            'animate-popover border-border-light bg-presentation text-text-primary rounded-theme-popover z-50 flex flex-col overflow-hidden border shadow-lg outline-none',
            'max-h-[min(560px,var(--popover-available-height,560px))] w-[min(720px,calc(100vw-1rem))]',
          )}
        >
          <Ariakit.ComboboxProvider value={search} setValue={setSearch} includesBaseElement={false}>
            <div className="border-border-light flex h-12 shrink-0 items-center gap-2 border-b px-4">
              <Search className="text-text-secondary size-4 shrink-0" aria-hidden="true" />
              <Ariakit.Combobox
                autoSelect
                aria-label={localize('com_endpoint_search_models')}
                placeholder={localize('com_endpoint_search_models')}
                className="text-text-primary placeholder:text-text-secondary h-full w-full border-none bg-transparent text-base outline-none focus:ring-0 focus:outline-none focus-visible:ring-0 focus-visible:outline-none sm:text-sm"
              />
            </div>

            <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
              <nav
                aria-label={localize('com_ui_provider')}
                className="border-border-light flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-48 sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto sm:border-r sm:border-b-0"
              >
                <RailButton
                  active={filter === ALL}
                  onClick={() => setFilter(ALL)}
                  label={localize('com_ui_all_proper')}
                  count={total}
                />
                {groups.map((group) => (
                  <RailButton
                    key={group.id}
                    active={filter === group.id}
                    onClick={() => setFilter(group.id)}
                    label={group.label}
                    mark={group.mark}
                    count={group.rows.length}
                    isCurrent={current?.groupId === group.id}
                  />
                ))}
              </nav>

              <Ariakit.ComboboxList
                alwaysVisible
                className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-2"
              >
                {showCurrent && current && (
                  <div className="border-border-medium bg-surface-active-alt flex items-center gap-3 rounded-xl border px-3 py-2.5">
                    {current.mark}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-semibold">{current.label}</span>
                        {current.free && <FreeTag />}
                      </span>
                      <span className="text-text-secondary truncate text-xs">
                        {[current.caption, current.detail].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="text-text-secondary flex shrink-0 items-center gap-1 text-xs font-medium">
                      <Check className="text-text-primary size-4" aria-hidden="true" />
                      {localize('com_ui_current')}
                    </span>
                  </div>
                )}

                {visible.map((group) => (
                  <Ariakit.ComboboxGroup key={group.id} className="flex flex-col gap-0.5">
                    <Ariakit.ComboboxGroupLabel className="bg-presentation sticky -top-2 z-10 flex items-center gap-2 px-1 py-1.5">
                      {group.mark}
                      <span className="text-text-primary text-xs font-semibold">{group.label}</span>
                      <span className="text-text-secondary text-xs">
                        {[group.caption, group.rows.length]
                          .filter((v) => v != null && v !== '')
                          .join(' · ')}
                      </span>
                    </Ariakit.ComboboxGroupLabel>
                    {group.rows.map((row) => (
                      <ModelRow key={row.key} row={row} onPicked={close} />
                    ))}
                    {group.marketplace && (
                      <Ariakit.ComboboxItem
                        focusOnHover
                        setValueOnClick={false}
                        hideOnClick={false}
                        data-testid="model-selector-marketplace-item"
                        onClick={() => {
                          close();
                          navigate('/agents');
                        }}
                        className="hover:bg-surface-hover data-[active-item]:bg-surface-hover flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-3 text-left text-sm outline-none"
                      >
                        <LayoutGrid className="text-text-primary size-5" aria-hidden="true" />
                        <span className="truncate">{marketplaceLabel}</span>
                      </Ariakit.ComboboxItem>
                    )}
                  </Ariakit.ComboboxGroup>
                ))}

                {visible.length === 0 && (
                  <div className="text-text-secondary flex flex-col items-center gap-3 px-4 py-12 text-center text-sm">
                    <span>{localize('com_ui_no_results_found')}</span>
                    {filter !== ALL && (
                      <button
                        type="button"
                        onClick={() => setFilter(ALL)}
                        className="border-border-light text-text-primary hover:bg-surface-hover rounded-lg border px-3 py-1.5"
                      >
                        {localize('com_ui_all_proper')}
                      </button>
                    )}
                  </div>
                )}
              </Ariakit.ComboboxList>
            </div>
          </Ariakit.ComboboxProvider>
        </Ariakit.Popover>
      </Ariakit.PopoverProvider>
    </div>
  );
}

function RailButton({
  active,
  onClick,
  label,
  mark,
  count,
  isCurrent = false,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  mark?: React.ReactNode;
  count: number;
  isCurrent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex h-9 shrink-0 items-center gap-2 rounded-lg px-2 text-left text-sm sm:w-full',
        active
          ? 'bg-surface-active-alt text-text-primary font-medium'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
      )}
    >
      {mark}
      <span className="truncate sm:flex-1">{label}</span>
      {isCurrent && (
        <span aria-hidden="true" className="bg-text-primary size-1.5 shrink-0 rounded-full" />
      )}
      <span className="text-text-secondary shrink-0 text-xs">{count}</span>
    </button>
  );
}

/**
 * Tchat's model selector: models grouped by the company that makes them, with
 * the model in use named on the trigger. Selection, specs, agents and pins all
 * go through the stock ModelSelector context, so conversation state is untouched.
 */
export default function TchatModelSelector({ startupConfig }: ModelSelectorProps) {
  const interfaceConfig = startupConfig?.interface ?? defaultInterface;
  const modelSpecs = startupConfig?.modelSpecs?.list ?? [];

  if (interfaceConfig.modelSelect === false && modelSpecs.length === 0) {
    return null;
  }

  return (
    <ModelSelectorChatProvider>
      <ModelSelectorProvider startupConfig={startupConfig}>
        <TchatModelSelectorContent
          imageSpecs={startupConfig?.modelSpecs?.imageList ?? NO_IMAGE_SPECS}
        />
      </ModelSelectorProvider>
    </ModelSelectorChatProvider>
  );
}
