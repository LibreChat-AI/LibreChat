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
import type { ServerRequest, StrategyFunctions } from '~/types';
import type { TokenCountFn } from '~/utils/text';
import {
  isToolOwnedAttachment,
  isModelBoundAttachmentFile,
  assertAgentAttachmentLimits,
  AgentAttachmentPolicyError,
} from '../attachments';
import { assertModelBoundContent } from '~/middleware/modelBoundContent';
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

type MediaEncoder<T> = (
  req: ServerRequest,
  files: TFile[],
  params: RunFileEncodingParams,
  getStrategyFunctions: (source: string) => StrategyFunctions,
) => Promise<T>;

/** Adapters bind the existing attachment encoders to the host's storage strategies. */
export interface RunFileMessageEncoderDeps {
  req: ServerRequest;
  getAgent: (agentId: string) => RunFileEncodingAgent | undefined;
  encodeImages: MediaEncoder<{ image_urls: ContentBlock[] }>;
  encodeDocuments: MediaEncoder<{ documents: ContentBlock[] }>;
  encodeAudios: MediaEncoder<{ audios: ContentBlock[] }>;
  encodeVideos: MediaEncoder<{ videos: ContentBlock[] }>;
  getStrategyFunctions: (source: string) => StrategyFunctions;
  extractText: (params: {
    attachments: TFile[];
    req: ServerRequest;
    tokenCountFn: TokenCountFn;
  }) => Promise<string | undefined>;
}

export interface RunFileMessageEncoder {
  validate: (files: TFile[], agentId: string) => void;
  encode: (files: TFile[], agentId: string) => Promise<BaseMessage[]>;
}

/** Encodes authorized run files for the receiving child, without provisioning new resources. */
export function createRunFileMessageEncoder(
  deps: RunFileMessageEncoderDeps,
): RunFileMessageEncoder {
  function prepare(files: TFile[], agentId: string) {
    const agent = deps.getAgent(agentId);
    if (!agent) {
      throw new Error('The target agent is not available for shared file delivery.');
    }
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
    assertModelBoundContent({ filters: deps.req.config?.filters, files: sharedFiles });
    return { agent, params, sharedFiles, fileConfig, endpointConfig };
  }

  function validate(files: TFile[], agentId: string): void {
    if (files.length > 0) prepare(files, agentId);
  }

  async function encode(files: TFile[], agentId: string): Promise<BaseMessage[]> {
    if (files.length === 0) return [];
    const { agent, params, sharedFiles, fileConfig, endpointConfig } = prepare(files, agentId);
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

    const encodeMedia = <T>(encoder: MediaEncoder<T>, inputs: TFile[], empty: T): Promise<T> =>
      inputs.length > 0
        ? encoder(deps.req, inputs, params, deps.getStrategyFunctions)
        : Promise.resolve(empty);
    const [imageResult, documentResult, audioResult, videoResult, text] = await Promise.all([
      encodeMedia(deps.encodeImages, images, { image_urls: [] }),
      encodeMedia(deps.encodeDocuments, documents, { documents: [] }),
      encodeMedia(deps.encodeAudios, audios, { audios: [] }),
      encodeMedia(deps.encodeVideos, videos, { videos: [] }),
      textFiles.length > 0
        ? deps.extractText({ attachments: textFiles, req: deps.req, tokenCountFn: countTokens })
        : Promise.resolve(undefined),
    ]);
    if (
      !text &&
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
        content: text ?? 'Read-only files shared for this task.',
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
