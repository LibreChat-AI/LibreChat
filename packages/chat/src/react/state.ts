import { QueryKeys } from 'librechat-data-provider';
import { hashQueryKey } from '@tanstack/react-query';
import type { Query, QueryClient, QueryCacheNotifyEvent } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import type { ChatState, ChatStatus, ChatConnection } from '../core';

export type ReactQueryChatStateOptions = {
  queryClient: QueryClient;
  /** The conversation the messages are cached under, `[QueryKeys.messages, key]`. */
  key: string;
} & (
  | { read?: undefined; write?: undefined; subscribe?: undefined }
  | {
      /** Reads the list instead of the key's cache entry, for a host that also reads other keys. */
      read: () => TMessage[] | undefined;
      /** Writes the list the same host store `read` reads, so a write is read back. */
      write: (messages: TMessage[]) => void;
      /**
       * Reports writes to that store which do not reach the key's cache entry. Without it, only
       * the key's cache entry is watched, which suits a host that writes the list there too.
       */
      subscribe?: (listener: () => void) => () => void;
    }
);

/** Cache events that add, drop or rewrite a query's data. */
const dataEvents = new Set<QueryCacheNotifyEvent['type']>(['added', 'removed', 'updated']);

/**
 * {@link ChatState} over the React Query message cache, so the chat and every reader of
 * `[QueryKeys.messages, key]` share one list while those readers move onto the chat.
 */
export class ReactQueryChatState implements ChatState {
  status: ChatStatus = 'ready';
  error: Error | undefined = undefined;
  connection: ChatConnection = 'idle';
  readonly queryHash: string;
  private readonly options: ReactQueryChatStateOptions;
  /** Set while the chat's own write runs, whose change the chat already announced. */
  private writing = false;
  /** Writes to a host store that never reach the key's cache entry, which `version` also counts. */
  private revision = 0;
  /** The cache entry and the data `version` last counted, and what it handed out for them. */
  private counted?: Query;
  private countedData?: unknown;
  private carried = 0;
  private reported?: number;
  /** Data events the cache reported for the key, and how many `version` last accounted for. */
  private changes = 0;
  private countedChanges = 0;
  /** The host store's list when `version` was last read, which a later subscription checks. */
  private countedRead?: TMessage[];

  constructor(options: ReactQueryChatStateOptions) {
    this.options = options;
    const queryKey = [QueryKeys.messages, options.key];
    /** The hash `setQueryData` files the key under, including a host's `queryKeyHashFn`. */
    this.queryHash =
      options.queryClient.defaultQueryOptions({ queryKey }).queryHash ?? hashQueryKey(queryKey);
  }

  get messages(): TMessage[] {
    const { read, queryClient } = this.options;
    if (read) {
      return read() ?? [];
    }
    return (queryClient.getQueryCache().get(this.queryHash)?.state.data as TMessage[]) ?? [];
  }

  /**
   * How many times the key's data was written. A stream frame can replace a message's content
   * on the same array, so a snapshot keyed by this count still sees that write.
   */
  get version(): number {
    const query = this.options.queryClient.getQueryCache().get(this.queryHash);
    const data = query?.state.data;
    let version = this.carried + (query?.state.dataUpdateCount ?? 0) + this.revision;
    const changed =
      query !== this.counted || data !== this.countedData || this.changes !== this.countedChanges;
    if (changed && this.reported != null && version <= this.reported) {
      /**
       * The write count restarts when an entry is created with initial data, removed and created
       * again, or reset, so any change the cache reported moves past the last version handed out.
       */
      this.carried += this.reported - version + 1;
      version = this.reported + 1;
    }
    this.counted = query;
    this.countedData = data;
    this.countedRead = this.options.read?.();
    this.countedChanges = this.changes;
    this.reported = version;
    return version;
  }

  replaceMessages(messages: TMessage[]): void {
    const { write, queryClient, key } = this.options;
    this.writing = true;
    try {
      if (write) {
        write(messages);
        this.revision += 1;
        return;
      }
      queryClient.setQueryData<TMessage[]>([QueryKeys.messages, key], messages);
    } finally {
      this.writing = false;
    }
  }

  /**
   * Reports writes to the key's data made outside the chat; the chat announces its own. The cache
   * notifies synchronously, including from inside another component's render when an observer
   * mounts with initial data, so the listener runs on the next microtask instead.
   */
  subscribe(listener: () => void): () => void {
    let active = true;
    /** One write can raise several cache events, such as `added` then `updated`; one call covers them. */
    let queued = false;
    const deliver = () => {
      if (this.writing || queued) {
        return;
      }
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (active) {
          listener();
        }
      });
    };
    const unsubscribe = this.options.queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryHash === this.queryHash && dataEvents.has(event.type)) {
        this.changes += 1;
        deliver();
      }
    });
    const { read, subscribe } = this.options;
    const unsubscribeHost = subscribe?.(() => {
      this.revision += 1;
      deliver();
    });
    if (unsubscribeHost && this.reported != null && read?.() !== this.countedRead) {
      /** The host store changed after `version` was read and before this subscription heard it. */
      this.revision += 1;
      deliver();
    }
    return () => {
      active = false;
      unsubscribe();
      unsubscribeHost?.();
    };
  }
}
