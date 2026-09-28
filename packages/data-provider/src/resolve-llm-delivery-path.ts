import type { TDefaultLLMDeliveryPath, TDefaultLLMDeliveryPathConfig } from './file-config';
import type { EndpointFileConfig, FileConfig, RegexLike } from './types/files';
import type { CodeEnvReferenceSet } from './codeEnvRef';
import type { TEndpoint } from './config';
import {
  retrievalMimeTypes,
  isExplicitMimeConfig,
  isBedrockDocumentType,
  codeInterpreterMimeTypes,
  fileConfig as baseFileConfig,
} from './file-config';
import {
  EModelEndpoint,
  isOpenAILikeProvider,
  isKnownProviderIdentifier,
  isMediaSupportedProvider,
  isDocumentSupportedProvider,
} from './schemas';
import { normalizeEndpointName } from './utils';
import { EToolResources } from './types/tools';
import { getCodeEnvRefs } from './codeEnvRef';

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

/**
 * Delivery path for an upload that named no tool resource. The legacy chooser makes the
 * destination explicit, so nothing is inferred there.
 */
export function resolveDefaultUploadLLMDeliveryPath({
  mimeType,
  endpointConfig,
  fileConfig,
  endpoint,
  endpointProvider,
  useResponsesApi,
  sttConfigured,
}: {
  mimeType: string;
  endpointConfig?: EndpointFileConfig;
  fileConfig?: FileConfig;
  endpoint?: string;
  /** The provider the endpoint runs as, when the caller knows it: a custom endpoint's
   *  declared dialect at upload time, the agent's resolved provider at turn time. */
  endpointProvider?: string | null;
  useResponsesApi?: boolean;
  sttConfigured?: boolean;
}): TDefaultLLMDeliveryPath {
  if (endpointConfig?.legacyFileUploadUX === true) {
    return 'provider';
  }
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
}: {
  toolResource?: string | null;
  mimeType: string;
  endpointConfig?: EndpointFileConfig;
  fileConfig?: FileConfig;
  endpoint?: string;
  endpointProvider?: string | null;
  useResponsesApi?: boolean;
  sttConfigured?: boolean;
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
}

/** The fields of an attachment record that decide its delivery on a turn. */
export interface TurnDeliveryFile {
  type?: string;
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
 * Delivery path for one attachment on one agent's turn.
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
export function resolveTurnLLMDeliveryPath(
  routing: Partial<TurnDeliveryRouting> | undefined,
  file: TurnDeliveryFile,
  consumers?: TurnFileConsumers,
): TDefaultLLMDeliveryPath | undefined {
  if (routing == null || !hasInferredLLMDeliveryPath(file)) {
    return isLLMDeliveryPath(file.llmDeliveryPath) ? file.llmDeliveryPath : undefined;
  }
  const { endpointConfig } = routing;
  /* Conversion changes the stored type, so use the type routing originally saw. */
  const mimeType = file.metadata?.routingMimeType ?? file.type ?? '';
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
