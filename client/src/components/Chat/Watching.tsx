import { memo, useEffect, useRef } from 'react';
import { isAxiosError } from 'axios';
import { Eye, Pause, X } from 'lucide-react';
import { disabledInkClasses } from '@librechat/client';
import { Constants, Permissions, PermissionTypes } from 'librechat-data-provider';
import type { WatchPause } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useEventWatches, useStopWatch } from '~/data-provider/Events';
import { useLocalize, useHasAccess } from '~/hooks';
import { cn } from '~/utils';

/** Why a watch continues nothing for now, as its owner reads it. */
const pauses: Record<WatchPause, TranslationKeys> = {
  subscription_off: 'com_ui_events_watch_paused_off',
  watching_off: 'com_ui_events_watch_paused_watching',
  unbound: 'com_ui_events_watch_paused_unbound',
};

/**
 * A 404 is not a failure here: stopping a watch that already ended leaves it gone either way,
 * and a server without the watch routes has no watches to list.
 */
const notFound = (error: unknown) => isAxiosError(error) && error.response?.status === 404;

/**
 * The pull requests this conversation follows, each with a control to stop following it.
 * Renders nothing until there is one: a conversation that follows nothing looks as before.
 */
function Watching({
  conversationId,
  isSubmitting,
}: {
  conversationId?: string | null;
  isSubmitting: boolean;
}) {
  const localize = useLocalize();
  const allowed = useHasAccess({
    permissionType: PermissionTypes.AGENT_EVENTS,
    permission: Permissions.USE,
  });
  const id = conversationId ?? undefined;
  const routed = id != null && id !== Constants.NEW_CONVO;
  const list = useEventWatches(id, allowed && routed);
  const { data: watches, refetch } = list;
  const stop = useStopWatch(id);

  /* A turn is what starts or stops a watch, so the list is read again when one ends. */
  const running = useRef(isSubmitting);
  useEffect(() => {
    const finished = running.current && !isSubmitting;
    running.current = isSubmitting;
    if (finished && allowed && routed) {
      void refetch();
    }
  }, [isSubmitting, allowed, routed, refetch]);

  if (!allowed || !routed) {
    return null;
  }
  /* A conversation that follows pull requests must not look like one that follows none when
     the list fails: the owner could not see or stop them. Loading and empty stay silent. */
  if (list.isError && watches == null && !notFound(list.error)) {
    return (
      <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 pb-2 text-xs xl:max-w-4xl">
        <p role="alert" className="text-text-destructive">
          {localize('com_ui_events_watches_error')}
        </p>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={list.isFetching}
          className={cn(
            'text-text-primary hover:bg-surface-hover focus-visible:ring-ring-primary rounded-md px-2 py-0.5 underline focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50',
            disabledInkClasses,
          )}
        >
          {localize('com_ui_retry')}
        </button>
      </div>
    );
  }
  if (watches == null || watches.length === 0) {
    return null;
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-2 xl:max-w-4xl">
      <ul aria-label={localize('com_ui_events_watches')} className="flex flex-wrap gap-2">
        {watches.map((watch) => {
          // A paused watch is named, not claimed: nothing about it arrives until it resumes.
          const text =
            watch.paused == null
              ? localize('com_ui_events_watching', { 0: watch.label })
              : watch.label;
          const Icon = watch.paused == null ? Eye : Pause;
          return (
            <li
              key={watch.id}
              className="border-border-light bg-surface-secondary text-text-secondary inline-flex max-w-full items-center gap-1.5 rounded-full border py-0.5 pr-0.5 pl-2.5 text-xs"
            >
              <Icon className="size-3.5 shrink-0" aria-hidden="true" />
              {watch.url ? (
                <a
                  href={watch.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-text-primary truncate hover:underline"
                >
                  {text}
                </a>
              ) : (
                <span className="text-text-primary truncate">{text}</span>
              )}
              {watch.paused != null && (
                <span className="truncate">{localize(pauses[watch.paused])}</span>
              )}
              <button
                type="button"
                aria-label={localize('com_ui_events_watch_stop', { 0: watch.label })}
                disabled={stop.isLoading && stop.variables === watch.id}
                onClick={() => stop.mutate(watch.id)}
                className={cn(
                  'hover:bg-surface-hover focus-visible:ring-ring-primary text-text-secondary rounded-full p-1 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50',
                  disabledInkClasses,
                )}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      {stop.isError && !notFound(stop.error) && (
        <p role="alert" className="text-text-destructive mt-1 text-xs">
          {localize('com_ui_events_watch_stop_error')}
        </p>
      )}
    </div>
  );
}

/* The screen around it redraws with every streamed frame; this changes only with its props. */
export default memo(Watching);
