import { EModelEndpoint, resolveTurnLLMDeliveryPath } from 'librechat-data-provider';
import type {
  DirectContentEntry,
  DirectContentLimits,
  TurnFileConsumers,
} from 'librechat-data-provider';
import type { AgentAttachmentEndpointsByAgentId } from '~/agents/attachments';
import type { HistoryAllocationFile } from './history';
import type { NativeDeliveryAgent } from './turn';
import type { ServerRequest } from '~/types';
import {
  getAgentEntry,
  listAgentIds,
  isModelBoundAttachmentFile,
  measureModelBoundAttachment,
  resolveAgentAttachmentLimits,
  collectHistoricalAttachmentIds,
} from '~/agents/attachments';
import { getNativeValidationPolicy, getTurnReadingContext } from './turn';
import { assertModelBoundContent } from '~/middleware/modelBoundContent';
import { settleTurnFiles } from './settle';

interface MessageAttachmentClient<T, M> {
  options?: { agent?: NativeDeliveryAgent | null; abortController?: AbortController };
  processAttachments(
    message: M,
    files: T[],
    consumers?: TurnFileConsumers,
  ): Promise<T[] | undefined>;
  prepareTurnAttachments(files: T[], consumers?: TurnFileConsumers): Promise<T[]>;
  addFileContextToMessage(message: M, files: T[], consumers?: TurnFileConsumers): Promise<void>;
  admitPreparedAttachments?(files: T[], consumers?: TurnFileConsumers): Promise<T[]>;
}

/**
 * Waits for native validation before extracting text when an automatic document may fall back.
 * Other attachments keep their independent extraction and encoding in parallel. The settled
 * copies are admitted before their text reaches the message and returned for history/projection.
 */
export async function prepareMessageAttachments<T extends HistoryAllocationFile, M>({
  client,
  message,
  files,
  consumers,
  contextFiles = files,
}: {
  client: MessageAttachmentClient<T, M>;
  message: M;
  files: T[];
  consumers?: TurnFileConsumers;
  contextFiles?: T[];
}): Promise<T[] | undefined> {
  const agent = client.options?.agent;
  const signal = client.options?.abortController?.signal;
  const modeOf = getNativeValidationPolicy(agent);
  const context = getTurnReadingContext(agent?.deliveryRouting);
  const mayReject = files.some(
    (file) =>
      modeOf(file) === 'skip' &&
      (context?.judge(file).rejected != null ||
        resolveTurnLLMDeliveryPath(
          agent?.deliveryRouting ?? undefined,
          file,
          consumers ?? agent?.fileConsumers,
        ) === 'provider'),
  );
  if (!mayReject) {
    const [, processed] = await Promise.all([
      consumers == null
        ? client.addFileContextToMessage(message, contextFiles)
        : client.addFileContextToMessage(message, contextFiles, consumers),
      consumers == null
        ? client.processAttachments(message, files)
        : client.processAttachments(message, files, consumers),
    ]);
    return mergeAttachmentSurvivors(files, processed);
  }

  signal?.throwIfAborted();
  const processed = await client.processAttachments(message, files, consumers);
  signal?.throwIfAborted();
  let prepared = await client.prepareTurnAttachments(
    mergeAttachmentSurvivors(files, processed) ?? files,
    consumers,
  );
  if (prepared.some((file) => context?.judge(file).rejected != null)) {
    prepared = (await client.admitPreparedAttachments?.(prepared, consumers)) ?? prepared;
  }
  signal?.throwIfAborted();
  await client.addFileContextToMessage(message, prepared, consumers);
  return prepared;
}

/** Encoder metadata may be sparse; retain the authorized original record on surviving copies. */
function mergeAttachmentSurvivors<T extends HistoryAllocationFile>(
  files: T[],
  processed: T[] | undefined,
): T[] | undefined {
  if (processed == null) {
    return processed;
  }
  const originals = new Map(files.map((file) => [file.file_id, file]));
  return processed.map((file) => {
    const original = originals.get(file.file_id);
    return original == null || original === file
      ? file
      : { ...original, ...file, metadata: file.metadata ?? original.metadata };
  });
}

/** The host's already loaded attachment state and limits, shared by current/history/steering. */
interface NativeFallbackHost<T extends HistoryAllocationFile> {
  options: {
    req?: ServerRequest;
    endpoint?: string | null;
    endpointType?: string | null;
    agent?: NativeDeliveryAgent & { endpoint?: string | null };
    attachments?: T[] | Promise<T[]>;
    abortController?: AbortController;
  };
  authorizedHistoricalFiles?: Map<string, T>;
  authorizedHistoricalReplayFiles?: Map<string, T>;
  message_file_map?: Record<string, T[]>;
  modelBoundCurrentFiles?: T[];
  modelBoundHistoricalSteerFiles?: T[];
  turnSharedAttachmentFiles?: T[];
  turnAggregateOnlyAttachmentFiles?: T[];
  turnScopedAttachmentsByAgentId?: Map<string, T[]>;
  turnAttachmentEndpointsByAgentId?: AgentAttachmentEndpointsByAgentId;
  turnHistoricalAttachmentIds?: ReadonlySet<string>;
  admittedSteerAttachments?: Map<string, T[]>;
  attachmentMemoryContext?: { attachments?: T[] };
  assertTurnAttachmentLimits?(shared: T[], scoped: T[]): void;
  getConversationAgents?(): Iterable<
    | (NativeDeliveryAgent & {
        currentRequestAttachments?: T[];
        requestAttachments?: T[];
        attachments?: T[];
      })
    | null
    | undefined
  >;
}

const admissions = new WeakMap<object, Promise<void>>();

/** Keeps the already admitted historical replay topology available before message encoding. */
export function retainNativeAttachmentTopology<T extends HistoryAllocationFile>(
  host: NativeFallbackHost<T>,
  shared: T[],
  scoped: Map<string, T[]>,
  endpoints: AgentAttachmentEndpointsByAgentId,
): void {
  host.turnSharedAttachmentFiles = shared;
  host.turnScopedAttachmentsByAgentId = scoped;
  host.turnAttachmentEndpointsByAgentId = endpoints;
}

/**
 * Shared candidates spend the same footprint in every agent's payload. Reserve each endpoint's
 * own scoped content and the global combined context separately, then use the smallest remaining
 * allowance per dimension. Keeping that scope's positive limit and charged entries also handles
 * an exactly exhausted dimension without treating a remaining zero as unlimited.
 */
function reserveFallbackCapacity<T extends HistoryAllocationFile>(
  host: NativeFallbackHost<T>,
  committed: T[],
  scoped: Map<string, T[]>,
  historicalFileIds: ReadonlySet<string>,
): { limits: DirectContentLimits; committedEntries: DirectContentEntry[] } {
  const req = host.options.req;
  const endpoint = host.options.agent?.endpoint ?? host.options.endpoint;
  const endpointType = host.options.endpointType;
  const measureCommitted = (files: T[]): DirectContentEntry[] => {
    const seen = new Set<string>();
    return files.map((file) => {
      const measured = measureModelBoundAttachment(file);
      const counts =
        measured.counts && !historicalFileIds.has(file.file_id) && !seen.has(file.file_id);
      seen.add(file.file_id);
      return { ...measured, counts };
    });
  };
  const budgets: Array<{ limits: DirectContentLimits; entries: DirectContentEntry[] }> = [
    {
      limits: resolveAgentAttachmentLimits({
        req,
        endpoint,
        endpointType,
        enforceAttachmentCount: false,
        useGlobalContextSizeLimit: true,
      }),
      entries: measureCommitted([
        ...committed,
        ...(host.turnAggregateOnlyAttachmentFiles ?? []),
        ...[...scoped.values()].flat(),
      ]),
    },
  ];
  const endpoints = host.turnAttachmentEndpointsByAgentId;
  const agentIds = new Set([...scoped.keys(), ...listAgentIds(endpoints)]);
  const appendEndpointBudget = (agentId?: string): void => {
    const selectedEndpoint = agentId == null ? undefined : getAgentEntry(endpoints, agentId);
    budgets.push({
      limits: resolveAgentAttachmentLimits({
        req,
        endpoint: selectedEndpoint?.endpoint ?? endpoint ?? EModelEndpoint.agents,
        endpointType: selectedEndpoint?.endpointType ?? endpointType,
      }),
      entries: measureCommitted([
        ...committed,
        ...(agentId == null ? [] : (scoped.get(agentId) ?? [])),
      ]),
    });
  };
  if (agentIds.size === 0) {
    appendEndpointBudget();
  } else {
    for (const agentId of agentIds) appendEndpointBudget(agentId);
  }
  const limits: DirectContentLimits = {};
  const committedEntries: DirectContentEntry[] = [];
  for (const dimension of ['count', 'bytes', 'textChars'] as const) {
    let remaining = Infinity;
    let selected: (typeof budgets)[number] | undefined;
    for (const budget of budgets) {
      const limit = budget.limits[dimension];
      if (!limit) continue;
      const spent = budget.entries.reduce(
        (sum, entry) => sum + (dimension === 'count' ? Number(entry.counts) : entry[dimension]),
        0,
      );
      if (limit - spent < remaining) {
        remaining = limit - spent;
        selected = budget;
      }
    }
    if (selected == null) continue;
    limits[dimension] = selected.limits[dimension];
    committedEntries.push(
      ...selected.entries.map((entry) => ({
        fileId: entry.fileId,
        counts: dimension === 'count' && entry.counts,
        bytes: dimension === 'bytes' ? entry.bytes : 0,
        textChars: dimension === 'textChars' ? entry.textChars : 0,
      })),
    );
  }
  return { limits, committedEntries };
}

/**
 * Admits text selected after native rejection against the host's complete loaded shared/scoped
 * set. Original types/bytes passed endpoint admission before encoding; this rechecks the added
 * text and the aggregate before replacing the turn copies used by subsequent projection.
 */
async function admitFallback<T extends HistoryAllocationFile>(
  host: NativeFallbackHost<T>,
  files: T[],
  consumers: TurnFileConsumers | undefined,
): Promise<T[]> {
  const signal = host.options.abortController?.signal;
  signal?.throwIfAborted();
  const replacements = new Map(files.map((file) => [file.file_id, file]));
  const replace = (file: T): T => replacements.get(file.file_id) ?? file;
  const current = (await host.options.attachments) ?? [];
  const historical = [...(host.authorizedHistoricalFiles?.values() ?? [])];
  const shared = (host.turnSharedAttachmentFiles ?? [...historical, ...current]).map(replace);
  const sharedIds = new Set(shared.map((file) => file.file_id));
  for (const file of files) {
    if (!sharedIds.has(file.file_id)) {
      shared.push(file);
      sharedIds.add(file.file_id);
    }
  }
  const historicalFileIds =
    host.turnHistoricalAttachmentIds ?? collectHistoricalAttachmentIds(historical, current);
  const req = host.options.req;
  const scoped = host.turnScopedAttachmentsByAgentId ?? new Map<string, T[]>();
  const candidates = files.filter((file) => file.llmDeliveryPath === 'text');
  const candidateIds = new Set(candidates.map((file) => file.file_id));
  const copies = new Map<string, number>();
  for (const file of shared) {
    copies.set(file.file_id, (copies.get(file.file_id) ?? 0) + 1);
  }
  const { limits, committedEntries } = reserveFallbackCapacity(
    host,
    shared.filter((file) => !candidateIds.has(file.file_id)),
    scoped,
    historicalFileIds,
  );
  const prepared = await settleTurnFiles({
    routing: host.options.agent?.deliveryRouting ?? undefined,
    consumers: consumers ?? host.options.agent?.fileConsumers,
    files,
    allocation: {
      requestFileIds: candidates.map((file) => file.file_id),
      limits,
      measure: (file) => {
        const measured = measureModelBoundAttachment(file);
        const multiplicity = copies.get(file.file_id) ?? 1;
        return {
          ...measured,
          bytes: measured.bytes * multiplicity,
          textChars: measured.textChars * multiplicity,
          counts: measured.counts && !historicalFileIds.has(file.file_id),
        };
      },
      committedEntries,
      scope: 'history',
    },
    flush: true,
    signal,
  });
  signal?.throwIfAborted();
  for (const file of prepared) {
    replacements.set(file.file_id, file);
  }
  const admittedShared = shared.map(replace).filter(isModelBoundAttachmentFile);
  host.assertTurnAttachmentLimits?.(
    [...admittedShared, ...(host.turnAggregateOnlyAttachmentFiles ?? [])],
    [...scoped.values()].flat(),
  );
  assertModelBoundContent({
    filters: req?.config?.filters,
    files: prepared.filter(isModelBoundAttachmentFile).map((file) => ({
      ...file,
      source: file.source ?? undefined,
    })),
  });

  const replaceMap = (map?: Map<string, T>): void => {
    for (const [fileId, file] of map ?? []) {
      map?.set(fileId, replace(file));
    }
  };
  replaceMap(host.authorizedHistoricalFiles);
  replaceMap(host.authorizedHistoricalReplayFiles);
  const messageFiles = host.message_file_map;
  if (messageFiles != null) {
    for (const [messageId, attachments] of Object.entries(messageFiles)) {
      messageFiles[messageId] = attachments.map(replace).filter(isModelBoundAttachmentFile);
    }
  }
  host.modelBoundCurrentFiles = host.modelBoundCurrentFiles?.map(replace);
  host.modelBoundHistoricalSteerFiles = host.modelBoundHistoricalSteerFiles?.map(replace);
  for (const [steerId, reserved] of host.admittedSteerAttachments ?? []) {
    host.admittedSteerAttachments?.set(steerId, reserved.map(replace));
  }
  if (host.attachmentMemoryContext?.attachments != null) {
    const memoryFiles = host.attachmentMemoryContext.attachments;
    for (let index = 0; index < memoryFiles.length; index++) {
      memoryFiles[index] = replace(memoryFiles[index]);
    }
  }
  if (host.turnSharedAttachmentFiles != null) {
    const sharedFiles = host.turnSharedAttachmentFiles;
    sharedFiles.length = shared.length;
    for (let index = 0; index < shared.length; index++) {
      sharedFiles[index] = replace(shared[index]);
    }
  }
  if (host.options.attachments != null) {
    host.options.attachments = current.map(replace);
  }
  const primary = getTurnReadingContext(host.options.agent?.deliveryRouting);
  const overflowIds = prepared
    .filter((file) => primary?.judge(file).overflow)
    .map((file) => file.file_id);
  for (const agent of host.getConversationAgents?.() ?? []) {
    if (agent == null) {
      continue;
    }
    agent.currentRequestAttachments = agent.currentRequestAttachments?.map(replace);
    agent.requestAttachments = agent.requestAttachments?.map(replace);
    agent.attachments = agent.attachments?.map(replace);
    getTurnReadingContext(agent.deliveryRouting)?.addOverflow(overflowIds);
  }
  return prepared;
}

/** Serializes allocation for parallel historical messages that spend one turn's text budget. */
export function admitNativeFallbackAttachments<T extends HistoryAllocationFile>(
  host: NativeFallbackHost<T>,
  files: T[],
  consumers?: TurnFileConsumers,
): Promise<T[]> {
  const previous = admissions.get(host) ?? Promise.resolve();
  const admitted = previous.then(() => admitFallback(host, files, consumers));
  const settled = admitted.then(
    () => undefined,
    () => undefined,
  );
  admissions.set(host, settled);
  return admitted;
}
