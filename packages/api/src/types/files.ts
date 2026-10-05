import type { BedrockDocumentFormat } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { Readable } from 'stream';
import type { DownloadURLParams } from '~/storage/types';
import type { ServerRequest } from './http';
export interface STTService {
  getInstance(): Promise<STTService>;
  getProviderSchema(req: ServerRequest): Promise<[string, object, string[] | undefined]>;
  sttRequest(
    provider: string,
    schema: object,
    params: { audioBuffer: Buffer; audioFile: AudioFileInfo },
    allowedAddresses?: string[],
  ): Promise<string>;
}

export interface AudioFileInfo {
  originalname: string;
  mimetype: string;
  size: number;
}

export interface FileObject {
  path: string;
  originalname: string;
  mimetype: string;
  size: number;
}

export interface AudioProcessingResult {
  text: string;
  bytes: number;
}

/** Google video block format */
export interface GoogleVideoBlock {
  type: 'media';
  mimeType: string;
  data: string;
}

/** OpenAI-compatible video block format (OpenRouter, vLLM, configured custom endpoints) */
export interface OpenRouterVideoBlock {
  type: 'video_url';
  video_url: {
    url: string;
  };
}

export type VideoBlock = GoogleVideoBlock | OpenRouterVideoBlock;

export interface VideoResult {
  videos: VideoBlock[];
  files: Array<{
    file_id?: string;
    temp_file_id?: string;
    filepath: string;
    source?: string;
    filename: string;
    type: string;
  }>;
}

/** Anthropic document block format */
export interface AnthropicDocumentBlock {
  type: 'document';
  source: {
    type: string;
    media_type: string;
    data: string;
  };
  context?: string;
  title?: string;
  cache_control?: { type: string };
  citations?: { enabled: boolean };
}

/** Google document block format */
export interface GoogleDocumentBlock {
  type: 'media';
  mimeType: string;
  data: string;
}

/** OpenAI file block format */
export interface OpenAIFileBlock {
  type: 'file';
  file: {
    filename: string;
    file_data: string;
  };
}

/** OpenAI-compatible text part carrying a textual document's decoded contents */
export interface OpenAITextDocumentBlock {
  type: 'text';
  text: string;
}

/** OpenAI Responses API file format */
export interface OpenAIInputFileBlock {
  type: 'input_file';
  filename: string;
  file_data: string;
}

/** Bedrock Converse API document block (passthrough via @langchain/aws) */
export interface BedrockDocumentBlock {
  type: 'document';
  document: {
    name: string;
    format: BedrockDocumentFormat;
    source: {
      bytes: Buffer;
    };
  };
}

export type DocumentBlock =
  | AnthropicDocumentBlock
  | GoogleDocumentBlock
  | OpenAIFileBlock
  | OpenAITextDocumentBlock
  | OpenAIInputFileBlock
  | BedrockDocumentBlock;

export interface DocumentResult {
  documents: DocumentBlock[];
  files: Array<{
    file_id?: string;
    temp_file_id?: string;
    filepath: string;
    source?: string;
    filename: string;
    type: string;
  }>;
}

/** Google audio block format */
export interface GoogleAudioBlock {
  type: 'media';
  mimeType: string;
  data: string;
}

/** OpenAI-compatible audio block format (OpenRouter, vLLM, configured custom endpoints) */
export interface OpenRouterAudioBlock {
  type: 'input_audio';
  input_audio: {
    data: string;
    format: string;
  };
}

export type AudioBlock = GoogleAudioBlock | OpenRouterAudioBlock;

export interface AudioResult {
  audios: AudioBlock[];
  files: Array<{
    file_id?: string;
    temp_file_id?: string;
    filepath: string;
    source?: string;
    filename: string;
    type: string;
  }>;
}

export interface ProcessedFile<T = IMongoFile> {
  file: T;
  content: string;
  metadata: {
    file_id: string;
    temp_file_id?: string;
    filepath: string;
    source?: string;
    filename: string;
    type: string;
  };
}

/** Subset of storage strategy functions needed by download and delete access flows. */
export interface StrategyFunctions {
  getDownloadStream: (req: ServerRequest, filepath: string) => Promise<Readable>;
  getDownloadURL?: (params: DownloadURLParams) => Promise<string>;
  deleteFile?: (
    req: ServerRequest,
    file: {
      filepath: string;
      storageKey?: string | null;
      storageRegion?: string | null;
      user?: string;
      tenantId?: string | null;
    },
  ) => Promise<void>;
}
