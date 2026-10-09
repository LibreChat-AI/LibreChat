import type {
  ReaderKind,
  ReaderSkip,
  SkipReason,
  FileReading,
  ClassicReason,
  ReadingReason,
  TextDerivation,
  BuiltInTextPlan,
  CodeEligibility,
  ReadingCategory,
  ReadingEvidence,
  TurnReadingInputs,
} from './reading';
import type {
  TLLMDeliveryPolicy,
  TDefaultLLMDeliveryPath,
  TDefaultLLMDeliveryPathConfig,
} from './file-config';
import type { EndpointFileConfig, FileConfig, RegexLike } from './types/files';
import type { CodeEnvReferenceSet } from './codeEnvRef';
import type { TEndpoint } from './config';
import {
  retrievalMimeTypes,
  isExplicitMimeConfig,
  isBedrockDocumentType,
  documentParserMimeTypes,
  codeInterpreterMimeTypes,
  resolveLLMDeliveryPolicy,
  fileConfig as baseFileConfig,
} from './file-config';
import {
  EModelEndpoint,
  isOpenAILikeProvider,
  isKnownProviderIdentifier,
  isMediaSupportedProvider,
  isDocumentSupportedProvider,
} from './schemas';
import {
  READER_PATH,
  AFTER_FAILURE,
  READING_ORDER,
  isTextOnlyRecord,
  isOriginalBacked,
  categorizeForReading,
} from './reading';
import { normalizeEndpointName } from './utils';
import { EToolResources } from './types/tools';
import { getCodeEnvRefs } from './codeEnvRef';
import { FileContext } from './types/files';

/**
 * The native provider a custom endpoint declares, when it declares one. A custom endpoint
 * speaks OpenAI's API unless its config names another dialect, and the upload route needs
 * that answer for the same reason request initialization does: the media encoders emit
 * OpenAI-format parts, so a custom endpoint running as Anthropic receives none.
 */
export function getCustomEndpointProvider(
  customEndpoints: Array<Partial<Pick<TEndpoint, 'name' | 'provider'>>> | undefined,
  endpoint?: string | null,
): string | undefined {
  if (!customEndpoints || !endpoint) {
    return undefined;
  }
  const normalized = normalizeEndpointName(endpoint);
  return customEndpoints.find((config) => normalizeEndpointName(config.name ?? '') === normalized)
    ?.provider;
}

/** A custom endpoint emits OpenAI-format media parts only for the types the admin listed
 *  in its `supportedMimeTypes`; the inherited default list is not an opt-in. A name that
 *  is not a known provider is a custom endpoint. Mirrors `isConfiguredProviderMediaType`
 *  on the encoder side, so the route and the encoder agree on which uploads the provider
 *  actually receives; the built-in endpoints are left out because the client offers no
 *  media for them. */
const isConfiguredMediaEndpoint = (
  mimeType: string,
  endpoint: string,
  supportedMimeTypes?: RegexLike[],
): boolean => {
  if (!isExplicitMimeConfig(supportedMimeTypes) || isKnownProviderIdentifier(endpoint)) {
    return false;
  }
  return baseFileConfig.checkType(mimeType, supportedMimeTypes);
};

/** Audio and video reach the model only through the media encoders, which support a
 *  narrower provider set than documents. Images use the broadly supported vision
 *  path and are never gated here. */
const isProviderCapable = (
  mimeType: string,
  endpoint: string,
  useResponsesApi?: boolean,
  supportedMimeTypes?: RegexLike[],
): boolean => {
  if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
    return (
      isMediaSupportedProvider(endpoint) ||
      isConfiguredMediaEndpoint(mimeType, endpoint, supportedMimeTypes)
    );
  }
  if (mimeType === 'application/pdf') {
    /* Azure is out of the document set because it needs the Responses API for native
     * documents, so the encoder's own condition decides rather than the endpoint alone. */
    return useResponsesApi === true || isDocumentSupportedProvider(endpoint);
  }
  return true;
};

export const SYSTEM_LLM_DELIVERY_DEFAULTS: Required<TDefaultLLMDeliveryPathConfig> = {
  fallback: 'text',
  overrides: {
    'image/*': 'provider',
    'video/*': 'provider',
    'audio/*': 'provider',
    'application/pdf': 'provider',
  },
};

/**
 * Types some step in the upload pipeline can turn into text: natively readable text,
 * documents a parser or OCR handles, images through OCR, and audio through transcription.
 *
 * Everything absent from this list, notably archives, tarballs, columnar data files and
 * video, has no such step, and the default text matcher accepts any well-formed type, so
 * routing them to text ends in their bytes being decoded as UTF-8.
 */
const TEXT_RECOVERABLE_MIME_TYPES: RegExp[] = [
  /^text\//,
  /^image\//,
  /^audio\//,
  /^application\/(json|javascript|xml|sql|yaml|x-yaml|csv|typescript|x-sh|vnd\.coffeescript)$/,
  /^application\/pdf$/,
  /* Only the formats the built-in document parser handles. Presentations and graphics
   * are absent from documentParserMimeTypes, so on a deployment without OCR they would
   * fall through to the permissive text matcher and be decoded as ZIP bytes. */
  /^application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet)$/,
  /^application\/vnd\.oasis\.opendocument\.(text|spreadsheet)$/,
  /^application\/(vnd\.ms-excel|x-msexcel|msexcel|x-ms-excel|x-excel|x-dos_ms_excel|xls|x-xls)$/,
  /^message\/rfc822$/,
];

/**
 * Types whose bytes are text already, so reading them directly is meaningful. Everything
 * else needs a real extractor: decoding it as UTF-8 produces mojibake rather than content.
 */
/** Application types whose payload is text. Mirrors the set the content-protection code
 *  treats as textual, plus the source and data formats this pipeline also accepts. */
const TEXTUAL_APPLICATION_MIME_TYPES = new Set([
  'application/json',
  'application/javascript',
  'application/sql',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/csv',
  'application/typescript',
  'application/x-sh',
  'application/vnd.coffeescript',
]);

export function isNativelyReadableText(mimeType: string): boolean {
  const normalized = mimeType.split(';', 1)[0].trim().toLowerCase();
  return (
    normalized.startsWith('text/') ||
    TEXTUAL_APPLICATION_MIME_TYPES.has(normalized) ||
    normalized === 'message/rfc822'
  );
}

export function hasTextExtractionPath(mimeType: string): boolean {
  return TEXT_RECOVERABLE_MIME_TYPES.some((pattern) => pattern.test(mimeType));
}

/**
 * The built-in extractor that can turn a stored type into text, or null when none can. Only
 * built-in readers count, so text for a file meant for a tool never costs a RAG or OCR call.
 */
export function selectBuiltInTextPlan(mimeType: string): BuiltInTextPlan | null {
  if (documentParserMimeTypes.some((pattern) => pattern.test(mimeType))) {
    return 'document_parser';
  }
  return isNativelyReadableText(mimeType) ? 'native_text' : null;
}

/**
 * The route an explicit endpoint or global `defaultLLMDeliveryPath` assigns a type, or undefined
 * when neither names it: endpoint overrides, endpoint fallback, global overrides, then global
 * fallback, with an exact type ahead of its wildcard at each level.
 */
export function matchConfiguredDeliveryPath(
  mimeType: string,
  endpointConfig?: TDefaultLLMDeliveryPathConfig,
  globalConfig?: TDefaultLLMDeliveryPathConfig,
): TDefaultLLMDeliveryPath | undefined {
  const wildcard = mimeType.split('/')[0] + '/*';

  if (endpointConfig?.overrides) {
    if (endpointConfig.overrides[mimeType]) {
      return endpointConfig.overrides[mimeType] as TDefaultLLMDeliveryPath;
    }
    if (endpointConfig.overrides[wildcard]) {
      return endpointConfig.overrides[wildcard] as TDefaultLLMDeliveryPath;
    }
  }

  if (endpointConfig?.fallback) {
    return endpointConfig.fallback;
  }

  if (globalConfig?.overrides) {
    if (globalConfig.overrides[mimeType]) {
      return globalConfig.overrides[mimeType] as TDefaultLLMDeliveryPath;
    }
    if (globalConfig.overrides[wildcard]) {
      return globalConfig.overrides[wildcard] as TDefaultLLMDeliveryPath;
    }
  }

  if (globalConfig?.fallback) {
    return globalConfig.fallback;
  }

  return undefined;
}

/**
 * Resolves the default file path destination for a given mime type.
 * Resolution chain: endpoint overrides -> endpoint fallback -> global overrides -> global fallback -> system defaults.
 */
export function resolveDefaultLLMDeliveryPath(
  mimeType: string,
  endpointConfig?: TDefaultLLMDeliveryPathConfig,
  globalConfig?: TDefaultLLMDeliveryPathConfig,
  endpoint?: string,
  useResponsesApi?: boolean,
  sttConfigured?: boolean,
  supportedMimeTypes?: RegexLike[],
): TDefaultLLMDeliveryPath {
  const configured = matchConfiguredDeliveryPath(mimeType, endpointConfig, globalConfig);
  if (configured != null) {
    return configured;
  }

  const wildcard = mimeType.split('/')[0] + '/*';
  const systemDefault = (SYSTEM_LLM_DELIVERY_DEFAULTS.overrides[mimeType] ??
    SYSTEM_LLM_DELIVERY_DEFAULTS.overrides[wildcard] ??
    SYSTEM_LLM_DELIVERY_DEFAULTS.fallback) as TDefaultLLMDeliveryPath;

  /** Only the system default is capability-gated: an explicit config above is the
   *  admin's decision. A known endpoint that cannot encode documents or media would
   *  otherwise accept the upload and hand the model nothing at all. */
  /** `agents` is a container, not a provider: it is what an upload reports when the
   *  agent's real provider could not be resolved, as for ephemeral agents. A custom
   *  endpoint name is likewise unresolvable here, since its real provider is chosen
   *  at request time and is usually OpenAI- or Anthropic-compatible. Judging
   *  capability from either would downgrade media the actual provider can deliver,
   *  so an unresolved provider keeps the system default. */
  const namedEndpoint = endpoint != null && endpoint !== EModelEndpoint.agents;
  const providerKnown = namedEndpoint && isKnownProviderIdentifier(endpoint);
  /* Media is judged for any named endpoint, identified or not. The media encoders emit a
   * payload only for the providers they name, or for an OpenAI-compatible endpoint whose
   * admin listed the type in its `supportedMimeTypes`; any other custom endpoint gets
   * nothing whatever it proxies to, and leaving it on the provider path delivers neither
   * media nor text. Documents keep the narrower rule: an unidentified endpoint is usually
   * OpenAI- or Anthropic-compatible, both of which do carry them. */
  const isMedia = mimeType.startsWith('audio/') || mimeType.startsWith('video/');
  /* Audio's text path is transcription, so on a deployment with no speech provider it is
   * not recoverable at all. Routing it to text there sends the upload to a service that
   * is not there and fails it outright. Unknown is left alone; only an explicit absence
   * closes the path. */
  const canRecoverText = (type: string): boolean =>
    type.startsWith('audio/') && sttConfigured === false ? false : hasTextExtractionPath(type);
  const canJudgeCapability = isMedia ? namedEndpoint : providerKnown;
  if (
    systemDefault === 'provider' &&
    canJudgeCapability &&
    !isProviderCapable(mimeType, endpoint as string, useResponsesApi, supportedMimeTypes)
  ) {
    /* Downgrading is only useful where text can actually be recovered. Video has no
     * extraction step: speech-to-text covers audio, and the default text matcher accepts
     * any well-formed MIME type, so routing it to text ends in the raw bytes being
     * decoded as UTF-8 and handed to the model. Keep it off the model path instead; the
     * file is still stored and still reachable by tools. */
    return canRecoverText(mimeType) ? 'text' : 'none';
  }

  /** Bedrock's Converse document path natively accepts more than PDF, so on that
   *  endpoint its document types belong on the provider path rather than being
   *  extracted, which would drop non-text content and layout. */
  if (
    systemDefault !== 'provider' &&
    endpoint === EModelEndpoint.bedrock &&
    isBedrockDocumentType(mimeType)
  ) {
    return 'provider';
  }

  /* The text fallback is only meaningful where text can be recovered. An archive or a
   * columnar data file reaching it would be decoded as UTF-8 into the prompt, so keep it
   * off the model path instead; the file is still stored and reachable by tools. An
   * explicit configuration above has already returned, so this governs the system default
   * alone. */
  if (systemDefault === 'text' && !canRecoverText(mimeType)) {
    return 'none';
  }

  return systemDefault;
}

/** The endpoint a delivery route is resolved against, at upload or on a turn. */
export interface DeliveryRouteInputs {
  endpointConfig?: EndpointFileConfig;
  fileConfig?: FileConfig;
  endpoint?: string;
  /** The provider the endpoint runs as, when the caller knows it: a custom endpoint's
   *  declared dialect at upload time, the agent's resolved provider at turn time. */
  endpointProvider?: string | null;
  useResponsesApi?: boolean;
  sttConfigured?: boolean;
}

/**
 * The configured or capability-gated route for a type on an endpoint, without the legacy
 * chooser. Where no configured route names the type, this is the system default the endpoint's
 * encoders can actually deliver.
 */
export function resolveSystemDeliveryPath(
  mimeType: string,
  {
    endpointConfig,
    fileConfig,
    endpoint,
    endpointProvider,
    useResponsesApi,
    sttConfigured,
  }: DeliveryRouteInputs,
): TDefaultLLMDeliveryPath {
  /* The media opt-in exists for OpenAI-format parts, so an endpoint known to run as
   * something else — a custom endpoint declaring `provider: anthropic` — keeps the
   * capability gate it had, where audio still reaches transcription. */
  const runsAsOpenAI = endpointProvider == null || isOpenAILikeProvider(endpointProvider);
  return resolveDefaultLLMDeliveryPath(
    mimeType,
    endpointConfig?.defaultLLMDeliveryPath,
    fileConfig?.defaultLLMDeliveryPath,
    endpoint,
    useResponsesApi,
    sttConfigured,
    runsAsOpenAI ? endpointConfig?.supportedMimeTypes : undefined,
  );
}

/**
 * Delivery path for an upload that named no tool resource. The legacy chooser makes the
 * destination explicit, so nothing is inferred there.
 */
export function resolveDefaultUploadLLMDeliveryPath({
  mimeType,
  ...routing
}: DeliveryRouteInputs & { mimeType: string }): TDefaultLLMDeliveryPath {
  if (routing.endpointConfig?.legacyFileUploadUX === true) {
    return 'provider';
  }
  return resolveSystemDeliveryPath(mimeType, routing);
}

/** Delivery path for an upload, honoring an explicitly chosen tool resource. */
export function resolveUploadLLMDeliveryPath({
  toolResource,
  mimeType,
  endpointConfig,
  fileConfig,
  endpoint,
  useResponsesApi,
  endpointProvider,
  sttConfigured,
}: DeliveryRouteInputs & {
  toolResource?: string | null;
  mimeType: string;
}): TDefaultLLMDeliveryPath {
  if (toolResource === EToolResources.context || toolResource === EToolResources.ocr) {
    return 'text';
  }
  if (toolResource === EToolResources.file_search || toolResource === EToolResources.execute_code) {
    return 'none';
  }
  return resolveDefaultUploadLLMDeliveryPath({
    mimeType,
    endpointConfig,
    fileConfig,
    endpoint,
    endpointProvider,
    useResponsesApi,
    sttConfigured,
  });
}

/**
 * Whether a file tool can do anything with this type. `file_search` indexes extracted
 * text, so it needs a type some step can turn into text and cannot use media, whose
 * extraction paths are OCR and speech rather than the vector store. Code execution is
 * judged by the list the client offers it from. Shared by upload-time selection and
 * deferred provisioning so the two cannot queue a file the other would refuse.
 */
export function canToolResourceConsume(toolResource: string, mimeType: string): boolean {
  if (toolResource === EToolResources.file_search) {
    /* The union of both readers rather than either alone: the extraction set describes
     * the document parser and omits presentations, which RAG does handle and the chooser
     * already offers, while the retrieval set omits csv and the spreadsheet formats. */
    return (
      !mimeType.startsWith('image') &&
      !mimeType.startsWith('audio') &&
      !mimeType.startsWith('video') &&
      (hasTextExtractionPath(mimeType) || matchesMimeList(mimeType, retrievalMimeTypes))
    );
  }
  if (toolResource === EToolResources.execute_code) {
    return matchesMimeList(mimeType, codeInterpreterMimeTypes);
  }
  return true;
}

const matchesMimeList = (mimeType: string, patterns: RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(mimeType));

/**
 * The file-reading tools one agent's turn runs. Each flag requires deployment capability,
 * the caller's role grant, and a reader in the final loaded tool set.
 */
export interface TurnFileConsumers {
  executeCode: boolean;
  fileSearch: boolean;
}

/**
 * Whether a file tool is loaded for the turn. The automatic policy decides readers only then;
 * without Run Code or File Search every attachment keeps its classic route, so a deployment
 * that enables the policy sees no change in conversations that attach no tool.
 */
export function hasFileToolConsumer(consumers?: TurnFileConsumers | null): boolean {
  return consumers?.executeCode === true || consumers?.fileSearch === true;
}

/**
 * Whether the record shows this file reached a tool's own store: vectors for file search, a
 * sandbox pointer for code execution. Nothing else writes either, so their presence is proof
 * the file was provisioned and their absence proof it was not. The same evidence deferred
 * provisioning reads before queueing a file, so a turn cannot withhold content for a tool that
 * provisioning has yet to serve.
 */
export function hasToolResourceProvisioning(file: TurnDeliveryFile, toolResource: string): boolean {
  if (toolResource === EToolResources.execute_code) {
    return getCodeEnvRefs(file.metadata).length > 0;
  }
  return file.embedded === true || (file.metadata?.embeddedEntities?.length ?? 0) > 0;
}

/**
 * Whether a tool this turn runs can read a file of this type.
 *
 * Passing the record asks the stricter question a delivery decision needs where a tool serves
 * only what it already holds. File search reads the vector store, and an upload that named no
 * destination is filed under no tool at all, so an enabled search tool is a reader only once
 * the record shows the store holds the file. Run Code needs no copy in advance: its first call
 * uploads every attachment it can read to the sandbox, so enabling it is enough. Requiring a
 * copy there would hand the file's text to the prompt on every turn before the first code run,
 * and a turn that refuses that text never runs code, so the file would never become held.
 */
export function hasTurnFileConsumer(
  mimeType: string,
  consumers: TurnFileConsumers,
  file?: TurnDeliveryFile,
): boolean {
  const searchHolds = file == null || hasToolResourceProvisioning(file, EToolResources.file_search);
  return (
    (consumers.executeCode && canToolResourceConsume(EToolResources.execute_code, mimeType)) ||
    (consumers.fileSearch &&
      canToolResourceConsume(EToolResources.file_search, mimeType) &&
      searchHolds)
  );
}

/**
 * The inputs that route every attachment for the agent running a turn. Initialization
 * settles them once, after the provider swap and the Responses API decision, and every
 * reader of a turn route consumes this value rather than deriving one from the agent.
 */
export interface TurnDeliveryRouting {
  fileConfig: FileConfig;
  endpointConfig: EndpointFileConfig;
  /** The endpoint the file policy is configured under: a custom endpoint's own name, not
   *  the client family initialization runs it as. */
  endpoint: string;
  /** The dialect a custom endpoint declares, which decides whether it receives OpenAI-format
   *  media; undefined for a built-in or OpenAI-compatible endpoint. */
  endpointProvider?: string;
  useResponsesApi?: boolean;
  sttConfigured: boolean;
  /** This turn's reading evidence for the automatic policy; absent where the host supplies none. */
  reading?: TurnReadingInputs;
}

/** The fields of an attachment record that decide its delivery on a turn. */
export interface TurnDeliveryFile {
  file_id?: string;
  type?: string;
  bytes?: number;
  source?: string | null;
  context?: string | null;
  text?: string | null;
  /** Stored as an upload-time inference, so any string may be read back. */
  llmDeliveryPath?: string | null;
  /** Whether a vector store holds this file, which is what lets file search serve it.
   *  Records predating namespace tracking carry only this flag. */
  embedded?: boolean | null;
  metadata?:
    | ({
        routingMimeType?: string;
        destinationChosen?: boolean;
        /** Vector namespaces holding this file, written as each embedding succeeds. */
        embeddedEntities?: string[];
        textDerivation?: TextDerivation;
      } & CodeEnvReferenceSet)
    | null;
}

const isLLMDeliveryPath = (value: unknown): value is TDefaultLLMDeliveryPath =>
  value === 'provider' || value === 'text' || value === 'none';

/** Whether a record's stored route was inferred at upload, so each turn resolves it again. */
export function hasInferredLLMDeliveryPath(file: TurnDeliveryFile): boolean {
  return file.llmDeliveryPath != null && file.metadata?.destinationChosen !== true;
}

/**
 * Classic delivery path for one attachment on one agent's turn.
 *
 * A record predating routing and a destination the user chose keep what they stored. An
 * inferred route re-resolves against the endpoint handling the turn. A `none` route leaves
 * the file for a tool; where the endpoint enables `textFallbackWithoutTools` and no tool this
 * turn runs can read the file, the text extracted at upload is delivered rather than the file
 * reaching nothing. Consumers left undefined are unknown and not judged, as in
 * {@link resolveUploadDestination}.
 *
 * For file search, reading is asked of the record rather than of the tool set, because the two
 * disagree for the upload that needs the fallback most: one that named no destination is filed
 * under no tool, so enabling file search would otherwise withhold the text for a vector store
 * that never received the file. Run Code is judged by the tool set: see
 * {@link hasTurnFileConsumer}.
 */
export function resolveClassicTurnLLMDeliveryPath(
  routing: Partial<TurnDeliveryRouting> | undefined,
  file: TurnDeliveryFile,
  consumers?: TurnFileConsumers,
): TDefaultLLMDeliveryPath | undefined {
  if (routing == null || !hasInferredLLMDeliveryPath(file)) {
    return isLLMDeliveryPath(file.llmDeliveryPath) ? file.llmDeliveryPath : undefined;
  }
  const { endpointConfig } = routing;
  const mimeType = getRoutingMimeType(file);
  const path = resolveUploadLLMDeliveryPath({ mimeType, ...routing });
  const hasFallbackText = typeof file.text === 'string' && file.text.length > 0;
  if (
    path === 'none' &&
    endpointConfig?.textFallbackWithoutTools === true &&
    consumers != null &&
    hasFallbackText &&
    !hasTurnFileConsumer(mimeType, consumers, file)
  ) {
    return 'text';
  }
  return path;
}

/**
 * Delivery path for one attachment on one agent's turn: the name every turn reader resolves.
 *
 * Returns the path of {@link decideFileReading}. Under classic routing a record the automatic
 * policy never marked gets exactly the classic path from that decision, so it is returned from
 * {@link resolveClassicTurnLLMDeliveryPath} directly, without classifying the file.
 */
export function resolveTurnLLMDeliveryPath(
  routing: Partial<TurnDeliveryRouting> | undefined,
  file: TurnDeliveryFile,
  consumers?: TurnFileConsumers,
): TDefaultLLMDeliveryPath | undefined {
  if (
    resolveLLMDeliveryPolicy(routing?.endpointConfig) !== 'automatic' &&
    file.metadata?.textDerivation == null
  ) {
    return resolveClassicTurnLLMDeliveryPath(routing, file, consumers);
  }
  return decideFileReading({ routing, file, consumers }).path;
}

/**
 * Whether Run Code can read this record on this turn. Depends only on consumers and the record:
 * an enabled Run Code with no sandbox copy yet is eligible, since its first call uploads it.
 */
export function judgeCodeEligibility(
  file: TurnDeliveryFile,
  consumers?: TurnFileConsumers,
): CodeEligibility {
  if (consumers?.executeCode !== true) {
    return 'no_run_code';
  }
  if (isTextOnlyRecord(file)) {
    return 'text_only_record';
  }
  /* The sandbox receives the stored bytes, so compatibility is judged on the stored type. */
  if (!canToolResourceConsume(EToolResources.execute_code, file.type ?? '')) {
    return 'incompatible';
  }
  if (!isOriginalBacked(file)) {
    return 'unstreamable';
  }
  if (
    file.metadata?.destinationChosen === true &&
    !hasToolResourceProvisioning(file, EToolResources.execute_code)
  ) {
    return 'declined';
  }
  return 'eligible';
}

export interface FileReadingInput {
  routing: Partial<TurnDeliveryRouting> | undefined;
  file: TurnDeliveryFile;
  consumers?: TurnFileConsumers;
}

type ReaderVerdict = 'ok' | 'needs_text' | SkipReason;

type ReadingBase = Pick<FileReading, 'classicPath' | 'category' | 'code' | 'automatic'>;

interface ReadingWalk {
  routing: Partial<TurnDeliveryRouting>;
  file: TurnDeliveryFile;
  consumers: TurnFileConsumers;
  mimeType: string;
  category: ReadingCategory;
  code: CodeEligibility;
  evidence: ReadingEvidence;
}

const SEARCH_ONLY: TurnFileConsumers = { executeCode: false, fileSearch: true };

const SELECTED_REASON: Readonly<Record<ReaderKind, ReadingReason>> = {
  code: 'code_selected',
  provider: 'native_supported',
  text: 'text_fits',
  search: 'search_selected',
};

const hasStoredText = (file: TurnDeliveryFile): boolean =>
  typeof file.text === 'string' && file.text.length > 0;

/** Whether text can be derived from the retained original on this request. */
function canDeriveText(
  routing: Partial<TurnDeliveryRouting> | undefined,
  file: TurnDeliveryFile,
  evidence: ReadingEvidence,
): boolean {
  return (
    routing?.reading?.canDerive === true &&
    isOriginalBacked(file) &&
    file.metadata?.textDerivation?.outcome !== 'failed' &&
    evidence.textFailed !== true &&
    selectBuiltInTextPlan(file.type ?? '') != null
  );
}

function judgeProvider({ mimeType, routing, evidence }: ReadingWalk): ReaderVerdict {
  if (
    resolveSystemDeliveryPath(mimeType, routing) !== 'provider' ||
    evidence.native === 'unsupported'
  ) {
    return 'native_unsupported';
  }
  if (evidence.rejected === 'capacity') {
    return 'native_capacity';
  }
  if (evidence.rejected === 'unsupported') {
    return 'native_unsupported';
  }
  if (evidence.rejected === 'integrity') {
    return 'native_rejected';
  }
  if (evidence.native === 'capacity') {
    return 'native_capacity';
  }
  return evidence.overflow === true ? 'aggregate_overflow' : 'ok';
}

function judgeText({ routing, file, evidence }: ReadingWalk): ReaderVerdict {
  if (!hasStoredText(file)) {
    return canDeriveText(routing, file, evidence) ? 'needs_text' : 'text_unavailable';
  }
  if (evidence.text === 'exceeds') {
    return 'text_exceeds';
  }
  return evidence.overflow === true ? 'aggregate_overflow' : 'ok';
}

function judgeSearch({ consumers, file, evidence }: ReadingWalk): ReaderVerdict {
  const reachable =
    consumers.fileSearch &&
    canToolResourceConsume(EToolResources.file_search, file.type ?? '') &&
    isOriginalBacked(file) &&
    evidence.search !== 'unreachable';
  return reachable ? 'ok' : 'search_unavailable';
}

const READER_JUDGES: Readonly<Record<ReaderKind, (walk: ReadingWalk) => ReaderVerdict>> = {
  code: ({ code }) => (code === 'eligible' ? 'ok' : 'code_unavailable'),
  provider: judgeProvider,
  text: judgeText,
  search: judgeSearch,
};

/** Skip reasons naming a limit the file hit, most significant first. */
const LIMIT_SKIPS: readonly SkipReason[] = [
  'native_capacity',
  'native_rejected',
  'aggregate_overflow',
  'text_exceeds',
];

/**
 * The skip that best explains a reading. A limit the file hit outranks a reader that is merely
 * missing, and among missing readers the first the walk judged wins, so the category's preferred
 * reader names the reason. The provider not taking the type, true of most documents, explains a
 * reading only when nothing else does.
 */
function significantSkip(skipped: readonly ReaderSkip[]): SkipReason | undefined {
  const limit = LIMIT_SKIPS.find((reason) => skipped.some((skip) => skip.reason === reason));
  if (limit != null) {
    return limit;
  }
  return (skipped.find(({ reason }) => reason !== 'native_unsupported') ?? skipped[0])?.reason;
}

function selectedReason(
  reader: ReaderKind,
  category: ReadingCategory,
  skipped: readonly ReaderSkip[],
): ReadingReason {
  const skip = significantSkip(skipped);
  if (skip != null) {
    return skip;
  }
  return reader === 'code' && category === 'tabular' ? 'code_preferred' : SELECTED_REASON[reader];
}

/**
 * Judges each reader of the category in order and returns the first that can read the file. A
 * failure may redirect the rest of the walk, and every reader is judged at most once, so the walk
 * ends after at most one judgment per reader.
 */
function walkReaders(walk: ReadingWalk, base: ReadingBase): FileReading {
  const skipped: ReaderSkip[] = [];
  const tried = new Set<ReaderKind>();
  let queue = READING_ORDER[walk.category];
  for (let i = 0; i < queue.length; i++) {
    const reader = queue[i];
    if (tried.has(reader)) {
      continue;
    }
    tried.add(reader);
    const verdict = READER_JUDGES[reader](walk);
    if (verdict === 'ok' || verdict === 'needs_text') {
      return {
        ...base,
        skipped,
        path: READER_PATH[reader],
        reader,
        reason: selectedReason(reader, walk.category, skipped),
        needsText: verdict === 'needs_text',
      };
    }
    skipped.push({ reader, reason: verdict });
    const next = AFTER_FAILURE[walk.category][verdict];
    if (next != null) {
      queue = next;
      i = -1;
    }
  }
  return {
    ...base,
    skipped,
    path: 'none',
    reader: 'unavailable',
    reason: significantSkip(skipped) ?? 'no_reader',
    needsText: false,
  };
}

/** The reader a classic route amounts to, for diagnostics only. */
function classicReader(
  path: TDefaultLLMDeliveryPath | undefined,
  code: CodeEligibility,
  mimeType: string,
  file: TurnDeliveryFile,
  consumers?: TurnFileConsumers,
): FileReading['reader'] {
  if (path == null) {
    return 'unresolved';
  }
  if (path !== 'none') {
    return path;
  }
  if (code === 'eligible') {
    return 'code';
  }
  return consumers?.fileSearch === true && hasTurnFileConsumer(mimeType, SEARCH_ONLY, file)
    ? 'search'
    : 'unavailable';
}

/**
 * The classic route, except for a record the automatic policy marked and left without text: its
 * classic `text` route either derives that text first or, when it cannot, delivers nothing rather
 * than an empty text part.
 */
function classicReading(
  base: ReadingBase,
  { routing, file, consumers }: FileReadingInput,
  mimeType: string,
  reason: ClassicReason,
): FileReading {
  const reading = { ...base, skipped: [], reason, needsText: false };
  const derivation = file.metadata?.textDerivation;
  if (base.classicPath !== 'text' || derivation == null || hasStoredText(file)) {
    const reader = classicReader(base.classicPath, base.code, mimeType, file, consumers);
    return { ...reading, path: base.classicPath, reader };
  }
  const evidence = routing?.reading?.judge(file) ?? {};
  if (derivation.outcome === 'deferred' && canDeriveText(routing, file, evidence)) {
    return { ...reading, path: 'text', reader: 'text', needsText: true };
  }
  return {
    ...reading,
    path: 'none',
    reader: classicReader('none', base.code, mimeType, file, consumers),
  };
}

/** The endpoint file configuration the eligibility gate reads. */
type ReadingConfig = Pick<DeliveryRouteInputs, 'endpointConfig' | 'fileConfig'>;

/** The type routing saw at upload; conversion rewrites the stored type. */
export function getRoutingMimeType(file: TurnDeliveryFile): string {
  return file.metadata?.routingMimeType ?? file.type ?? '';
}

/**
 * Eligibility gates the record and the endpoint's file configuration decide alone: the first that
 * keeps the file on its classic route, or null when none does.
 */
function recordGateReason(
  config: ReadingConfig,
  file: TurnDeliveryFile,
  mimeType: string,
): ClassicReason | null {
  if (file.llmDeliveryPath == null) {
    return 'legacy_record';
  }
  if (resolveLLMDeliveryPolicy(config.endpointConfig) !== 'automatic') {
    return 'classic_policy';
  }
  if (file.metadata?.destinationChosen === true) {
    return 'explicit_destination';
  }
  if (file.metadata?.destinationChosen !== false) {
    return 'unmarked_record';
  }
  if (file.context !== FileContext.message_attachment) {
    return 'not_message_attachment';
  }
  if (isTextOnlyRecord(file)) {
    return 'text_only_record';
  }
  const configured = matchConfiguredDeliveryPath(
    mimeType,
    config.endpointConfig?.defaultLLMDeliveryPath,
    config.fileConfig?.defaultLLMDeliveryPath,
  );
  return configured != null ? 'configured_route' : null;
}

/**
 * Whether the automatic policy reads this record once the turn's consumers are known: every
 * eligibility gate of {@link decideFileReading} except the consumer one. The endpoint filter asks
 * this before consumers exist, so it agrees with the decision on every file the decision judges.
 */
export function isAutomaticReadingRecord(
  config: ReadingConfig | undefined,
  file: TurnDeliveryFile,
): boolean {
  const mimeType = getRoutingMimeType(file);
  return (
    config != null &&
    recordGateReason(config, file, mimeType) == null &&
    categorizeForReading(mimeType) !== 'media'
  );
}

type EligibleReading = Pick<ReadingWalk, 'routing' | 'consumers' | 'category'>;

/** The eligibility gate in precedence order: why a file keeps its classic route, or what the walk reads. */
function gateFileReading(
  { routing, file, consumers }: FileReadingInput,
  mimeType: string,
  category: ReadingCategory | 'media',
): ClassicReason | EligibleReading {
  if (routing == null) {
    return 'legacy_record';
  }
  const recordReason = recordGateReason(routing, file, mimeType);
  if (recordReason != null) {
    return recordReason;
  }
  if (consumers == null) {
    return 'consumers_unknown';
  }
  if (!hasFileToolConsumer(consumers)) {
    return 'no_file_tools';
  }
  if (category === 'media') {
    return 'media_category';
  }
  return { routing, consumers, category };
}

/**
 * How one attachment is read on one agent's turn. Classic routing answers unless every
 * eligibility gate passes; then the category's readers are judged in order against the turn's
 * consumers and evidence. The returned path always stays inside the stored vocabulary.
 */
export function decideFileReading(input: FileReadingInput): FileReading {
  const { routing, file, consumers } = input;
  const mimeType = getRoutingMimeType(file);
  const category = categorizeForReading(mimeType);
  const base: ReadingBase = {
    classicPath: resolveClassicTurnLLMDeliveryPath(routing, file, consumers),
    category,
    code: judgeCodeEligibility(file, consumers),
    automatic: false,
  };
  const gate = gateFileReading(input, mimeType, category);
  if (typeof gate === 'string') {
    return classicReading(base, input, mimeType, gate);
  }
  const evidence = gate.routing.reading?.judge(file) ?? {};
  return walkReaders(
    { ...gate, file, mimeType, code: base.code, evidence },
    { ...base, automatic: true },
  );
}

export interface UploadReadingInput extends DeliveryRouteInputs {
  toolResource?: string | null;
  mimeType: string;
  isMessageAttachment: boolean;
  /**
   * The upload preflight would defer an extracted-text fail-close only for the context route, so
   * that route's extraction is the inspection and a failed extraction must reject the upload.
   */
  extractionRequiredForInspection: boolean;
  /** Undefined until the caller resolves it; asked for only when the decision needs it. */
  codePossible?: boolean;
}

export type UploadReadingReason =
  | 'explicit_destination'
  | 'classic_policy'
  | 'agent_resource'
  | 'configured_route'
  | 'automatic_default'
  | 'inspection_requires_text'
  | 'code_unavailable'
  | 'code_preferred';

export interface UploadReading {
  path: TDefaultLLMDeliveryPath;
  policy: TLLMDeliveryPolicy;
  category: ReadingCategory | 'media';
  reason: UploadReadingReason;
  /** Run Code will read the file, so nothing is extracted at upload. */
  codePreferred: boolean;
  /** Resolve `codePossible`, then decide again. */
  needsCodeAvailability: boolean;
  /**
   * An extraction failure keeps the original, marked failed, instead of rejecting the upload.
   * Never set where an inspection policy relies on that extraction.
   */
  keepOriginalOnExtractionFailure: boolean;
  /** Write `textDerivation: { outcome: 'deferred' }`, since a built-in extractor can derive text later. */
  deferredMarker: boolean;
}

/**
 * How an upload is read, decided before any extraction. Under the automatic policy a tabular
 * message attachment is left to Run Code when code is possible at upload, and other message
 * attachments outside the media rows keep their original when extraction fails, unless an
 * inspection policy relies on that extraction; everything else stays classic.
 */
export function decideUploadReading(input: UploadReadingInput): UploadReading {
  const path = resolveUploadLLMDeliveryPath(input);
  const policy = resolveLLMDeliveryPolicy(input.endpointConfig);
  const category = categorizeForReading(input.mimeType);
  const classic = (
    reason: UploadReadingReason,
    keepOriginalOnExtractionFailure = false,
  ): UploadReading => ({
    path,
    policy,
    category,
    reason,
    codePreferred: false,
    needsCodeAvailability: false,
    keepOriginalOnExtractionFailure,
    deferredMarker: false,
  });

  if (input.toolResource != null) {
    return classic('explicit_destination');
  }
  if (policy !== 'automatic') {
    return classic('classic_policy');
  }
  if (!input.isMessageAttachment) {
    return classic('agent_resource');
  }
  const configured = matchConfiguredDeliveryPath(
    input.mimeType,
    input.endpointConfig?.defaultLLMDeliveryPath,
    input.fileConfig?.defaultLLMDeliveryPath,
  );
  if (configured != null) {
    return classic('configured_route');
  }
  const keepOriginal = category !== 'media' && !input.extractionRequiredForInspection;
  if (
    category !== 'tabular' ||
    !canToolResourceConsume(EToolResources.execute_code, input.mimeType)
  ) {
    return classic('automatic_default', keepOriginal);
  }
  if (input.extractionRequiredForInspection) {
    return classic('inspection_requires_text');
  }
  if (input.codePossible === undefined) {
    return { ...classic('automatic_default', keepOriginal), needsCodeAvailability: true };
  }
  if (!input.codePossible) {
    return classic('code_unavailable', keepOriginal);
  }
  return {
    ...classic('code_preferred'),
    path: 'none',
    codePreferred: true,
    deferredMarker: selectBuiltInTextPlan(input.mimeType) != null,
  };
}

/** Why an upload cannot be accepted, when nothing would be able to read it. */
export type UploadRejection = 'no-agent-resource' | 'context-disabled' | 'no-consumer';

/**
 * Where a unified upload will end up, and whether it can be accepted at all.
 *
 * An upload has to be readable by something: the model, an extraction step, or a file
 * tool. A permanent one has to land on an agent resource too, or storing it succeeds
 * while leaving the agent no reference to it. Both outcomes are decided here rather than
 * discovered later, so a request that would change nothing is refused with a reason.
 *
 * `agentTools` is undefined when no agent record backs the upload, as for an ephemeral
 * agent that exists only for the request. An unknown tool set is not judged.
 */
export function resolveUploadDestination(params: {
  toolResource?: string | null;
  deliveryPath: TDefaultLLMDeliveryPath;
  mimeType: string;
  agentTools?: string[];
  hasAgent: boolean;
  isMessageAttachment: boolean;
  /** True when a message attachment may acquire a compatible tool on a later turn. */
  allowUnknownMessageConsumer?: boolean;
  /** Undefined when not looked up, as for an upload that cannot land on context. */
  contextEnabled?: boolean;
}): { toolResource?: string; rejection?: UploadRejection } {
  const {
    toolResource,
    deliveryPath,
    mimeType,
    agentTools,
    hasAgent,
    isMessageAttachment,
    allowUnknownMessageConsumer = false,
    contextEnabled,
  } = params;

  /* A permanent context resource is only readable while the capability is on: priming
   * skips those ids entirely when it is off, so storing one reports success and leaves
   * the agent a file it can never open. */
  const refusesContext = (resource: string): boolean =>
    resource === EToolResources.context &&
    hasAgent &&
    !isMessageAttachment &&
    contextEnabled === false;

  if (toolResource) {
    const resolved =
      toolResource === EToolResources.ocr ? EToolResources.context : (toolResource as string);
    return refusesContext(resolved)
      ? { rejection: 'context-disabled' }
      : { toolResource: resolved };
  }

  if (deliveryPath === 'text') {
    return refusesContext(EToolResources.context)
      ? { rejection: 'context-disabled' }
      : { toolResource: EToolResources.context };
  }

  /* Skills contribute file tools per turn without being stored on the agent, so this list
   * can name a consumer but its silence proves nothing. Used to file an upload, never to
   * refuse one, and matched on what each tool can actually read so the choice does not
   * depend on the order the agent happens to list its tools in. */
  const consumingTool = agentTools?.find(
    (tool) =>
      (tool === EToolResources.execute_code || tool === EToolResources.file_search) &&
      canToolResourceConsume(tool, mimeType),
  );

  if (deliveryPath === 'none' && consumingTool) {
    return { toolResource: consumingTool };
  }

  if (hasAgent && !isMessageAttachment) {
    return { rejection: 'no-agent-resource' };
  }

  /* Message attachments may acquire a compatible tool after upload. Permanent agent files
   * cannot: they must be assigned to a durable resource before this request returns. */
  if (deliveryPath === 'none' && (!isMessageAttachment || !allowUnknownMessageConsumer)) {
    return { rejection: 'no-consumer' };
  }

  return {};
}
