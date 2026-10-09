import { formatMessage } from '@librechat/agents';
import { HumanMessage } from '@librechat/agents/langchain';
import {
  FileSources,
  EModelEndpoint,
  isBedrockDocumentType,
  resolveTurnLLMDeliveryPath,
} from 'librechat-data-provider';
import type {
  TFile,
  ImageDetail,
  TurnDeliveryRouting,
  TurnFileConsumers,
} from 'librechat-data-provider';
import type { BaseMessage } from '@librechat/agents/langchain';
import type {
  ServerRequest,
  StrategyFunctions,
  DocumentRejection,
  NativeValidationMode,
} from '~/types';
import type { TurnTextOptions } from '~/files/reading';
import type { TokenCountFn } from '~/utils/text';
import {
  isToolOwnedAttachment,
  isModelBoundAttachmentFile,
  measureModelBoundAttachment,
  assertAgentAttachmentLimits,
  resolveAgentAttachmentLimits,
  AgentAttachmentPolicyError,
} from '../attachments';
import {
  prepareTurnFiles,
  settleTurnFiles,
  renderLeftOutFiles,
  getTurnTextOptions,
  encodeNativeDocuments,
  recordNativeRejections,
} from '~/files/reading';
import { assertModelBoundContent } from '~/middleware/modelBoundContent';
import { toClassicInspectionView, applyTurnDelivery } from './delivery';
import { filterFilesByEndpointRuntimeConfig } from '~/files/filter';
import { countTokens } from '~/utils/tokenizer';

type ContentBlock = Exclude<BaseMessage['content'], string>[number];

/** The already loaded child configuration; storage documents never cross this boundary. */
export interface RunFileEncodingAgent {
  provider: string;
  model?: string | null;
  model_parameters?: { model?: string };
  imageDetail?: ImageDetail;
  agentContextAttachments?: readonly TFile[];
  /** How the child receives attachments, settled when its configuration was initialized. */
  deliveryRouting: TurnDeliveryRouting;
  fileConsumers?: TurnFileConsumers;
}

export interface RunFileEncodingParams {
  provider: string;
  endpoint: string;
  model?: string;
  useResponsesApi?: boolean;
  imageDetail?: ImageDetail;
}

/** The document encoder also learns whether to leave out a file it cannot send. */
export interface RunFileDocumentEncodingParams extends RunFileEncodingParams {
  onValidationFailure?: NativeValidationMode;
}

type MediaEncoder<T, P extends RunFileEncodingParams = RunFileEncodingParams> = (
  req: ServerRequest,
  files: TFile[],
  params: P,
  getStrategyFunctions: (source: string) => StrategyFunctions,
) => Promise<T>;

/** Adapters bind the existing attachment encoders to the host's storage strategies. */
export interface RunFileMessageEncoderDeps {
  req: ServerRequest;
  getAgent: (agentId: string) => RunFileEncodingAgent | undefined;
  encodeImages: MediaEncoder<{ image_urls: ContentBlock[] }>;
  encodeDocuments: MediaEncoder<
    { documents: ContentBlock[]; rejected?: readonly DocumentRejection[] },
    RunFileDocumentEncodingParams
  >;
  encodeAudios: MediaEncoder<{ audios: ContentBlock[] }>;
  encodeVideos: MediaEncoder<{ videos: ContentBlock[] }>;
  getStrategyFunctions: (source: string) => StrategyFunctions;
  extractText: (
    params: {
      attachments: TFile[];
      req: ServerRequest;
      tokenCountFn: TokenCountFn;
    } & TurnTextOptions,
  ) => Promise<string | undefined>;
}

export interface RunFileMessageEncoder {
  validate: (files: TFile[], agentId: string) => void;
  encode: (files: TFile[], agentId: string) => Promise<BaseMessage[]>;
}

/** Encodes authorized run files for the receiving child, without provisioning new resources. */
export function createRunFileMessageEncoder(
  deps: RunFileMessageEncoderDeps,
): RunFileMessageEncoder {
  function resolveAgent(agentId: string): RunFileEncodingAgent {
    const agent = deps.getAgent(agentId);
    if (!agent) {
      throw new Error('The target agent is not available for shared file delivery.');
    }
    return agent;
  }

  function prepare(files: TFile[], agent: RunFileEncodingAgent) {
    const { deliveryRouting } = agent;
    const { endpoint, fileConfig, endpointConfig } = deliveryRouting;
    const params: RunFileEncodingParams = {
      provider: agent.provider,
      endpoint,
      model: agent.model_parameters?.model ?? agent.model ?? undefined,
      useResponsesApi: deliveryRouting.useResponsesApi,
      imageDetail: agent.imageDetail,
    };

    const resolveDelivery = (file: TFile): TFile => {
      const llmDeliveryPath = resolveTurnLLMDeliveryPath(
        deliveryRouting,
        file,
        agent.fileConsumers,
      );
      if (llmDeliveryPath == null || llmDeliveryPath === file.llmDeliveryPath) {
        return file;
      }
      return { ...file, llmDeliveryPath };
    };
    const sharedFiles = files.map(resolveDelivery);
    const compatibleFiles = filterFilesByEndpointRuntimeConfig(deps.req.config, {
      files: sharedFiles,
      endpoint,
      skipTotalSizeLimit: true,
      preserveTextSources: true,
      consumers: agent.fileConsumers,
    });
    if (compatibleFiles.length !== sharedFiles.length) {
      throw new AgentAttachmentPolicyError();
    }
    const budgetFiles = new Map(
      [...(agent.agentContextAttachments ?? []).map(resolveDelivery), ...sharedFiles].map(
        (file) => [file.file_id, file] as const,
      ),
    );
    assertAgentAttachmentLimits({
      attachments: [...budgetFiles.values()].filter(
        (file) => file.llmDeliveryPath !== 'none' && isModelBoundAttachmentFile(file),
      ),
      req: deps.req,
      endpoint,
    });
    assertModelBoundContent({
      filters: deps.req.config?.filters,
      files: toClassicInspectionView(sharedFiles, deliveryRouting, agent.fileConsumers),
    });
    return { agent, params, sharedFiles, fileConfig, endpointConfig };
  }

  function validate(files: TFile[], agentId: string): void {
    if (files.length > 0) prepare(files, resolveAgent(agentId));
  }

  async function encode(files: TFile[], agentId: string): Promise<BaseMessage[]> {
    if (files.length === 0) return [];
    const target = resolveAgent(agentId);
    const turnFiles = await prepareTurnFiles({
      routing: target.deliveryRouting,
      files,
      consumers: target.fileConsumers,
    });
    const { agent, params, sharedFiles, fileConfig, endpointConfig } = prepare(turnFiles, target);
    const images: TFile[] = [];
    const documents: TFile[] = [];
    const audios: TFile[] = [];
    const videos: TFile[] = [];
    const textFiles: TFile[] = [];
    for (const file of sharedFiles) {
      const deliveryPath = file.llmDeliveryPath;
      if (deliveryPath === 'none') {
        continue;
      }
      if (deliveryPath === 'text' && !file.text) {
        throw new Error(
          `Shared file "${file.filename}" requires extracted text for this agent. Attach a text version or use an agent that supports the original file.`,
        );
      }
      if (deliveryPath == null || deliveryPath === 'text') {
        textFiles.push(file);
      }
      if ((file.source ?? FileSources.local) === FileSources.text || deliveryPath === 'text') {
        continue;
      }
      /* Provisioning may add tool references to native files. Only legacy records use
       * those references to decide whether their bytes belong in the prompt. */
      if (deliveryPath !== 'provider' && isToolOwnedAttachment(file)) {
        continue;
      }
      if (file.type.startsWith('image/')) {
        images.push(file);
      } else if (
        file.type === 'application/pdf' ||
        (agent.provider === EModelEndpoint.bedrock && isBedrockDocumentType(file.type))
      ) {
        documents.push(file);
      } else if (file.type.startsWith('audio/')) {
        audios.push(file);
      } else if (file.type.startsWith('video/')) {
        videos.push(file);
      } else if (
        endpointConfig.supportedMimeTypes &&
        fileConfig.checkType?.(file.type, endpointConfig.supportedMimeTypes)
      ) {
        documents.push(file);
      }
    }

    const encodeMedia = <T, P extends RunFileEncodingParams>(
      encoder: MediaEncoder<T, P>,
      inputs: TFile[],
      empty: T,
      encoderParams: P,
    ): Promise<T> =>
      inputs.length > 0
        ? encoder(deps.req, inputs, encoderParams, deps.getStrategyFunctions)
        : Promise.resolve(empty);
    const encodeDocuments = (inputs: TFile[], onValidationFailure: NativeValidationMode) =>
      encodeMedia(
        deps.encodeDocuments,
        inputs,
        { documents: [] },
        { ...params, onValidationFailure },
      );
    const [imageResult, documentResult, audioResult, videoResult, text] = await Promise.all([
      encodeMedia(deps.encodeImages, images, { image_urls: [] }, params),
      encodeNativeDocuments(documents, agent, encodeDocuments),
      encodeMedia(deps.encodeAudios, audios, { audios: [] }, params),
      encodeMedia(deps.encodeVideos, videos, { videos: [] }, params),
      textFiles.length > 0
        ? deps.extractText({
            attachments: textFiles,
            req: deps.req,
            tokenCountFn: countTokens,
            ...getTurnTextOptions(agent.deliveryRouting),
          })
        : Promise.resolve(undefined),
    ]);
    recordNativeRejections([agent], documentResult.rejected);
    const rejectedIds = new Set((documentResult.rejected ?? []).map(({ file_id }) => file_id));
    let fallbackText: string | undefined;
    let fallbackFiles: TFile[] = [];
    if (rejectedIds.size > 0) {
      const sharedIds = new Set(sharedFiles.map((file) => file.file_id));
      const settled = await settleTurnFiles({
        routing: agent.deliveryRouting,
        files: sharedFiles,
        consumers: agent.fileConsumers,
        allocation: {
          requestFileIds: sharedFiles
            .filter((file) => rejectedIds.has(file.file_id))
            .map((file) => file.file_id),
          limits: resolveAgentAttachmentLimits({ req: deps.req, endpoint: params.endpoint }),
          measure: measureModelBoundAttachment,
          committedExtra: applyTurnDelivery(
            (agent.agentContextAttachments ?? []).filter((file) => !sharedIds.has(file.file_id)),
            { routing: agent.deliveryRouting, consumers: agent.fileConsumers },
          ),
          committedEntries: sharedFiles
            .filter((file) => !rejectedIds.has(file.file_id))
            .map(measureModelBoundAttachment),
          scope: 'request',
        },
        flush: true,
      });
      const prepared = prepare(settled, agent).sharedFiles;
      fallbackFiles = prepared.filter(
        (file) => rejectedIds.has(file.file_id) && file.llmDeliveryPath === 'text',
      );
      assertModelBoundContent({
        filters: deps.req.config?.filters,
        files: fallbackFiles,
      });
      if (fallbackFiles.length > 0) {
        fallbackText = await deps.extractText({
          attachments: fallbackFiles,
          req: deps.req,
          tokenCountFn: countTokens,
          ...getTurnTextOptions(agent.deliveryRouting),
        });
      }
    }
    const deliveredIds = new Set(fallbackFiles.map(({ file_id }) => file_id));
    const leftOut = renderLeftOutFiles(
      agent,
      documents.filter((file) => rejectedIds.has(file.file_id) && !deliveredIds.has(file.file_id)),
    );
    const body = [text, fallbackText, leftOut].filter(Boolean).join('\n\n');
    if (
      !body &&
      imageResult.image_urls.length === 0 &&
      documentResult.documents.length === 0 &&
      audioResult.audios.length === 0 &&
      videoResult.videos.length === 0
    ) {
      return [];
    }
    const formatted = formatMessage({
      message: {
        role: 'user',
        content: body || 'Read-only files shared for this task.',
        image_urls: imageResult.image_urls,
        documents: documentResult.documents,
        audios: audioResult.audios,
        videos: videoResult.videos,
      } as Parameters<typeof formatMessage>[0]['message'],
    });
    return [new HumanMessage({ content: formatted.content as BaseMessage['content'] })];
  }

  return { validate, encode };
}
