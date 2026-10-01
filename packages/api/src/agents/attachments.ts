import { logger } from '@librechat/data-schemas';
import {
  FileContext,
  FileSources,
  EModelEndpoint,
  mergeFileConfig,
  getEndpointFileConfig,
} from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { TokenCountFn } from '~/utils/text';
import type { ServerRequest } from '~/types';
import { filterFilesByEndpointRuntimeConfig } from '~/files/filter';
import { AGENT_ATTACHMENT_LIMIT_EXCEEDED } from './errors';
import { countTokens } from '~/utils/tokenizer';
import { extractFileContext } from '~/files';

type FileWithId = {
  file_id?: string | null;
};

type AttachmentTelemetryFile = FileWithId & {
  bytes?: number | null;
  source?: string | null;
  type?: string | null;
  text?: string | null;
  context?: string | null;
  embedded?: boolean | null;
  llmDeliveryPath?: string | null;
  metadata?: (IMongoFile['metadata'] & { pageCount?: number | null }) | null;
};

/**
 * Whether a record without a delivery route belongs to a tool rather than to the prompt.
 *
 * A code output lives in the sandbox that wrote it, and it stays the tool's while an expired
 * sandbox copy is re-provisioned: priming clears the dead references on the turn's copy of the
 * record, which must not turn the output into a prompt attachment that counts toward the turn's
 * limits. Any other record belongs to a tool once a tool has provisioned it.
 */
export function isToolOwnedAttachment(file: AttachmentTelemetryFile): boolean {
  const metadata = file.metadata as
    | (IMongoFile['metadata'] & { fileIdentifier?: unknown })
    | null
    | undefined;
  return (
    file.context === FileContext.execute_code ||
    file.embedded === true ||
    metadata?.codeEnvRef != null ||
    metadata?.codeEnvRefs != null ||
    metadata?.fileIdentifier != null
  );
}

/** Whether a hydrated file contributes content to the model prompt itself. */
export function isModelBoundAttachmentFile(
  file: AttachmentTelemetryFile | null | undefined,
): boolean {
  if (!file) {
    return false;
  }
  const source = file.source ?? FileSources.local;
  if (source === FileSources.text) {
    return typeof file.text === 'string' && file.text.length > 0;
  }
  if (file.llmDeliveryPath === 'text') {
    return typeof file.text === 'string' && file.text.length > 0;
  }
  if (file.llmDeliveryPath === 'none') {
    return false;
  }
  if (file.llmDeliveryPath === 'provider') {
    return true;
  }
  return !isToolOwnedAttachment(file);
}

type AgentAttachmentLimitRequest = {
  config?: {
    fileConfig?: Parameters<typeof mergeFileConfig>[0];
  };
};

type DynamicFileConfig = Parameters<typeof mergeFileConfig>[0];
type EndpointFileConfigs = NonNullable<NonNullable<DynamicFileConfig>['endpoints']>;

function normalizeEndpointConfigKey(value: string | null | undefined): string {
  const name = value ?? '';
  return name.toLowerCase() === 'ollama' ? 'ollama' : name;
}

function findEndpointConfig(endpoints: EndpointFileConfigs, candidate: string | null | undefined) {
  if (!candidate) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(endpoints, candidate)) {
    return endpoints[candidate];
  }
  const normalizedCandidate = normalizeEndpointConfigKey(candidate);
  return Object.entries(endpoints).find(
    ([key]) => normalizeEndpointConfigKey(key) === normalizedCandidate,
  )?.[1];
}

function getExplicitEndpointAggregateLimit(
  fileConfig: Parameters<typeof mergeFileConfig>[0],
  endpoint: string | null | undefined,
  endpointType: string | null | undefined,
): number | undefined {
  const endpoints = fileConfig?.endpoints ?? {};
  const normalizedEndpoint = normalizeEndpointConfigKey(endpoint);
  const standardEndpoints = new Set(
    [
      EModelEndpoint.agents,
      EModelEndpoint.assistants,
      EModelEndpoint.azureAssistants,
      EModelEndpoint.openAI,
      EModelEndpoint.azureOpenAI,
      EModelEndpoint.anthropic,
      EModelEndpoint.google,
      EModelEndpoint.bedrock,
    ].map(normalizeEndpointConfigKey),
  );
  const isCustomEndpoint =
    endpointType === EModelEndpoint.custom ||
    (normalizedEndpoint.length > 0 && !standardEndpoints.has(normalizedEndpoint));
  let selectedConfig;
  if (isCustomEndpoint) {
    selectedConfig =
      findEndpointConfig(endpoints, endpoint) ??
      findEndpointConfig(endpoints, EModelEndpoint.custom) ??
      findEndpointConfig(endpoints, EModelEndpoint.agents);
  } else {
    selectedConfig =
      findEndpointConfig(endpoints, endpointType) ?? findEndpointConfig(endpoints, endpoint);
    if (selectedConfig?.totalSizeLimit === undefined) {
      selectedConfig = findEndpointConfig(endpoints, EModelEndpoint.agents) ?? selectedConfig;
    }
  }
  const configuredLimit = selectedConfig?.totalSizeLimit ?? endpoints.default?.totalSizeLimit;
  return configuredLimit === undefined ? undefined : configuredLimit * 1024 * 1024;
}

function getExplicitEndpointFileLimit(
  fileConfig: Parameters<typeof mergeFileConfig>[0],
  endpoint: string | null | undefined,
  endpointType: string | null | undefined,
  fallbackLimit: number | undefined,
): number | undefined {
  const endpoints = fileConfig?.endpoints ?? {};
  const resolveSelectedLimit = (config: ReturnType<typeof findEndpointConfig>) =>
    config == null
      ? undefined
      : (config.fileLimit ?? endpoints.default?.fileLimit ?? fallbackLimit);
  const normalizedEndpoint = normalizeEndpointConfigKey(endpoint);
  const standardEndpoints = new Set(
    [
      EModelEndpoint.agents,
      EModelEndpoint.assistants,
      EModelEndpoint.azureAssistants,
      EModelEndpoint.openAI,
      EModelEndpoint.azureOpenAI,
      EModelEndpoint.anthropic,
      EModelEndpoint.google,
      EModelEndpoint.bedrock,
    ].map(normalizeEndpointConfigKey),
  );
  const isCustomEndpoint =
    endpointType === EModelEndpoint.custom ||
    (normalizedEndpoint.length > 0 && !standardEndpoints.has(normalizedEndpoint));
  if (isCustomEndpoint) {
    const namedConfig = findEndpointConfig(endpoints, endpoint);
    if (namedConfig) {
      return resolveSelectedLimit(namedConfig);
    }
    return resolveSelectedLimit(findEndpointConfig(endpoints, EModelEndpoint.custom));
  }
  return (
    findEndpointConfig(endpoints, endpointType)?.fileLimit ??
    findEndpointConfig(endpoints, endpoint)?.fileLimit
  );
}

export type AgentAttachmentLimit = 'count' | 'bytes' | 'extracted_text';

export interface AgentAttachmentStats {
  attachmentCount: number;
  totalKnownBytes: number;
  extractedTextChars: number;
  files: Array<{
    fileId?: string;
    mimeType?: string;
    bytes?: number;
    extractedTextChars?: number;
    pageCount?: number;
  }>;
}

export class AgentAttachmentLimitError extends Error {
  readonly code: typeof AGENT_ATTACHMENT_LIMIT_EXCEEDED = AGENT_ATTACHMENT_LIMIT_EXCEEDED;
  readonly status = 413;
  readonly statusCode = 413;

  constructor(
    readonly limitType: AgentAttachmentLimit,
    readonly observed: number,
    readonly limit: number,
  ) {
    const labels: Record<AgentAttachmentLimit, string> = {
      count: 'attachment count',
      bytes: 'total attachment size',
      extracted_text: 'extracted document text',
    };
    super(
      `This turn exceeds the configured ${labels[limitType]} limit (${observed} > ${limit}). Remove some attachments or use smaller files and try again.`,
    );
    this.name = 'AgentAttachmentLimitError';
  }
}

export class AgentAttachmentPolicyError extends Error {
  readonly code: typeof AGENT_ATTACHMENT_LIMIT_EXCEEDED = AGENT_ATTACHMENT_LIMIT_EXCEEDED;
  readonly status = 413;
  readonly statusCode = 413;

  constructor() {
    super(
      'An attachment is not supported by every agent in this run. Remove it or use compatible agents and try again.',
    );
    this.name = 'AgentAttachmentPolicyError';
  }
}

export function isAgentAttachmentLimitError(
  error: unknown,
): error is AgentAttachmentLimitError | AgentAttachmentPolicyError {
  return error instanceof AgentAttachmentLimitError || error instanceof AgentAttachmentPolicyError;
}

export function collectAgentAttachmentStats(
  attachments?: Iterable<AttachmentTelemetryFile | null | undefined> | null,
  options: { countRepeatedExtractedText?: boolean; countRepeatedBytes?: boolean } = {},
): AgentAttachmentStats {
  const stats: AgentAttachmentStats = {
    attachmentCount: 0,
    totalKnownBytes: 0,
    extractedTextChars: 0,
    files: [],
  };
  const seenFileIds = new Set<string>();

  for (const file of attachments ?? []) {
    if (!file) {
      continue;
    }
    const extractedTextChars = typeof file.text === 'string' ? file.text.length : 0;
    if (file.file_id && seenFileIds.has(file.file_id)) {
      if (options.countRepeatedExtractedText === true) {
        stats.extractedTextChars += extractedTextChars;
      }
      if (options.countRepeatedBytes === true) {
        stats.totalKnownBytes +=
          Number.isFinite(file.bytes) && Number(file.bytes) >= 0 ? Number(file.bytes) : 0;
      }
      continue;
    }
    if (file.file_id) {
      seenFileIds.add(file.file_id);
    }

    const bytes = Number.isFinite(file.bytes) && Number(file.bytes) >= 0 ? Number(file.bytes) : 0;
    const pageCount =
      Number.isFinite(file.metadata?.pageCount) && Number(file.metadata?.pageCount) >= 0
        ? Number(file.metadata?.pageCount)
        : undefined;
    stats.attachmentCount += 1;
    stats.totalKnownBytes += bytes;
    stats.extractedTextChars += extractedTextChars;
    stats.files.push({
      ...(file.file_id && { fileId: file.file_id }),
      ...(file.type && { mimeType: file.type }),
      ...(bytes > 0 && { bytes }),
      ...(extractedTextChars > 0 && { extractedTextChars }),
      ...(pageCount != null && { pageCount }),
    });
  }

  return stats;
}

export function assertAgentAttachmentLimits({
  attachments,
  req,
  fileConfig: providedFileConfig,
  endpoint = EModelEndpoint.agents,
  endpointType,
  countRepeatedExtractedText = false,
  countRepeatedBytes = countRepeatedExtractedText,
  enforceAttachmentCount = true,
  useGlobalContextSizeLimit = false,
}: {
  attachments?: Iterable<AttachmentTelemetryFile | null | undefined> | null;
  req?: AgentAttachmentLimitRequest;
  fileConfig?: Parameters<typeof mergeFileConfig>[0];
  endpoint?: string | null;
  endpointType?: string | null;
  countRepeatedExtractedText?: boolean;
  countRepeatedBytes?: boolean;
  enforceAttachmentCount?: boolean;
  useGlobalContextSizeLimit?: boolean;
}): AgentAttachmentStats {
  const stats = collectAgentAttachmentStats(attachments, {
    countRepeatedExtractedText,
    countRepeatedBytes,
  });
  const dynamicFileConfig = providedFileConfig ?? req?.config?.fileConfig;
  const fileConfig = mergeFileConfig(dynamicFileConfig);
  const endpointConfig = getEndpointFileConfig({ fileConfig, endpoint, endpointType });
  const configuredFileLimit =
    getExplicitEndpointFileLimit(
      dynamicFileConfig,
      endpoint,
      endpointType,
      endpointConfig.fileLimit,
    ) ??
    dynamicFileConfig?.endpoints?.[EModelEndpoint.agents]?.fileLimit ??
    endpointConfig.fileLimit;
  const configuredContextSizeLimit =
    (useGlobalContextSizeLimit
      ? undefined
      : getExplicitEndpointAggregateLimit(dynamicFileConfig, endpoint, endpointType)) ??
    fileConfig.fileContextSizeLimit;
  const configuredContextCharLimit = dynamicFileConfig?.fileContextCharLimit;
  const limits: Array<[AgentAttachmentLimit, number, number | undefined]> = [
    ['count', stats.attachmentCount, enforceAttachmentCount ? configuredFileLimit : undefined],
    ['bytes', stats.totalKnownBytes, configuredContextSizeLimit],
    [
      'extracted_text',
      stats.extractedTextChars,
      configuredContextCharLimit ?? fileConfig.fileContextCharLimit,
    ],
  ];

  for (const [limitType, observed, limit] of limits) {
    if (limit != null && limit > 0 && observed > limit) {
      throw new AgentAttachmentLimitError(limitType, observed, limit);
    }
  }

  return stats;
}

export function assertAgentAttachmentTopology({
  sharedAttachments = [],
  scopedAttachmentsByAgentId = new Map(),
  req,
  endpoint,
  endpointType,
  endpointsByAgentId,
}: {
  sharedAttachments?: IMongoFile[];
  scopedAttachmentsByAgentId?: Map<string, IMongoFile[]>;
  req?: ServerRequest;
  endpoint?: string | null;
  endpointType?: string | null;
  endpointsByAgentId?: AgentAttachmentEndpointsByAgentId;
}): void {
  const agentIds = new Set([
    ...scopedAttachmentsByAgentId.keys(),
    ...(endpointsByAgentId instanceof Map
      ? endpointsByAgentId.keys()
      : Object.keys(endpointsByAgentId ?? {})),
  ]);
  for (const agentId of agentIds) {
    const agentEndpoint =
      endpointsByAgentId instanceof Map
        ? endpointsByAgentId.get(agentId)
        : endpointsByAgentId?.[agentId];
    const compatibleSharedAttachments = filterFilesByEndpointRuntimeConfig(req?.config, {
      files: sharedAttachments,
      endpoint: agentEndpoint?.endpoint ?? endpoint ?? EModelEndpoint.agents,
      endpointType: agentEndpoint?.endpointType ?? endpointType,
      skipTotalSizeLimit: true,
      preserveTextSources: true,
    });
    if (compatibleSharedAttachments.length !== sharedAttachments.length) {
      throw new AgentAttachmentPolicyError();
    }
    assertAgentAttachmentLimits({
      attachments: [
        ...compatibleSharedAttachments,
        ...(scopedAttachmentsByAgentId.get(agentId) ?? []),
      ],
      req,
      endpoint: agentEndpoint?.endpoint,
      endpointType: agentEndpoint?.endpointType,
      countRepeatedExtractedText: true,
    });
  }
  assertAgentAttachmentLimits({
    attachments: [...scopedAttachmentsByAgentId.values()].flat(),
    req,
    endpoint,
    endpointType,
    countRepeatedExtractedText: true,
    enforceAttachmentCount: false,
    useGlobalContextSizeLimit: true,
  });
}

type AgentMemoryPhase =
  | 'before_process_attachments'
  | 'after_process_attachments'
  | 'before_encode_documents'
  | 'after_encode_documents'
  | 'before_context_assembly'
  | 'after_context_assembly'
  | 'before_model'
  | 'after_model'
  | 'model_error'
  | 'before_terminal_save'
  | 'after_terminal_save'
  | 'before_final_publish'
  | 'after_final_publish';

interface AgentMemoryContext {
  req?: ServerRequest;
  conversationId?: string | null;
  messageId?: string | null;
  attachments?: Iterable<AttachmentTelemetryFile | null | undefined> | null;
  countRepeatedExtractedText?: boolean;
}

export function logAgentMemorySnapshot(
  phase: AgentMemoryPhase,
  context: AgentMemoryContext,
  modelRunId?: string,
): void {
  const attachments = collectAgentAttachmentStats(context.attachments, {
    countRepeatedExtractedText: context.countRepeatedExtractedText,
    countRepeatedBytes: context.countRepeatedExtractedText,
  });
  if (attachments.attachmentCount === 0) {
    return;
  }
  const memory = process.memoryUsage();
  logger.info('[AgentAttachmentMemory] snapshot', {
    phase,
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers ?? 0,
    conversationId: context.conversationId,
    messageId: context.messageId,
    jobId: (context.req as (ServerRequest & { _resumableStreamId?: string }) | undefined)
      ?._resumableStreamId,
    userId: context.req?.user?.id,
    tenantId: context.req?.user?.tenantId,
    modelRunId,
    ...attachments,
  });
}

export function createAgentMemoryCallback(context: AgentMemoryContext): {
  name: string;
  handleChatModelStart: (...args: unknown[]) => void;
  handleLLMStart: (...args: unknown[]) => void;
  handleLLMEnd: (_output: unknown, runId: string) => void;
  handleLLMError: (_error: unknown, runId: string) => void;
} {
  const startedRuns = new Set<string>();
  const logStart = (...args: unknown[]): void => {
    const runId = typeof args[2] === 'string' ? args[2] : undefined;
    if (runId && startedRuns.has(runId)) {
      return;
    }
    if (runId) {
      startedRuns.add(runId);
    }
    logAgentMemorySnapshot('before_model', context, runId);
  };
  const logEnd = (phase: 'after_model' | 'model_error', runId: string): void => {
    startedRuns.delete(runId);
    logAgentMemorySnapshot(phase, context, runId);
  };

  return {
    name: 'librechat-agent-attachment-memory',
    handleChatModelStart: logStart,
    handleLLMStart: logStart,
    handleLLMEnd: (_output, runId) => logEnd('after_model', runId),
    handleLLMError: (_error, runId) => logEnd('model_error', runId),
  };
}

export type AgentContextAttachmentCarrier<TFile extends FileWithId = IMongoFile> = {
  id?: string | null;
  agentContextAttachments?: TFile[] | null;
  subagentAgentConfigs?: AgentContextAttachmentCarrier<TFile>[] | null;
  subagentGraphConfigs?: Array<{
    memberConfigs?: AgentContextAttachmentCarrier<TFile>[] | null;
  }> | null;
};

export type AgentContextAttachmentsByAgentId<TFile extends FileWithId = IMongoFile> =
  | Map<string, TFile[]>
  | Record<string, TFile[] | undefined>
  | null
  | undefined;

export type AgentAttachmentEndpointsByAgentId =
  | Map<string, { endpoint?: string | null; endpointType?: string | null }>
  | Record<string, { endpoint?: string | null; endpointType?: string | null }>;

export function collectFileIds<TFile extends FileWithId>(
  files?: Array<TFile | null | undefined> | null,
): Set<string> {
  const fileIds = new Set<string>();
  for (const file of files ?? []) {
    if (file?.file_id) {
      fileIds.add(file.file_id);
    }
  }
  return fileIds;
}

export function buildAgentContextAttachmentsByAgentId<TFile extends FileWithId>(
  configs: Iterable<AgentContextAttachmentCarrier<TFile> | null | undefined>,
): Map<string, TFile[]> {
  const attachmentsByAgentId = new Map<string, TFile[]>();
  const visited = new Set<string>();
  const pending = [...configs];

  for (let index = 0; index < pending.length; index++) {
    const config = pending[index];
    if (!config?.id || visited.has(config.id)) {
      continue;
    }
    visited.add(config.id);
    if (config.agentContextAttachments?.length) {
      attachmentsByAgentId.set(config.id, config.agentContextAttachments);
    }
    pending.push(...(config.subagentAgentConfigs ?? []));
    for (const graph of config.subagentGraphConfigs ?? []) {
      pending.push(...(graph.memberConfigs ?? []));
    }
  }

  return attachmentsByAgentId;
}

export function getAgentContextAttachments<TFile extends FileWithId>({
  agentId,
  attachmentsByAgentId,
  excludeFileIds,
}: {
  agentId: string;
  attachmentsByAgentId: AgentContextAttachmentsByAgentId<TFile>;
  excludeFileIds?: Set<string>;
}): TFile[] {
  if (!attachmentsByAgentId) {
    return [];
  }

  const attachments: TFile[] =
    attachmentsByAgentId instanceof Map
      ? (attachmentsByAgentId.get(agentId) ?? [])
      : (attachmentsByAgentId[agentId] ?? []);

  if (!excludeFileIds || excludeFileIds.size === 0) {
    return attachments;
  }

  return attachments.filter((file) => !file?.file_id || !excludeFileIds.has(file.file_id));
}

export function buildAgentScopedAttachmentMap({
  agentIds,
  attachmentsByAgentId,
  sharedRunAttachmentIds,
  req,
  endpoint,
  endpointType,
  endpointsByAgentId,
}: {
  agentIds: string[];
  attachmentsByAgentId: AgentContextAttachmentsByAgentId<IMongoFile>;
  sharedRunAttachmentIds?: Set<string>;
  req?: ServerRequest;
  endpoint?: string | null;
  endpointType?: string | null;
  endpointsByAgentId?: AgentAttachmentEndpointsByAgentId;
}): Map<string, IMongoFile[]> {
  const entries = Array.from(new Set(agentIds.filter(Boolean))).map((agentId) => {
    const agentEndpoint =
      endpointsByAgentId instanceof Map
        ? endpointsByAgentId.get(agentId)
        : endpointsByAgentId?.[agentId];
    const attachments = getAgentContextAttachments({
      agentId,
      attachmentsByAgentId,
      excludeFileIds: sharedRunAttachmentIds,
    }).filter(isModelBoundAttachmentFile);
    return [
      agentId,
      filterFilesByEndpointRuntimeConfig(req?.config, {
        files: attachments,
        endpoint: agentEndpoint?.endpoint ?? endpoint ?? EModelEndpoint.agents,
        endpointType: agentEndpoint?.endpointType ?? endpointType,
        skipTotalSizeLimit: true,
        preserveTextSources: true,
      }),
    ] as const;
  });
  return new Map(entries);
}

export async function buildAgentScopedContext({
  agentIds,
  attachmentsByAgentId,
  sharedRunAttachmentIds,
  sharedAttachments = [],
  req,
  tokenCountFn = countTokens,
  endpoint,
  endpointType,
  endpointsByAgentId,
}: {
  agentIds: string[];
  attachmentsByAgentId: AgentContextAttachmentsByAgentId<IMongoFile>;
  sharedRunAttachmentIds?: Set<string>;
  sharedAttachments?: IMongoFile[];
  req?: ServerRequest;
  tokenCountFn?: TokenCountFn;
  endpoint?: string | null;
  endpointType?: string | null;
  endpointsByAgentId?: AgentAttachmentEndpointsByAgentId;
}): Promise<Map<string, string>> {
  const attachmentEntries = [
    ...buildAgentScopedAttachmentMap({
      agentIds,
      attachmentsByAgentId,
      sharedRunAttachmentIds,
      req,
      endpoint,
      endpointType,
      endpointsByAgentId,
    }),
  ];
  assertAgentAttachmentTopology({
    sharedAttachments,
    scopedAttachmentsByAgentId: new Map(attachmentEntries),
    req,
    endpoint,
    endpointType,
    endpointsByAgentId,
  });
  const entries = await Promise.all(
    attachmentEntries.map(async ([agentId, attachments]) => {
      if (attachments.length === 0) {
        return [agentId, ''] as const;
      }

      const context = await extractFileContext({
        attachments,
        req,
        tokenCountFn,
      });
      return [agentId, context ?? ''] as const;
    }),
  );

  return new Map(entries.filter(([, context]) => Boolean(context)));
}
