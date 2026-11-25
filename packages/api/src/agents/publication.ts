import type { IAgentEventActorContextMeta } from '@librechat/data-schemas';

export type ContextMetaWriter = (contextMeta: IAgentEventActorContextMeta) => Promise<void>;

export interface ContextMetaPublisherOptions {
  /** Durable write of one record, e.g. the job metadata writer. */
  write: ContextMetaWriter;
  /** Called once per publication whose every attempt failed. */
  onFailure?: (error: unknown, contextMeta: IAgentEventActorContextMeta) => void;
  /** Write attempts per publication, including the first. */
  attempts?: number;
  /** Backoff before the second attempt, doubled for each later one. */
  retryDelayMs?: number;
  delay?: (ms: number) => Promise<void>;
}

export interface ContextMetaPublisher {
  /**
   * Publishes a record unless it equals the latest publication, in which case
   * the caller shares that publication's promise. Distinct records are written
   * in call order, each after the previous publication settles, so the store's
   * last-writer-wins keeps the newest snapshot. Never rejects.
   */
  publish(contextMeta: IAgentEventActorContextMeta): Promise<void>;
  /** Whether the job may carry a record: a write has committed, or one is in flight. */
  readonly hasPublished: boolean;
}

type Publication = {
  serialized: string;
  promise: Promise<void>;
};

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function writeWithRetry(
  contextMeta: IAgentEventActorContextMeta,
  options: Required<
    Pick<ContextMetaPublisherOptions, 'write' | 'attempts' | 'retryDelayMs' | 'delay'>
  >,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    try {
      await options.write(contextMeta);
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < options.attempts) {
        await options.delay(options.retryDelayMs * 2 ** attempt);
      }
    }
  }
  throw lastError;
}

/**
 * Coordinates the durable publication of a run's compact context meta onto its
 * job: one write per distinct record, shared by equal concurrent callers,
 * ordered so the newest record wins, retried on transient failure. A caller
 * that awaits `publish` before its model call therefore knows the job carries
 * the record that describes that call. An exhausted publication is reported
 * through `onFailure` and forgotten, so the next snapshot writes again, while
 * a record committed earlier still counts as published so that a later neutral
 * snapshot overwrites it instead of leaving it on the job.
 */
export function createContextMetaPublisher(
  options: ContextMetaPublisherOptions,
): ContextMetaPublisher {
  const {
    write,
    onFailure,
    attempts = DEFAULT_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    delay = sleep,
  } = options;
  let latest: Publication | undefined;
  let committed = false;
  return {
    get hasPublished() {
      return committed || latest != null;
    },
    publish(contextMeta) {
      const serialized = JSON.stringify(contextMeta);
      if (latest?.serialized === serialized) {
        return latest.promise;
      }
      const previous = latest?.promise ?? Promise.resolve();
      const publication: Publication = { serialized, promise: Promise.resolve() };
      publication.promise = previous
        .then(() => writeWithRetry(contextMeta, { write, attempts, retryDelayMs, delay }))
        .then(() => {
          committed = true;
        })
        .catch((error: unknown) => {
          if (latest === publication) {
            latest = undefined;
          }
          onFailure?.(error, contextMeta);
        });
      latest = publication;
      return publication.promise;
    },
  };
}

export type RunContextMetaSelection = {
  /** True for a snapshot of the running graph; false for the pre-run seed publish. */
  live: boolean;
  /** The run's own compact state, when it has any. */
  captured: IAgentEventActorContextMeta | undefined;
  /** The state inherited from the parent response. */
  inherited: IAgentEventActorContextMeta | undefined;
  hasPublished: boolean;
  getEncoding: () => string;
};

/**
 * Chooses what a publication should carry: the run's own state when it has
 * any, the inherited seed before the run exists, and otherwise a neutral
 * record (ratio 1, no tier) once something has been published, since a
 * running job's fields cannot be deleted through the metadata writer and a
 * neutral record seeds the next turn exactly as no record would. A fresh
 * conversation's first neutral snapshot publishes nothing.
 */
export function selectRunContextMetaToPublish(
  selection: RunContextMetaSelection,
): IAgentEventActorContextMeta | undefined {
  const { live, captured, inherited, hasPublished } = selection;
  const contextMeta = captured ?? (live ? undefined : inherited);
  if (contextMeta != null) {
    return contextMeta;
  }
  if (!live || !hasPublished) {
    return undefined;
  }
  return { calibrationRatio: 1, encoding: selection.getEncoding() };
}
