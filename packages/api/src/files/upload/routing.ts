import {
  Providers,
  EModelEndpoint,
  EToolResources,
  mergeFileConfig,
  isExplicitMimeConfig,
  isOpenAILikeProvider,
  isKnownProviderIdentifier,
  isAssistantsEndpoint,
  isResponsesApiUpload,
  getEndpointFileConfig,
  resolveUploadLLMDeliveryPath,
  isSpeechProviderConfigured,
  getCustomEndpointProvider,
} from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import { UnsupportedProviderAudioError } from './errors';
import { getAudioFormat } from '~/files/encode/utils';

/** The subset of an agent record this module reads. */
export interface UploadAgent {
  provider?: string;
}

/** The subset of upload metadata that determines where a file is routed. */
export interface UploadMetadata {
  endpoint?: string;
  agent_id?: string;
  tool_resource?: string | null;
  /** Azure carries native documents only through the Responses API. Multipart form data
   *  carries it as a string, so it arrives as "true" rather than a boolean. */
  useResponsesApi?: boolean | string;
}

/** The uploaded file fields routing depends on. */
export interface UploadFile {
  mimetype: string;
  originalname?: string;
}

export type GetUploadAgent = (params: { id: string }) => Promise<UploadAgent | null>;

/** Request-scoped cache of the upload's agent, keyed by agent id. */
interface UploadAgentCarrier {
  _uploadAgentCache?: Map<string, Promise<UploadAgent | null>>;
}

/**
 * Reads the upload's agent once per request. Routing, authorization and processing each
 * need it, and this runs before any bytes are handled, so repeating the read adds a round
 * trip to every upload.
 */
export function resolveUploadAgent(
  req: ServerRequest,
  agentId: string | undefined,
  getAgent: GetUploadAgent,
): Promise<UploadAgent | null> {
  if (!agentId) {
    return Promise.resolve(null);
  }
  const carrier = req as ServerRequest & UploadAgentCarrier;
  if (!carrier._uploadAgentCache) {
    carrier._uploadAgentCache = new Map();
  }
  const cached = carrier._uploadAgentCache.get(agentId);
  if (cached) {
    return cached;
  }
  const pending = getAgent({ id: agentId });
  carrier._uploadAgentCache.set(agentId, pending);
  return pending;
}

/**
 * Agent uploads carry endpoint `agents`; the agent's own provider governs both the file
 * configuration used for validation and the delivery-path routing.
 *
 * An assistants upload has its own pipeline and never files anything against an agent, so
 * an `agent_id` on one names a record the request has no business reading: the agent
 * authorization gate does not run for assistants, and the provider it resolved would
 * still shape the validation errors the caller sees.
 */
export async function resolveUploadEndpoint({
  req,
  metadata,
  getAgent,
}: {
  req: ServerRequest;
  metadata: UploadMetadata;
  getAgent: GetUploadAgent;
}): Promise<string | undefined> {
  if (!metadata.agent_id || isAssistantsEndpoint(metadata.endpoint)) {
    return metadata.endpoint;
  }
  const agent = await resolveUploadAgent(req, metadata.agent_id, getAgent);
  return agent?.provider || metadata.endpoint;
}

/**
 * The destination this upload will actually be processed under. A unified upload names no
 * tool resource but is promoted to a text context when routing sends it there, and both
 * the content preflight and the image route have to agree with the processing path about
 * where the file is going.
 */
export async function resolveEffectiveToolResource({
  req,
  metadata,
  getAgent,
}: {
  req: ServerRequest;
  metadata: UploadMetadata;
  getAgent: GetUploadAgent;
}): Promise<string | undefined> {
  if (metadata.tool_resource === EToolResources.ocr) {
    return EToolResources.context;
  }
  if (metadata.tool_resource) {
    return metadata.tool_resource;
  }

  const fileConfig = mergeFileConfig(req.config?.fileConfig);
  const endpoint = await resolveUploadEndpoint({ req, metadata, getAgent });
  const endpointConfig = getEndpointFileConfig({ fileConfig, endpoint });
  const endpointProvider = getCustomEndpointProvider(req.config?.endpoints?.custom, endpoint);
  const file = req.file as UploadFile;
  const path = resolveUploadLLMDeliveryPath({
    toolResource: metadata.tool_resource,
    mimeType: file.mimetype,
    endpointConfig,
    fileConfig,
    endpoint,
    endpointProvider,
    useResponsesApi: isResponsesApiUpload(metadata.useResponsesApi),
    sttConfigured: isSpeechProviderConfigured(req.config?.speech?.stt),
  });
  const provider =
    endpointProvider ?? (isKnownProviderIdentifier(endpoint) ? endpoint : EModelEndpoint.openAI);
  const usesInputAudio =
    provider?.toLowerCase() === Providers.OPENROUTER ||
    (isOpenAILikeProvider(provider) &&
      isExplicitMimeConfig(endpointConfig.supportedMimeTypes) &&
      fileConfig.checkType?.(file.mimetype, endpointConfig.supportedMimeTypes));
  if (
    path === 'provider' &&
    endpoint != null &&
    endpoint !== EModelEndpoint.agents &&
    !isAssistantsEndpoint(endpoint) &&
    file.mimetype.startsWith('audio/') &&
    usesInputAudio &&
    !getAudioFormat(file.mimetype, file.originalname ?? '')
  ) {
    throw new UnsupportedProviderAudioError();
  }
  return path === 'text' ? EToolResources.context : undefined;
}
