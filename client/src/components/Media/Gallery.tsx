import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Film, Image, Images, Play, Search, Trash2 } from 'lucide-react';
import { Button, Chip, EmptyState, Input, Radio, Skeleton, TooltipAnchor } from '@librechat/client';
import type { MediaCatalog, MediaThreadListRequest } from 'librechat-data-provider';
import type { MediaTile, useMediaThreads } from '~/data-provider';
import type { MediaLibrary } from './state';
import { mediaThreadFilterLabels } from './labels';
import { getMessageTimestamp } from '~/utils';
import { MediaPreview } from './Asset';
import { MediaStatus } from './Status';
import { useLocalize } from '~/hooks';

const densities = [2, 3, 4] as const;
/** Phones keep two tiles per row; the density choice applies once the page is wide enough. */
const grids = {
  2: 'grid grid-cols-2 gap-4 sm:gap-5',
  3: 'grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4',
  4: 'grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4',
} satisfies Record<MediaLibrary['columns'], string>;
const settled = new Set(['succeeded', 'failed', 'cancelled']);

export function MediaGallery({
  tiles,
  catalog,
  query,
  filter,
  search,
  columns,
  onFilter,
  onSearch,
  onCreate,
  onColumns,
  onOpen,
  onDelete,
}: {
  tiles: MediaTile[];
  catalog?: MediaCatalog;
  query: ReturnType<typeof useMediaThreads>;
  filter: NonNullable<MediaThreadListRequest['filter']>;
  search: string;
  columns: MediaLibrary['columns'];
  onFilter: (value: NonNullable<MediaThreadListRequest['filter']>) => void;
  onSearch: (value: string) => void;
  onCreate: () => void;
  onColumns: (value: MediaLibrary['columns']) => void;
  onOpen: (threadId: string) => void;
  onDelete?: (threadId: string) => void;
}) {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const id = useId();
  const grid = grids[columns];
  const offerings = useMemo(
    () =>
      new Map(
        catalog?.offerings.map((item) => [JSON.stringify([item.connectionId, item.modelId]), item]),
      ),
    [catalog],
  );
  const needle = search.trim().toLocaleLowerCase();
  const filtered = needle || filter !== 'all';
  const visible = tiles.flatMap((tile) => {
    const latest = tile.thread?.activity?.latestJob;
    const offering =
      latest &&
      offerings.get(JSON.stringify([latest.selection.connectionId, latest.selection.modelId]));
    const model = offering?.modelName ?? latest?.selection.modelId;
    const connection = offering?.connectionName ?? latest?.selection.connectionId;
    if (needle && !tile.title.toLocaleLowerCase().includes(needle)) return [];
    return [{ tile, latest, model: model ?? connection }];
  });
  return (
    <section className="min-w-0 space-y-5" aria-label={localize('com_media_threads')}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{localize('com_media_gallery')}</h2>
          <p className="text-text-secondary mt-1 text-sm">
            {localize('com_media_library_description')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span id={`${id}-columns`} className="text-text-secondary text-xs">
            {localize('com_media_columns')}
          </span>
          <Radio
            aria-labelledby={`${id}-columns`}
            value={String(columns)}
            options={densities.map((value) => ({ value: String(value), label: String(value) }))}
            onChange={(value) => {
              const next = densities.find((density) => String(density) === value);
              if (next) onColumns(next);
            }}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label={localize('com_media_filter')}
          className="flex flex-wrap gap-1"
        >
          {(['all', 'completed', 'pending'] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? 'secondary' : 'ghost'}
              aria-pressed={filter === value}
              onClick={() => onFilter(value)}
            >
              {localize(mediaThreadFilterLabels[value])}
            </Button>
          ))}
        </div>
        <div className="relative w-full min-w-0 sm:w-auto sm:max-w-64 sm:flex-1">
          <Search
            className="text-text-secondary pointer-events-none absolute top-3 left-3 size-4"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label={localize('com_media_search')}
            placeholder={localize('com_media_search')}
            value={search}
            maxLength={catalog?.limits.maxTitleChars}
            onChange={(event) => onSearch(event.target.value)}
            variant="leading-icon"
          />
        </div>
      </div>
      {query.isLoading && (
        <div role="status" className={grid}>
          <span className="sr-only">{localize('com_media_loading')}</span>
          {Array.from({ length: columns * 2 }, (_, item) => (
            <div key={item} className="space-y-2">
              <Skeleton className="aspect-square rounded-xl" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      )}
      {query.isError && (
        <div role="alert">
          <EmptyState
            icon={Images}
            description={localize('com_media_load_failed')}
            action={
              <Button variant="outline" onClick={() => void query.refetch()}>
                {localize('com_ui_retry')}
              </Button>
            }
          />
        </div>
      )}
      {!query.isLoading && !query.isError && visible.length === 0 && (
        <EmptyState
          icon={Images}
          title={localize(filtered ? 'com_media_no_matches' : 'com_media_empty_title')}
          description={localize(filtered ? 'com_media_no_matches_hint' : 'com_media_empty')}
          action={
            filtered ? (
              <Button
                variant="outline"
                onClick={() => {
                  onSearch('');
                  onFilter('all');
                }}
              >
                {localize('com_media_show_all')}
              </Button>
            ) : (
              <Button onClick={onCreate}>{localize('com_media_create')}</Button>
            )
          }
          className="min-h-72"
        />
      )}
      <ul className={grid} data-testid="media-gallery" data-columns={columns}>
        {visible.map(({ tile, latest, model }) => {
          const cover = tile.thread?.cover;
          const pending = (tile.thread?.pendingJobCount ?? 0) > 0;
          const phase =
            pending && (!latest || settled.has(latest.phase)) ? 'running' : latest?.phase;
          const video = cover?.type.startsWith('video/') || latest?.operation === 'video.generate';
          const Icon = video ? Film : Image;
          const when = getMessageTimestamp(
            tile.thread?.updatedAt ?? tile.thread?.createdAt,
            i18n.language,
          );
          let emptyLabel = localize('com_media_open_thread');
          if (phase === 'failed') emptyLabel = localize('com_media_no_output');
          else if (phase === 'cancelled') emptyLabel = localize('com_media_phase_cancelled');
          else if (phase === 'requires_attention')
            emptyLabel = localize('com_media_phase_requires_attention');
          else if (pending) emptyLabel = localize('com_media_phase_running');
          return (
            <li key={tile.threadId} className="relative min-w-0">
              <button
                type="button"
                className="group focus-visible:after:ring-text-primary focus-visible:after:ring-offset-presentation block w-full rounded-xl text-start after:absolute after:inset-0 after:rounded-xl focus-visible:outline-hidden focus-visible:after:ring-2 focus-visible:after:ring-offset-2"
                onClick={() => onOpen(tile.threadId)}
                aria-label={localize('com_media_open_named', { title: tile.title })}
                aria-describedby={`${id}-${tile.threadId}`}
              >
                <span className="border-border-light bg-surface-secondary duration-theme-fast group-hover:border-border-medium relative block w-full overflow-hidden rounded-xl border shadow-xs transition-shadow group-hover:shadow-md motion-reduce:transition-none">
                  {cover ? (
                    <MediaPreview asset={cover} compact />
                  ) : (
                    <span className="text-text-secondary flex aspect-square flex-col items-center justify-center gap-3 p-4 text-center">
                      <Icon className="size-8" strokeWidth={1.25} aria-hidden="true" />
                      <span className="text-xs">{emptyLabel}</span>
                    </span>
                  )}
                  {video && cover && (
                    <span className="pointer-events-none absolute inset-0 grid place-items-center">
                      <span className="bg-surface-primary/80 text-text-primary grid size-10 place-items-center rounded-full shadow-md">
                        <Play className="ml-0.5 size-4" aria-hidden="true" />
                      </span>
                    </span>
                  )}
                </span>
              </button>
              <div className="mt-2 flex items-start gap-2 px-0.5">
                <span id={`${id}-${tile.threadId}`} className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-text-primary line-clamp-2 text-sm leading-5 font-medium">
                    {tile.title}
                  </span>
                  <span className="text-text-secondary flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
                    {phase && phase !== 'succeeded' ? (
                      <MediaStatus phase={phase} />
                    ) : (
                      !tile.thread && tile.receipt && <Chip>{localize('com_media_preparing')}</Chip>
                    )}
                    {model && <span className="truncate">{model}</span>}
                    {model && when && <span aria-hidden="true">·</span>}
                    {when && (
                      <time dateTime={when.iso} title={when.absolute} className="shrink-0">
                        {when.relative}
                      </time>
                    )}
                  </span>
                </span>
                {onDelete && tile.thread && (
                  <TooltipAnchor
                    description={localize('com_ui_delete')}
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="relative z-10 shrink-0"
                        aria-label={localize('com_media_delete_named', { title: tile.title })}
                        onClick={() => onDelete(tile.threadId)}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    }
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {query.hasNextPage && (
        <div className="flex flex-col items-center gap-2">
          {needle && (
            <p className="text-text-secondary text-xs">{localize('com_media_search_more')}</p>
          )}
          <Button
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {localize('com_media_more_threads')}
          </Button>
        </div>
      )}
    </section>
  );
}
