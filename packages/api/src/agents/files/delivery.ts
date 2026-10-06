import {
  mergeFileConfig,
  decideFileReading,
  getEndpointFileConfig,
  resolveUseResponsesApi,
  resolveLLMDeliveryPolicy,
  getCustomEndpointProvider,
  isSpeechProviderConfigured,
  resolveTurnLLMDeliveryPath,
  hasInferredLLMDeliveryPath,
} from 'librechat-data-provider';
import type {
  TDefaultLLMDeliveryPath,
  TurnDeliveryRouting,
  TurnDeliveryFile,
  TurnFileConsumers,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { TurnReadingFile, TextRequest, TurnReader } from '~/files/reading/turn';
import {
  withDerivedText,
  needsDerivedText,
  deriveRequestedText,
  getTurnReadingContext,
} from '~/files/reading/turn';
import { collectModelBoundHistoricalFileIdState } from '~/middleware/modelBoundContent';
import { filterFilesByEndpointRuntimeConfig } from '~/files/filter';
import { getAgentEntry } from '~/agents/attachments';

/** The app config a turn's attachment routing reads. */
export type TurnDeliveryConfig = Pick<AppConfig, 'fileConfig' | 'speech' | 'endpoints'>;

/** The fields of an agent that route its attachments. */
export interface TurnDeliveryAgent {
  provider: string;
  /** The endpoint name initialization records before it swaps `provider` for the backing
   *  client; an agent loaded without one is routed by its provider. */
  endpoint?: string | null;
  /** The Responses API setting the turn runs on, once initialization has decided it. */
  model_parameters?: { useResponsesApi?: boolean } | null;
}

/**
 * Settles how the agent running a turn receives its attachments.
 *
 * Read once, after initialization has resolved the backing provider and the Responses API
 * decision: the file policy is the one configured under the endpoint's own name, the media
 * dialect is the one its config declares rather than the client family it runs as, and the
 * Responses setting is the one the model call uses. Every reader of a turn route consumes the
 * returned value, so delivery, steering and child run-file encoding cannot answer differently.
 */
export function resolveTurnDeliveryRouting({
  agent,
  config,
}: {
  agent: TurnDeliveryAgent;
  config?: TurnDeliveryConfig;
}): TurnDeliveryRouting {
  const endpoint = agent.endpoint ?? agent.provider;
  const fileConfig = mergeFileConfig(config?.fileConfig);
  return {
    fileConfig,
    endpointConfig: getEndpointFileConfig({ fileConfig, endpoint }),
    endpoint,
    endpointProvider: getCustomEndpointProvider(config?.endpoints?.custom, endpoint),
    useResponsesApi: resolveUseResponsesApi(agent.model_parameters?.useResponsesApi),
    sttConfigured: isSpeechProviderConfigured(config?.speech?.stt),
  };
}

/** The routing an agent's turn delivers by and the tools judged as its readers. */
export interface TurnDeliveryInputs {
  routing?: TurnDeliveryRouting;
  consumers?: TurnFileConsumers;
}

const isAutomaticRouting = (routing?: TurnDeliveryRouting): boolean =>
  resolveLLMDeliveryPolicy(routing?.endpointConfig) === 'automatic';

const withDeliveryPath = <T extends TurnDeliveryFile>(
  file: T,
  llmDeliveryPath: TDefaultLLMDeliveryPath | undefined,
): T =>
  llmDeliveryPath == null || llmDeliveryPath === file.llmDeliveryPath
    ? file
    : { ...file, llmDeliveryPath };

/** Maps each file, returning the input array itself when no file was replaced. */
function mapTurnCopies<T extends TurnDeliveryFile>(files: T[], map: (file: T) => T): T[] {
  let changed = false;
  const result = files.map((file) => {
    const next = map(file);
    changed ||= next !== file;
    return next;
  });
  return changed ? result : files;
}

/** Materialize the exact turn route before admission without mutating stored records. */
export function applyTurnDelivery<T extends TurnDeliveryFile>(
  files: T[],
  { routing, consumers }: TurnDeliveryInputs,
): T[] {
  if (routing == null) {
    return files;
  }
  return mapTurnCopies(files, (file) =>
    hasInferredLLMDeliveryPath(file)
      ? withDeliveryPath(file, resolveTurnLLMDeliveryPath(routing, file, consumers))
      : file,
  );
}

/**
 * The turn copies as classic routing would deliver them, for the full-set content checks.
 *
 * Inspection coverage keys on the text route, so a file the automatic policy hands to a tool
 * instead of the prompt would otherwise lose the text coverage classic routing gives it, and
 * rerouting must not change what is inspected. Returns its input under classic routing and
 * whenever no copy differs; stored records and the input copies are never changed.
 */
export function toClassicInspectionView<T extends TurnDeliveryFile>(
  files: T[],
  routing?: TurnDeliveryRouting,
  consumers?: TurnFileConsumers,
): T[] {
  if (!isAutomaticRouting(routing)) {
    return files;
  }
  return mapTurnCopies(files, (file) => {
    const { automatic, classicPath } = decideFileReading({ routing, file, consumers });
    return automatic ? withDeliveryPath(file, classicPath) : file;
  });
}

/** Charges text a referenced inferred tool file may have been delivered as fallback. */
const chargeRetainedFallbackText = <T extends TurnDeliveryFile>(file: T): T =>
  hasInferredLLMDeliveryPath(file) && file.llmDeliveryPath === 'none' && file.text
    ? { ...file, llmDeliveryPath: 'text' }
    : file;

/**
 * Checkpoints replay already encoded content; current tools and policy cannot remove it.
 * A referenced inferred tool file carrying extracted text may have been delivered as fallback.
 * Charge that text conservatively even if fallback was since disabled. Explicit destinations
 * and records predating routing keep their existing accounting; no stored record is changed.
 *
 * Under the automatic policy a file it reads is charged by the resuming agent's own decision,
 * so text that policy withheld for a tool is not charged; the conservative charge still covers
 * every file the decision leaves on its classic route.
 */
export function applyCheckpointDelivery<T extends TurnDeliveryFile>(
  files: T[],
  { routing, consumers }: TurnDeliveryInputs = {},
): T[] {
  if (!isAutomaticRouting(routing)) {
    return files.map(chargeRetainedFallbackText);
  }
  return files.map((file) => {
    const reading = decideFileReading({ routing, file, consumers });
    return reading.automatic
      ? withDeliveryPath(file, reading.path)
      : chargeRetainedFallbackText(file);
  });
}

/** A receiver of the conversation's scoped attachments, by the routing its turn settled. */
export interface ScopedTurnAgent {
  agentId: string;
  agent: {
    deliveryRouting?: TurnDeliveryRouting;
    fileConsumers?: TurnFileConsumers;
  };
}

/** The inputs each handoff receiver's scoped attachment context is resolved from. */
export interface ScopedTurnAttachmentParams<T extends TurnDeliveryFile & { file_id: string }> {
  agents: readonly ScopedTurnAgent[];
  /** Only the primary/handoff graph shares root conversation files. */
  sharedConversationAgentIds: readonly string[];
  resendFiles?: boolean;
  messages: Parameters<typeof collectModelBoundHistoricalFileIdState>[0];
  historicalFiles?: ReadonlyMap<string, T>;
  requestAttachments: readonly T[];
  sharedRunAttachmentIds: ReadonlySet<string>;
  attachmentsByAgentId?: Map<string, T[]> | Record<string, T[]>;
  /**
   * The candidates {@link prepareScopedTurnCandidates} already collected from these same inputs,
   * so the retained messages are not walked a second time.
   */
  candidates?: ReadonlyMap<string, T>;
}

/** The inputs that pick the candidates, with the narrowing ones optional. */
type ScopedCandidateInputs<T extends TurnDeliveryFile & { file_id: string }> = Pick<
  ScopedTurnAttachmentParams<T>,
  'resendFiles' | 'historicalFiles' | 'requestAttachments'
> &
  Partial<Pick<ScopedTurnAttachmentParams<T>, 'messages' | 'sharedRunAttachmentIds'>>;

/** The endpoint type a receiver's attachments are filtered under, where the caller knows it. */
export interface ScopedReceiverEndpoint {
  endpointType?: string | null;
}

/** Each receiver's endpoint type by agent id. */
export type ScopedReceiverEndpoints =
  | Map<string, ScopedReceiverEndpoint>
  | Record<string, ScopedReceiverEndpoint>;

/**
 * The scoped attachment inputs whose text {@link prepareScopedTurnCandidates} derives. Without the
 * narrowing inputs every receiver with a reading context decides every historical and request file.
 */
export type ScopedTurnCandidateParams<T extends TurnReadingFile> = ScopedCandidateInputs<T> &
  Pick<ScopedTurnAttachmentParams<T>, 'agents' | 'attachmentsByAgentId'> &
  Partial<Pick<ScopedTurnAttachmentParams<T>, 'sharedConversationAgentIds'>> & {
    /** The app config whose endpoint file policy each receiver's scoped files must pass. */
    appConfig?: AppConfig;
    /** Each receiver's endpoint type; its endpoint is the one its routing settled. */
    endpointsByAgentId?: ScopedReceiverEndpoints;
    signal?: AbortSignal;
  };

/**
 * The scoped attachment candidates by file id, as copies carrying the text the receivers derived;
 * absent when no receiver has a reading context, so none were collected.
 */
export interface ScopedTurnCandidates<T extends TurnReadingFile> {
  candidates?: ReadonlyMap<string, T>;
}

/** Historical files still model-bound in the retained messages; every one when none are given. */
function selectHistoricalFileIds<T extends TurnDeliveryFile & { file_id: string }>({
  resendFiles,
  messages,
  historicalFiles,
}: ScopedCandidateInputs<T>): Iterable<string> {
  if (resendFiles === false) {
    return [];
  }
  if (messages == null) {
    return historicalFiles?.keys() ?? [];
  }
  return collectModelBoundHistoricalFileIdState(messages).fileIds;
}

/** Hydrated history and request files no shared prompt carries, once each by file id. */
function collectScopedCandidates<T extends TurnDeliveryFile & { file_id: string }>(
  inputs: ScopedCandidateInputs<T>,
): Map<string, T> {
  const { historicalFiles, requestAttachments, sharedRunAttachmentIds } = inputs;
  const isShared = (fileId: string): boolean => sharedRunAttachmentIds?.has(fileId) === true;
  const candidates = new Map<string, T>();
  for (const fileId of selectHistoricalFileIds(inputs)) {
    const file = historicalFiles?.get(fileId);
    if (file && !isShared(fileId)) candidates.set(fileId, file);
  }
  for (const file of requestAttachments) {
    if (!isShared(file.file_id)) candidates.set(file.file_id, file);
  }
  return candidates;
}

/**
 * A receiver that can derive text, with the files its own scoped context already carries and the
 * candidates its endpoint's file policy accepts.
 */
interface ScopedTurnReader extends TurnReader {
  scopedFileIds: ReadonlySet<string>;
  acceptedFileIds: ReadonlySet<string>;
}

/** A candidate as the endpoint file policy reads it: a missing type or size reads as empty. */
type PolicyFile = TurnReadingFile & { type: string; bytes: number };

const toPolicyFile = (file: TurnReadingFile): PolicyFile => ({
  ...file,
  type: file.type ?? '',
  bytes: file.bytes ?? 0,
});

/**
 * The candidates the receiver's endpoint accepts, by the policy the scoped pipeline applies to
 * them later: a disabled endpoint, a MIME allowlist and the per-file size limit. A file refused
 * there is never derived for that receiver.
 */
function selectAcceptedFileIds<T extends TurnReadingFile>(
  candidates: PolicyFile[],
  routing: TurnDeliveryRouting,
  agentId: string,
  consumers: TurnFileConsumers | undefined,
  { appConfig, endpointsByAgentId }: ScopedTurnCandidateParams<T>,
): ReadonlySet<string> {
  const accepted = filterFilesByEndpointRuntimeConfig(appConfig, {
    files: candidates,
    endpoint: routing.endpoint,
    endpointType: getAgentEntry(endpointsByAgentId, agentId)?.endpointType,
    skipTotalSizeLimit: true,
    preserveTextSources: true,
    consumers,
  });
  return new Set(accepted.map((file) => file.file_id));
}

function selectScopedReaders<T extends TurnReadingFile>(
  params: ScopedTurnCandidateParams<T>,
  candidates: PolicyFile[],
): ScopedTurnReader[] {
  const { agents, sharedConversationAgentIds, attachmentsByAgentId } = params;
  const sharedAgents = sharedConversationAgentIds && new Set(sharedConversationAgentIds);
  return agents.flatMap(({ agentId, agent }) => {
    const routing = agent.deliveryRouting;
    const context = getTurnReadingContext(routing);
    if (routing == null || context == null || sharedAgents?.has(agentId) === false) {
      return [];
    }
    const scoped = getAgentEntry(attachmentsByAgentId, agentId) ?? [];
    return [
      {
        routing,
        consumers: agent.fileConsumers,
        context,
        scopedFileIds: new Set(scoped.map((file) => file.file_id)),
        acceptedFileIds: selectAcceptedFileIds(
          candidates,
          routing,
          agentId,
          agent.fileConsumers,
          params,
        ),
      },
    ];
  });
}

const needsScopedText = (file: TurnReadingFile, reader: ScopedTurnReader): boolean =>
  !reader.scopedFileIds.has(file.file_id) &&
  reader.acceptedFileIds.has(file.file_id) &&
  needsDerivedText(file, reader);

/** The candidate with every receiver whose decision needs its text, or nothing when none does. */
function requestScopedText<T extends TurnReadingFile>(
  file: T,
  readers: readonly ScopedTurnReader[],
): TextRequest<T>[] {
  const [first, ...rest] = readers
    .filter((reader) => needsScopedText(file, reader))
    .map(({ context }) => context);
  return first == null ? [] : [{ file, contexts: [first, ...rest] }];
}

/**
 * Derives, before handoff receivers resolve their scoped context, the text a receiver's reading
 * needs. Each candidate the receiver's endpoint accepts is decided with that receiver's routing
 * and readers, and its text is derived once, through the first receiver that needs it, then saved
 * where the record allows.
 * Returns the candidates, as copies carrying the text, for {@link resolveScopedTurnAttachments}
 * to resolve synchronously without collecting them again; nothing when no receiver has a
 * reading context.
 */
export async function prepareScopedTurnCandidates<T extends TurnReadingFile>(
  params: ScopedTurnCandidateParams<T>,
): Promise<ScopedTurnCandidates<T>> {
  const { signal } = params;
  if (!params.agents.some(({ agent }) => getTurnReadingContext(agent.deliveryRouting) != null)) {
    return {};
  }
  const candidates = collectScopedCandidates(params);
  const readers = selectScopedReaders(params, [...candidates.values()].map(toPolicyFile));
  if (readers.length === 0) {
    return {};
  }
  const requests = [...candidates.values()].flatMap((file) => requestScopedText(file, readers));
  if (requests.length === 0) {
    return { candidates };
  }
  signal?.throwIfAborted();
  const texts = await deriveRequestedText(requests, signal);
  const derivers = new Set(requests.map(({ contexts }) => contexts[0]));
  await Promise.all([...derivers].map((context) => context.flush()));
  if (texts.size === 0) {
    return { candidates };
  }
  for (const [fileId, derived] of texts) {
    const file = candidates.get(fileId);
    if (file != null) {
      candidates.set(fileId, withDerivedText(file, derived));
    }
  }
  return { candidates };
}

/**
 * A primary agent's tool route cannot decide whether a handoff receives text. Keep
 * owner-hydrated candidates until each receiver resolves them, then add only text absent
 * from the shared prompt to its scoped context. The existing scoped-context pipeline owns
 * endpoint filtering, aggregate admission, inspection and extraction for these copies.
 */
export function resolveScopedTurnAttachments<T extends TurnDeliveryFile & { file_id: string }>(
  params: ScopedTurnAttachmentParams<T>,
): Map<string, T[]> {
  const { agents, sharedConversationAgentIds, attachmentsByAgentId } = params;
  const candidates = params.candidates ?? collectScopedCandidates(params);
  const sharedAgents = new Set(sharedConversationAgentIds);
  const result = new Map<string, T[]>();
  for (const { agentId, agent } of agents) {
    const scoped = getAgentEntry(attachmentsByAgentId, agentId) ?? [];
    const files = new Map(scoped.map((file) => [file.file_id, file]));
    for (const [fileId, file] of sharedAgents.has(agentId) ? candidates : []) {
      if (files.has(fileId)) continue;
      const path = resolveTurnLLMDeliveryPath(agent.deliveryRouting, file, agent.fileConsumers);
      if (path === 'text' && file.text) files.set(fileId, { ...file, llmDeliveryPath: path });
    }
    result.set(agentId, [...files.values()]);
  }
  return result;
}
