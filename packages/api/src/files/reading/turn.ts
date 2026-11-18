import { Providers } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import {
  getRoutingMimeType,
  hasFileToolConsumer,
  EToolResources,
  decideFileReading,
  isBedrockDocumentType,
  categorizeForReading,
  canToolResourceConsume,
  isAnthropicDocumentType,
  resolveLLMDeliveryPolicy,
  isAutomaticReadingRecord,
  isDocumentSupportedProvider,
} from 'librechat-data-provider';
import type {
  TFile,
  TextDerivation,
  ReadingEvidence,
  TurnDeliveryFile,
  TurnFileConsumers,
  TurnReadingInputs,
  TLLMDeliveryPolicy,
  TurnDeliveryRouting,
} from 'librechat-data-provider';
import type { FileTextDerivationUpdate } from '@librechat/data-schemas';
import type { DocumentRejection, NativeValidationMode } from '~/types';
import type { ContentFilterError } from '~/middleware/contentFilter';
import type { UninspectableFileError } from '~/protection/files';
import { usesAnthropicDocumentCapabilities } from '~/files/encode/document';
import { getNativeDocumentSizeLimit } from '~/files/validation';
import { getSafeErrorMetadata } from '~/utils/errors';

/** Where a record's retained original is stored, for the deriver that reads it back. */
type StoredOriginal = Partial<Pick<TFile, 'filename' | 'filepath' | 'storageKey'>>;

/** A turn copy of an attachment record, identified so request-scoped evidence can name it. */
export type TurnReadingFile = TurnDeliveryFile & StoredOriginal & { file_id: string };

/** Why no text was derived on this request; none of these is persisted, so a later turn retries. */
export type DerivationSkipReason = 'policy' | 'storage_unavailable' | 'aborted' | 'no_extractor';

/** The content-policy error derived text raised: a finding, or text the policy cannot inspect. */
export type DerivationPolicyError = ContentFilterError | UninspectableFileError;

/**
 * The outcome of deriving a file's text from its retained original. A `failed` outcome is
 * deterministic, and `persist` says whether the record may keep it as a failed marker. A
 * `blocked` outcome is a content-policy refusal of the derived text, which fails the turn that
 * needed it exactly as the same text stored at upload would.
 */
export type DerivedText =
  | { status: 'derived'; text: string; textDerivation: TextDerivation }
  | { status: 'failed'; textDerivation: TextDerivation; persist: boolean }
  | { status: 'blocked'; error: DerivationPolicyError }
  | { status: 'skipped'; reason: DerivationSkipReason };

export type FileTextDeriver = (file: TurnReadingFile, signal?: AbortSignal) => Promise<DerivedText>;

/** A derivation that changed the copy's text, as {@link withDerivedText} applies it. */
export type DerivedTextSuccess = Extract<DerivedText, { status: 'derived' }>;

/** What a derivation writes back onto a record: see {@link selectDerivationUpdate}. */
export type TextDerivationUpdate = FileTextDerivationUpdate;

/** Saves a derivation onto its record and resolves whether a record changed. */
export type TextDerivationPersister = (update: TextDerivationUpdate) => Promise<boolean>;

/** The owner a derivation is saved under, as `saveFileTextDerivation` scopes its write. */
export interface DerivationOwnerScope {
  user: string;
  tenantId?: string | null;
}

/** Saves a derivation under an owner scope: the data-schemas `saveFileTextDerivation`. */
export type TextDerivationSave = (
  update: TextDerivationUpdate,
  scope: DerivationOwnerScope,
) => Promise<boolean>;

/**
 * A request's derivation persister: saves under the request's file owner and writes each file at
 * most once, so the reading contexts of several agents that share one deriver issue one write per
 * derived file. A failed write is forgotten, so a later context may try again. The host builds
 * one per request, next to the deriver, and hands it to every agent.
 */
export function createDerivationPersister(
  save: TextDerivationSave,
  scope: DerivationOwnerScope,
): TextDerivationPersister {
  const writes = new Map<string, Promise<boolean>>();
  return (update) => {
    const existing = writes.get(update.file_id);
    if (existing != null) {
      return existing;
    }
    const write = save(update, scope);
    writes.set(update.file_id, write);
    write.catch(() => {
      if (writes.get(update.file_id) === write) {
        writes.delete(update.file_id);
      }
    });
    return write;
  };
}

/** Preparation of one file in this turn's authorized File Search namespace. */
export type SearchPreparationState = 'queued' | 'ready' | 'failed';

/** Which files File Search will receive on this turn, known once tools have loaded. */
export interface SearchEvidence {
  /** Files queued for embedding on this request. */
  queued: readonly string[];
  /** Files registered under the turn's `file_search` tool resource. */
  registered: readonly string[];
  /** Shared with lazy provisioning; a failed attempt stays failed until a retry succeeds. */
  preparation?: ReadonlyMap<string, SearchPreparationState>;
}

/** Request-scoped counts for the turn's reading diagnostics. */
export interface TurnReadingStats {
  overflow: number;
  rejected: number;
  textFailed: number;
  derived: number;
  dropped: number;
}

/**
 * One agent's reading evidence for one request. Attached as `deliveryRouting.reading`, so every
 * reader holding the routing sees the verdicts and request-scoped evidence the others recorded.
 */
export interface TurnReadingContext extends TurnReadingInputs {
  readonly policy: TLLMDeliveryPolicy;
  /** The provider the document encoder receives for this agent. */
  readonly provider: string;
  /** The token count of the file's current text, when judging it required a count. */
  knownTokenCount(file: TurnDeliveryFile): number | undefined;
  addOverflow(fileIds: Iterable<string>): void;
  recordRejections(rejections: ReadonlyArray<DocumentRejection>): void;
  markTextFailed(fileId: string): void;
  setSearchEvidence(evidence: SearchEvidence): void;
  /** Whether an eligible search file is indexed, queued, or failed on this turn. */
  searchState(fileId: string): SearchPreparationState | undefined;
  /** Request attachments the endpoint's runtime policy removed before delivery. */
  recordDropped(files: Iterable<TurnReadingFile>): void;
  dropped(): readonly TurnReadingFile[];
  /** Derives the file's text once per request; repeated calls share the first derivation. */
  derive(file: TurnReadingFile, signal?: AbortSignal): Promise<DerivedText>;
  /**
   * Starts the record writes the request's derivations queued, once each derivation settles, and
   * waits for them. Never rejects. Nothing is written before a flush, but a flush is not what
   * makes the text safe to keep: derived text is content-inspected when it is derived
   * (`extractBoundedText` applies the `extracted_text` policy), text a policy refuses is never
   * written, and its refusal throws from {@link deriveRequestedText}. Initialization flushes only
   * after endpoint admission and the full-set inspection. History replay, steering and the
   * run-file encoder flush right after deriving, before their own endpoint filter and model-bound
   * admission run; the scoped handoff candidates do too, but derive only for files each
   * receiver's endpoint accepts.
   */
  flush(): Promise<void>;
  stats(): TurnReadingStats;
}

export interface BuildTurnReadingContextParams {
  routing: TurnDeliveryRouting;
  /** The provider the document encoder receives for this agent. */
  provider: string;
  model?: string;
  /** The request's `fileTokenLimit`; a missing or zero limit delivers no text. */
  fileTokenLimit: number | undefined;
  /** The endpoint `fileSizeLimit` the document encoder applies, in bytes. */
  configuredFileSizeLimit: number | undefined;
  /** A synchronous token count, ready for use. */
  countTokens: (text: string) => number;
  deriveText?: FileTextDeriver;
  /**
   * Saves derived text, or a deterministic failure, onto the record it came from. The caller
   * binds the request's file owner scope. A record marked `deferred`, or an unmarked original
   * without text, takes derived text; a failed marker is kept only by a deferred record.
   */
  persistDerivation?: TextDerivationPersister;
  signal?: AbortSignal;
}

type NativeVerdict = NonNullable<ReadingEvidence['native']>;

interface TextVerdict {
  fit: NonNullable<ReadingEvidence['text']>;
  tokens?: number;
}

const TURN_READING = Symbol('turnReading');

type BrandedTurnReadingContext = TurnReadingContext & { readonly [TURN_READING]: true };

const isTurnReadingContext = (
  reading: TurnReadingInputs | undefined,
): reading is BrandedTurnReadingContext => reading != null && TURN_READING in reading;

/** The reading context {@link buildTurnReadingContext} built for this routing, if any. */
export function getTurnReadingContext(
  routing?: Pick<TurnDeliveryRouting, 'reading'> | null,
): TurnReadingContext | undefined {
  const reading = routing?.reading;
  return isTurnReadingContext(reading) ? reading : undefined;
}

/** The `extractFileContext` options a turn's reading supplies for its text injection. */
export interface TurnTextOptions {
  knownTokenCount?: (file: TurnDeliveryFile) => number | undefined;
  markTruncation?: boolean;
}

/**
 * Reuses the token counts the reading judged text fit with, and under the automatic policy makes
 * any truncation visible: the policy never sends partial text on purpose, so a truncated file
 * means a reader judged it without the turn's evidence. Empty without a reading context.
 */
export function getTurnTextOptions(
  routing?: Pick<TurnDeliveryRouting, 'reading'> | null,
): TurnTextOptions {
  const context = getTurnReadingContext(routing);
  if (context == null) {
    return {};
  }
  return {
    knownTokenCount: context.knownTokenCount,
    markTruncation: context.policy === 'automatic',
  };
}

/** The agent fields that decide how the document encoder treats the files it cannot send. */
export interface NativeDeliveryAgent {
  id?: string;
  deliveryRouting?: TurnDeliveryRouting | null;
  fileConsumers?: TurnFileConsumers;
  currentRequestAttachments?: readonly TurnDeliveryFile[];
}

/** What a document encoder returns, as a split encode merges it. */
export interface EncodedDocuments<D, M> {
  documents: D[];
  files?: M[];
  rejected?: readonly DocumentRejection[];
}

/**
 * How the document encoder treats each file it cannot send. Only a file the automatic policy
 * reads has another reader to move to, so only it is left out instead of failing the turn;
 * explicit, configured, unmarked and legacy records keep failing exactly as classic.
 */
export function getNativeValidationPolicy(
  agent: NativeDeliveryAgent | null | undefined,
): (file: TurnDeliveryFile) => NativeValidationMode {
  const routing = agent?.deliveryRouting ?? undefined;
  if (
    getTurnReadingContext(routing)?.policy !== 'automatic' ||
    !hasFileToolConsumer(agent?.fileConsumers)
  ) {
    return () => 'throw';
  }
  return (file) => (isAutomaticReadingRecord(routing, file) ? 'skip' : 'throw');
}

const mergeEncoded = <D, M>(
  skipped: EncodedDocuments<D, M>,
  thrown: EncodedDocuments<D, M>,
): EncodedDocuments<D, M> => ({
  documents: [...skipped.documents, ...thrown.documents],
  files: [...(skipped.files ?? []), ...(thrown.files ?? [])],
  rejected: [...(skipped.rejected ?? []), ...(thrown.rejected ?? [])],
});

/**
 * Encodes documents with each file's own validation mode: files the automatic policy may leave
 * out are encoded in skip mode, the rest in throw mode, so a classic record still fails the turn.
 * A batch whose files share one mode is encoded in a single call.
 */
export async function encodeNativeDocuments<F extends TurnDeliveryFile, D, M>(
  files: F[],
  agent: NativeDeliveryAgent | null | undefined,
  encode: (
    files: F[],
    onValidationFailure: NativeValidationMode,
  ) => Promise<EncodedDocuments<D, M>>,
): Promise<EncodedDocuments<D, M>> {
  const validationMode = getNativeValidationPolicy(agent);
  const skippable = files.filter((file) => validationMode(file) === 'skip');
  if (skippable.length === 0) {
    return encode(files, 'throw');
  }
  if (skippable.length === files.length) {
    return encode(files, 'skip');
  }
  const skippableSet = new Set<F>(skippable);
  const [skipped, thrown] = await Promise.all([
    encode(skippable, 'skip'),
    encode(
      files.filter((file) => !skippableSet.has(file)),
      'throw',
    ),
  ]);
  return mergeEncoded(skipped, thrown);
}

/** The reader each rejected request file moves to, by file id, for the delivery log. */
function describeNextReaders(
  agent: NativeDeliveryAgent,
  rejected: readonly DocumentRejection[],
): Map<string, string> {
  const rejectedIds = new Set(rejected.map(({ file_id }) => file_id));
  const next = new Map<string, string>();
  for (const file of agent.currentRequestAttachments ?? []) {
    if (file.file_id == null || !rejectedIds.has(file.file_id) || next.has(file.file_id)) {
      continue;
    }
    const reading = decideFileReading({
      routing: agent.deliveryRouting ?? undefined,
      file,
      consumers: agent.fileConsumers,
    });
    next.set(file.file_id, reading.reader);
  }
  return next;
}

/**
 * Records the documents the encoder left out on every agent whose messages carry the encoded
 * payload, so each agent's later decisions and inventory move them on. Each reading context is
 * recorded once, even when agents share it.
 */
export function recordNativeRejections(
  agents: Iterable<NativeDeliveryAgent | null | undefined>,
  rejected?: readonly DocumentRejection[],
): void {
  if (rejected == null || rejected.length === 0) {
    return;
  }
  const recorded = new Set<TurnReadingContext>();
  for (const agent of agents) {
    const context = getTurnReadingContext(agent?.deliveryRouting);
    if (agent == null || context == null || recorded.has(context)) {
      continue;
    }
    recorded.add(context);
    context.recordRejections(rejected);
    if (!logger.isDebugEnabled()) {
      continue;
    }
    const next = describeNextReaders(agent, rejected);
    for (const { file_id, reason } of rejected) {
      logger.debug(
        `[nativeDelivery] agent=${agent.id ?? 'unknown'} file_id=${file_id} provider=${context.provider} rejected=${reason} mode=skip next=${next.get(file_id) ?? 'unknown'}`,
      );
    }
  }
}

const hasText = (text: TurnDeliveryFile['text']): text is string =>
  typeof text === 'string' && text.length > 0;

/** Whether the document encoder emits any block for this type on this provider and model. */
function encoderEmits(provider: string, mimeType: string, model?: string): boolean {
  if (provider === Providers.BEDROCK) {
    return isBedrockDocumentType(mimeType);
  }
  if (!isDocumentSupportedProvider(provider)) {
    return false;
  }
  return (
    !usesAnthropicDocumentCapabilities(provider as Providers, model) ||
    isAnthropicDocumentType(mimeType)
  );
}

/**
 * Text fits when the complete text is within the token limit. Every token spans at least one
 * byte, so a byte length within the limit settles it without counting.
 */
function judgeTextFit(
  text: string,
  limit: number | undefined,
  countTokens: (text: string) => number,
): TextVerdict {
  if (!limit) {
    return { fit: 'exceeds' };
  }
  if (Buffer.byteLength(text) <= limit) {
    return { fit: 'fits' };
  }
  const tokens = countTokens(text);
  return { fit: tokens <= limit ? 'fits' : 'exceeds', tokens };
}

/**
 * The write a derivation makes on its record: the text with its marker on success, the marker
 * alone for a deterministic failure the record may keep. Derived text is kept by the record that
 * deferred it, and cached on an unmarked original that stored none, so a document the provider
 * could not take is parsed once rather than on every turn that replays it. A failed marker is
 * kept only where the record was deferred; a settled or failed record is never written.
 */
function selectDerivationUpdate(
  file: TurnReadingFile,
  result: DerivedText,
): TextDerivationUpdate | undefined {
  const outcome = file.metadata?.textDerivation?.outcome;
  const hasText = typeof file.text === 'string' && file.text.length > 0;
  if (result.status === 'derived' && (outcome === 'deferred' || (outcome == null && !hasText))) {
    return { file_id: file.file_id, text: result.text, textDerivation: result.textDerivation };
  }
  if (result.status === 'failed' && result.persist && outcome === 'deferred') {
    return { file_id: file.file_id, textDerivation: result.textDerivation };
  }
  return undefined;
}

function createTurnReadingContext(
  policy: TLLMDeliveryPolicy,
  {
    routing,
    provider,
    model,
    fileTokenLimit,
    configuredFileSizeLimit,
    countTokens,
    deriveText,
    persistDerivation,
    signal: requestSignal,
  }: BuildTurnReadingContextParams,
): BrandedTurnReadingContext {
  const automatic = policy === 'automatic';
  const nativeVerdicts = new Map<string, NativeVerdict | null>();
  const textVerdicts = new Map<string, TextVerdict>();
  const overflow = new Set<string>();
  const rejected = new Map<string, DocumentRejection['reason']>();
  const textFailed = new Set<string>();
  const droppedFiles = new Map<string, TurnReadingFile>();
  const derivations = new Map<string, Promise<DerivedText>>();
  const queuedWrites: Array<{ file: TurnReadingFile; derivation: Promise<DerivedText> }> = [];
  let searchFileIds: ReadonlySet<string> | undefined;
  let registeredSearchFileIds: ReadonlySet<string> | undefined;
  let searchPreparation: ReadonlyMap<string, SearchPreparationState> | undefined;
  let derived = 0;

  const judgeNativeUncached = (file: TurnDeliveryFile): NativeVerdict | null => {
    const routingMimeType = getRoutingMimeType(file);
    if (categorizeForReading(routingMimeType) === 'media') {
      return null;
    }
    const mimeType = file.type ?? '';
    if (!encoderEmits(provider, mimeType, model)) {
      return 'unsupported';
    }
    const limit = getNativeDocumentSizeLimit({
      provider,
      mimeType,
      model,
      configuredFileSizeLimit,
    });
    return limit !== undefined && (file.bytes ?? 0) > limit ? 'capacity' : 'fits';
  };

  const judgeNative = (file: TurnDeliveryFile): NativeVerdict | null => {
    if (file.file_id == null) {
      return judgeNativeUncached(file);
    }
    const cached = nativeVerdicts.get(file.file_id);
    if (cached !== undefined) {
      return cached;
    }
    const verdict = judgeNativeUncached(file);
    nativeVerdicts.set(file.file_id, verdict);
    return verdict;
  };

  const textKey = (file: TurnDeliveryFile, text: string): string | undefined =>
    file.file_id == null ? undefined : `${file.file_id}:${text.length}`;

  const judgeText = (file: TurnDeliveryFile): TextVerdict | undefined => {
    if (!hasText(file.text)) {
      return undefined;
    }
    const key = textKey(file, file.text);
    const cached = key == null ? undefined : textVerdicts.get(key);
    if (cached != null) {
      return cached;
    }
    const verdict = judgeTextFit(file.text, fileTokenLimit, countTokens);
    if (key != null) {
      textVerdicts.set(key, verdict);
    }
    return verdict;
  };

  const judgeSearch = (file: TurnDeliveryFile): ReadingEvidence['search'] => {
    if (searchFileIds == null) {
      return undefined;
    }
    const unreachable =
      (file.file_id == null || !searchFileIds.has(file.file_id)) &&
      canToolResourceConsume(EToolResources.file_search, file.type ?? '') &&
      isAutomaticReadingRecord(routing, file);
    return unreachable ? 'unreachable' : 'reachable';
  };

  const requestEvidence = (fileId: string | undefined): ReadingEvidence => ({
    ...(fileId != null && textFailed.has(fileId) && { textFailed: true as const }),
  });

  /**
   * Exposes the text verdict as an enumerable getter judged on first read, so a reading walk that
   * settles on Run Code, the provider or File Search never counts tokens in text it will not
   * deliver. The verdict is memoized here and, by file and text length, for knownTokenCount.
   */
  const withLazyText = (evidence: ReadingEvidence, file: TurnDeliveryFile): ReadingEvidence => {
    let verdict: TextVerdict | undefined;
    Object.defineProperty(evidence, 'text', {
      enumerable: true,
      configurable: true,
      get: () => {
        verdict ??= judgeText(file);
        return verdict?.fit;
      },
    });
    return evidence;
  };

  const judge = (file: TurnDeliveryFile): ReadingEvidence => {
    if (!automatic) {
      return requestEvidence(file.file_id);
    }
    const fileId = file.file_id;
    const native = judgeNative(file);
    const rejection = fileId == null ? undefined : rejected.get(fileId);
    const search = judgeSearch(file);
    const evidence: ReadingEvidence = {
      ...(native != null && { native }),
      ...(rejection != null && { rejected: rejection }),
      ...(fileId != null && overflow.has(fileId) && { overflow: true as const }),
      ...requestEvidence(fileId),
      ...(search != null && { search }),
    };
    return hasText(file.text) ? withLazyText(evidence, file) : evidence;
  };

  const knownTokenCount = (file: TurnDeliveryFile): number | undefined => {
    if (!hasText(file.text)) {
      return undefined;
    }
    const key = textKey(file, file.text);
    return key == null ? undefined : textVerdicts.get(key)?.tokens;
  };

  const runDerivation = (file: TurnReadingFile, signal?: AbortSignal): Promise<DerivedText> => {
    if (deriveText == null) {
      return Promise.resolve({ status: 'skipped', reason: 'no_extractor' });
    }
    return deriveText(file, signal).then(
      (result): DerivedText => {
        if (result.status === 'derived') {
          derived += 1;
        }
        return result;
      },
      (error: unknown): DerivedText => {
        logger.error(
          `[readingText] file_id=${file.file_id} outcome=skipped reason=derivation_error`,
          getSafeErrorMetadata(error),
        );
        return { status: 'skipped', reason: signal?.aborted ? 'aborted' : 'storage_unavailable' };
      },
    );
  };

  /** Saves the derivation onto a marked record; a failed write is logged, never thrown. */
  const persist = async (file: TurnReadingFile, result: DerivedText): Promise<void> => {
    const update = selectDerivationUpdate(file, result);
    if (update == null || persistDerivation == null) {
      return;
    }
    const line = `[readingText] file_id=${update.file_id} outcome=${update.textDerivation.outcome}`;
    try {
      const saved = await persistDerivation(update);
      logger.debug(`${line} persisted=${saved}`);
    } catch (error) {
      logger.error(`${line} persisted=failed`, getSafeErrorMetadata(error));
    }
  };

  const derive = (file: TurnReadingFile, signal?: AbortSignal): Promise<DerivedText> => {
    const existing = derivations.get(file.file_id);
    if (existing != null) {
      return existing;
    }
    const derivation = runDerivation(file, signal ?? requestSignal);
    derivations.set(file.file_id, derivation);
    queuedWrites.push({ file, derivation });
    /* An aborted derivation answers only its own caller, like the deriver's memo. */
    const forget = () => {
      if (derivations.get(file.file_id) === derivation) {
        derivations.delete(file.file_id);
      }
    };
    derivation.then((result) => {
      if (result.status === 'skipped' && result.reason === 'aborted') {
        forget();
      }
    }, forget);
    return derivation;
  };

  const flush = async (): Promise<void> => {
    const writes = queuedWrites.splice(0);
    await Promise.allSettled(
      writes.map(({ file, derivation }) => derivation.then((result) => persist(file, result))),
    );
  };

  return {
    [TURN_READING]: true,
    policy,
    provider,
    canDerive: deriveText != null,
    judge,
    knownTokenCount,
    addOverflow: (fileIds) => {
      for (const fileId of fileIds) {
        overflow.add(fileId);
      }
    },
    recordRejections: (rejections) => {
      for (const { file_id, reason } of rejections) {
        if (!rejected.has(file_id)) {
          rejected.set(file_id, reason);
        }
      }
    },
    markTextFailed: (fileId) => {
      textFailed.add(fileId);
    },
    setSearchEvidence: ({ queued, registered, preparation }) => {
      searchFileIds = new Set([...queued, ...registered]);
      registeredSearchFileIds = new Set(registered);
      searchPreparation = preparation;
    },
    searchState: (fileId) => {
      const preparation = searchPreparation?.get(fileId);
      if (preparation != null) {
        return preparation;
      }
      if (registeredSearchFileIds?.has(fileId)) {
        return 'ready';
      }
      if (searchFileIds?.has(fileId)) {
        return 'queued';
      }
      return undefined;
    },
    recordDropped: (files) => {
      for (const file of files) {
        if (!droppedFiles.has(file.file_id)) {
          droppedFiles.set(file.file_id, file);
        }
      }
    },
    dropped: () => [...droppedFiles.values()],
    derive,
    flush,
    stats: () => ({
      overflow: overflow.size,
      rejected: rejected.size,
      textFailed: textFailed.size,
      derived,
      dropped: droppedFiles.size,
    }),
  };
}

/**
 * Builds the reading evidence for one agent's turn, or nothing where the turn needs none: under
 * the classic policy without a text deriver every route stays classic. Under classic with a
 * deriver the context only derives text, for records the automatic policy marked, and its judge
 * reports nothing but this request's derivation failures.
 */
export function buildTurnReadingContext(
  params: BuildTurnReadingContextParams,
): TurnReadingContext | undefined {
  const policy = resolveLLMDeliveryPolicy(params.routing.endpointConfig);
  if (policy !== 'automatic' && params.deriveText == null) {
    return undefined;
  }
  return createTurnReadingContext(policy, params);
}

/** One agent's turn routing, the tools judged as its readers, and its reading context. */
export interface TurnReader {
  routing: TurnDeliveryRouting;
  consumers?: TurnFileConsumers;
  context: TurnReadingContext;
}

/**
 * Whether the file's reading needs text derived on this turn. A derive-only classic context
 * serves only records the automatic policy marked, so an unmarked record costs it no decision.
 */
export function needsDerivedText(
  file: TurnReadingFile,
  { routing, consumers, context }: TurnReader,
): boolean {
  if (context.policy !== 'automatic' && file.metadata?.textDerivation == null) {
    return false;
  }
  return decideFileReading({ routing, file, consumers }).needsText;
}

/** The copy carrying derived text and the marker saying how it was obtained. */
export const withDerivedText = <T extends TurnReadingFile>(
  file: T,
  derived: DerivedTextSuccess,
): T => ({
  ...file,
  text: derived.text,
  metadata: { ...file.metadata, textDerivation: derived.textDerivation },
});

/** A file whose reading needs text, with every reading context whose decision asked for it. */
export interface TextRequest<T extends TurnReadingFile> {
  file: T;
  /** The first context derives; the rest share its outcome. */
  contexts: readonly [TurnReadingContext, ...TurnReadingContext[]];
}

/**
 * Derives each requested file's text once, through the first context that asked for it, and
 * returns the successes by file id. A file left without text is marked failed on every context
 * that asked, so their next decisions pass text over for the rest of the request. Derived text a
 * content policy refuses throws its policy error: the turn needed that text, and the same text
 * stored at upload would have been refused there.
 */
export async function deriveRequestedText<T extends TurnReadingFile>(
  requests: readonly TextRequest<T>[],
  signal?: AbortSignal,
): Promise<Map<string, DerivedTextSuccess>> {
  const outcomes = await Promise.all(
    requests.map(async ({ file, contexts }) => ({
      file,
      contexts,
      result: await contexts[0].derive(file, signal),
    })),
  );
  const texts = new Map<string, DerivedTextSuccess>();
  for (const { file, contexts, result } of outcomes) {
    if (result.status === 'derived') {
      texts.set(file.file_id, result);
      continue;
    }
    if (result.status === 'blocked') {
      throw result.error;
    }
    for (const context of contexts) {
      context.markTextFailed(file.file_id);
    }
  }
  return texts;
}
