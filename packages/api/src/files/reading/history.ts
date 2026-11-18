import { EModelEndpoint } from 'librechat-data-provider';
import type {
  TFile,
  DirectContentEntry,
  DirectContentLimits,
  TurnFileConsumers,
} from 'librechat-data-provider';
import type { AgentAttachmentEndpointsByAgentId } from '~/agents/attachments';
import type { TurnReadingAgent } from './diagnostics';
import type { TurnReadingFile } from './turn';
import type { ServerRequest } from '~/types';
import {
  collectFileIds,
  listAgentEntries,
  isModelBoundAttachmentFile,
  measureModelBoundAttachment,
  resolveAgentAttachmentLimits,
  collectHistoricalAttachmentIds,
} from '~/agents/attachments';
import { filterFilesByEndpointRuntimeConfig } from '~/files/filter';
import { getTurnReadingContext } from './turn';
import { settleTurnFiles } from './settle';

/** A turn copy of an attachment the endpoint's file policy can judge, as AgentClient holds it. */
export type HistoryAllocationFile = TurnReadingFile & Pick<TFile, 'bytes' | 'type'>;

/** The endpoint whose attachment policy and limits hold the turn's shared attachments. */
interface AttachmentScope {
  req?: Pick<ServerRequest, 'config'>;
  endpoint: string;
  endpointType?: string | null;
  consumers?: TurnFileConsumers | null;
}

export interface TurnAttachmentsWithHistoryParams<T extends HistoryAllocationFile> {
  agent: Pick<TurnReadingAgent, 'id' | 'deliveryRouting' | 'fileConsumers'>;
  /** The replayed files the conversation's history sends again, as this turn decided them. */
  historical: readonly T[];
  /** The request's attachments in submission order; earlier files are admitted first. */
  current: T[];
  req?: Pick<ServerRequest, 'config'>;
  /** The endpoint the turn's attachment checks run against; the agents endpoint when absent. */
  endpoint?: string | null;
  endpointType?: string | null;
  /**
   * Every agent the topology check holds the shared set to, with its endpoint, so the
   * allocation uses the strictest limits any of those checks applies.
   */
  endpointsByAgentId?: AgentAttachmentEndpointsByAgentId;
  /** Receives the re-decided request attachments, only when the allocation moved one. */
  onAllocated?: (files: T[]) => void;
  signal?: AbortSignal;
}

export interface RetainedContextAllocationParams<T extends HistoryAllocationFile>
  extends Omit<TurnAttachmentsWithHistoryParams<T>, 'historical'> {
  /** The conversation's setting; with files resent, history replay already allocated the turn. */
  resendFiles?: boolean | null;
  /** The extracted text earlier messages keep in place of their files. */
  retained: readonly T[];
}

/** The tighter of two limits, where a missing or zero limit leaves the dimension unlimited. */
const tighter = (first?: number, second?: number): number | undefined => {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  return Math.min(first, second);
};

const tightenLimits = (
  first: DirectContentLimits,
  second: DirectContentLimits,
): DirectContentLimits => ({
  count: tighter(first.count, second.count),
  bytes: tighter(first.bytes, second.bytes),
  textChars: tighter(first.textChars, second.textChars),
});

/**
 * The limits every check on the shared set enforces together: the global context limits of
 * `assertTurnAttachmentLimits`, and each reachable agent's own count allowance and endpoint
 * aggregate, which the topology check applies to the same set. Agent-scoped context injections
 * are counted after this allocation, so they can still exceed these limits.
 */
function resolveSharedLimits(
  { req, endpoint, endpointType }: AttachmentScope,
  endpointsByAgentId?: AgentAttachmentEndpointsByAgentId,
): DirectContentLimits {
  const turn = resolveAgentAttachmentLimits({
    req,
    endpoint,
    endpointType,
    enforceAttachmentCount: false,
    useGlobalContextSizeLimit: true,
  });
  return [{ endpoint, endpointType }, ...listAgentEntries(endpointsByAgentId)]
    .map((agentEndpoint) =>
      resolveAgentAttachmentLimits({
        req,
        endpoint: agentEndpoint.endpoint,
        endpointType: agentEndpoint.endpointType,
      }),
    )
    .reduce(tightenLimits, turn);
}

/** The files the endpoint's runtime policy keeps, as AgentClient selects model-bound files. */
const selectCompatible = <T extends HistoryAllocationFile>(
  files: T[],
  { req, endpoint, endpointType, consumers }: AttachmentScope,
): T[] =>
  filterFilesByEndpointRuntimeConfig(req?.config, {
    files,
    endpoint,
    endpointType,
    skipTotalSizeLimit: true,
    preserveTextSources: true,
    consumers,
  });

const uncharged = (file: HistoryAllocationFile): DirectContentEntry => ({
  fileId: file.file_id,
  counts: false,
  bytes: 0,
  textChars: 0,
});

/**
 * Charges replayed content as the shared-set checks charge `[...history, ...current]`: every copy
 * spends the context budgets, and a file counts once, at its first copy, unless history alone
 * replays it.
 */
function chargeReplayed(
  measured: ReadonlyArray<{ file: HistoryAllocationFile; entry: DirectContentEntry }>,
  historyOnlyIds: ReadonlySet<string>,
): DirectContentEntry[] {
  const firstCopy = new Map<string, number>();
  measured.forEach(({ file }, index) => {
    if (!firstCopy.has(file.file_id)) {
      firstCopy.set(file.file_id, index);
    }
  });
  return measured.map(({ file, entry }, index) => ({
    ...entry,
    counts:
      entry.counts && firstCopy.get(file.file_id) === index && !historyOnlyIds.has(file.file_id),
  }));
}

/**
 * Allocates the request's direct content after the turn's replayed history, so the history
 * checks AgentClient runs next cannot refuse what the automatic policy admitted. The compatible
 * model-bound history is charged first, then every current file the policy cannot move; the
 * files the policy reads natively or as text are admitted in submission order while they fit.
 * A file that does not fit is recorded as overflow and decided again, so it moves to File Search
 * or Run Code, or is left unavailable, instead of failing the turn. A current file history
 * replays as well is committed with it rather than allocated, since history sends it anyway.
 * Returns `current` itself unless the agent's turn reads under the automatic policy and a file
 * moved.
 */
export async function allocateTurnAttachmentsWithHistory<T extends HistoryAllocationFile>({
  agent,
  historical,
  current,
  req,
  endpoint,
  endpointType,
  endpointsByAgentId,
  onAllocated,
  signal,
}: TurnAttachmentsWithHistoryParams<T>): Promise<T[]> {
  const routing = agent.deliveryRouting;
  if (getTurnReadingContext(routing)?.policy !== 'automatic' || current.length === 0) {
    return current;
  }
  const scope: AttachmentScope = {
    req,
    endpoint: endpoint ?? EModelEndpoint.agents,
    endpointType,
    consumers: agent.fileConsumers,
  };
  const committedHistory = selectCompatible(historical.filter(isModelBoundAttachmentFile), scope);
  const replayedIds = collectFileIds(committedHistory);
  const compatibleFileIds = collectFileIds(selectCompatible(current, scope));
  const measureCurrent = (file: T): DirectContentEntry =>
    compatibleFileIds.has(file.file_id) ? measureModelBoundAttachment(file) : uncharged(file);
  const replayed = chargeReplayed(
    [
      ...committedHistory.map((file) => ({ file, entry: measureModelBoundAttachment(file) })),
      ...current
        .filter((file) => replayedIds.has(file.file_id))
        .map((file) => ({ file, entry: measureCurrent(file) })),
    ],
    collectHistoricalAttachmentIds(committedHistory, current),
  );
  const allocated = await settleTurnFiles({
    routing,
    consumers: agent.fileConsumers,
    files: current,
    allocation: {
      requestFileIds: current
        .filter((file) => !replayedIds.has(file.file_id))
        .map((file) => file.file_id),
      limits: resolveSharedLimits(scope, endpointsByAgentId),
      measure: measureCurrent,
      committedEntries: replayed,
      agentId: agent.id,
      scope: 'history',
    },
    flush: true,
    signal,
  });
  if (allocated !== current) {
    onAllocated?.(allocated);
  }
  return allocated;
}

/**
 * Allocates the request against the extracted text earlier messages retain when the conversation
 * does not resend files, which the turn check charges in their place. With files resent, history
 * replay ran {@link allocateTurnAttachmentsWithHistory} already, so this returns `current`.
 */
export function allocateTurnAttachmentsWithRetainedContext<T extends HistoryAllocationFile>({
  resendFiles,
  retained,
  ...params
}: RetainedContextAllocationParams<T>): Promise<T[]> {
  if (resendFiles !== false) {
    return Promise.resolve(params.current);
  }
  return allocateTurnAttachmentsWithHistory({ ...params, historical: retained });
}
