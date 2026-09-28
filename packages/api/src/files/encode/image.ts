import {
  FileSources,
  VisionModes,
  ImageDetail,
  ContentTypes,
  EModelEndpoint,
  mergeFileConfig,
  getEndpointFileConfig,
} from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { Agents } from 'librechat-data-provider';
import type { AxiosInstance } from 'axios';
import type { ServerRequest, StrategyFunctions } from '~/types';
import { getFileStream, isAttachmentObjectNotFoundError } from './utils';
import { validateImage } from '~/files/validation';
import { runGuardedEncode } from './memoryGuard';
import { logAxiosError } from '~/utils/axios';

type ImageEncodingFile = Pick<
  IMongoFile,
  | 'file_id'
  | 'temp_file_id'
  | 'filepath'
  | 'storageKey'
  | 'filename'
  | 'type'
  | 'height'
  | 'width'
  | 'embedded'
  | 'metadata'
> &
  Partial<Pick<IMongoFile, 'source' | 'bytes'>>;

type ImageEntry = [ImageEncodingFile, string | null];

interface ImageStrategy extends StrategyFunctions {
  prepareImagePayload?: (
    req: ServerRequest,
    file: ImageEncodingFile,
  ) => Promise<[ImageEncodingFile, string]>;
}

interface ImageEncodingDependencies {
  getStrategyFunctions: (source: string) => ImageStrategy;
  httpClient: Pick<AxiosInstance, 'get'>;
}

interface ImageResult {
  files: Array<
    Pick<
      ImageEncodingFile,
      'file_id' | 'filepath' | 'filename' | 'type' | 'height' | 'width' | 'embedded' | 'metadata'
    >
  >;
  image_urls: Array<
    | Agents.MessageContentImageUrl
    | { type: ContentTypes.IMAGE_URL; inlineData: { mimeType: string; data: string } }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  >;
}

const base64Only = new Set<string>([
  EModelEndpoint.google,
  EModelEndpoint.anthropic,
  'Ollama',
  'ollama',
  EModelEndpoint.bedrock,
]);

const blobStorageSources = new Set<string>([
  FileSources.azure_blob,
  FileSources.s3,
  FileSources.firebase,
  FileSources.cloudfront,
]);

export class AttachmentStorageError extends Error {
  readonly code = 'ATTACHMENT_STORAGE_ERROR';

  constructor() {
    super('An attached file could not be read from storage. Try again or upload it again.');
    this.name = 'AttachmentStorageError';
  }
}

/** Owns source selection, guarded reads, validation and provider-specific image formatting. */
export async function encodeAndFormatImages(
  req: ServerRequest,
  files: ImageEncodingFile[] | null | undefined,
  params: { provider?: string; endpoint?: string; imageDetail?: Agents.ImageDetail },
  { getStrategyFunctions, httpClient }: ImageEncodingDependencies,
  mode?: string,
): Promise<ImageResult> {
  const { provider, endpoint } = params;
  const effectiveEndpoint = endpoint ?? provider;
  const promises: Array<ImageEntry | Promise<ImageEntry>> = [];
  const encodingMethods: Record<string, ImageStrategy> = {};
  const result: ImageResult = { files: [], image_urls: [] };

  if (!files?.length) {
    return result;
  }

  for (const file of files) {
    const source = file.source ?? FileSources.local;
    if (!file.height) {
      promises.push([file, null]);
      continue;
    }

    if (blobStorageSources.has(source)) {
      try {
        const processedFile = await runGuardedEncode(file.bytes ?? 0, () =>
          getFileStream(req, file, encodingMethods, getStrategyFunctions),
        );
        promises.push([file, processedFile?.content ?? null]);
      } catch (error) {
        if (isAttachmentObjectNotFoundError(error)) {
          throw error;
        }
        if (typeof error === 'object' && error != null && 'bufferedData' in error) {
          delete (error as { bufferedData?: unknown }).bufferedData;
        }
        throw new AttachmentStorageError();
      }
      continue;
    }

    if (!encodingMethods[source]) {
      encodingMethods[source] = getStrategyFunctions(source);
    }
    const preparePayload = encodingMethods[source].prepareImagePayload;
    if (!preparePayload) {
      throw new Error(`Encoding function not implemented for ${source}`);
    }

    if (source !== FileSources.local && effectiveEndpoint && base64Only.has(effectiveEndpoint)) {
      const entry = await runGuardedEncode<ImageEntry>(file.bytes ?? 0, async () => {
        const [preparedFile, imageURL] = await preparePayload(req, file);
        try {
          const response = await httpClient.get<ArrayBuffer>(imageURL, {
            responseType: 'arraybuffer',
          });
          return [preparedFile, Buffer.from(response.data).toString('base64')];
        } catch (error) {
          const message = 'Error fetching image to convert to base64';
          throw new Error(logAxiosError({ message, error }));
        }
      });
      promises.push(entry);
      continue;
    }
    promises.push(preparePayload(req, file));
  }

  const detail = params.imageDetail ?? req.body.imageDetail ?? ImageDetail.auto;
  const formattedImages = await Promise.all(promises);
  let configuredFileSizeLimit: number | undefined;
  if (req.config?.fileConfig) {
    const fileConfig = mergeFileConfig(req.config.fileConfig);
    const endpointConfig = getEndpointFileConfig({
      fileConfig,
      endpoint: effectiveEndpoint,
    });
    configuredFileSizeLimit = endpointConfig?.fileSizeLimit;
  }

  for (const [file, imageContent] of formattedImages) {
    const fileMetadata: ImageResult['files'][number] = {
      type: file.type,
      file_id: file.file_id,
      filepath: file.filepath,
      filename: file.filename,
      embedded: !!file.embedded,
      metadata: file.metadata,
    };
    if (file.height && file.width) {
      fileMetadata.height = file.height;
      fileMetadata.width = file.width;
    }
    result.files.push(fileMetadata);

    if (!imageContent) {
      continue;
    }

    const isURL = imageContent.startsWith('http');
    if (file.height && file.width && !isURL) {
      const imageBuffer = Buffer.from(imageContent, 'base64');
      const validation = await validateImage(
        imageBuffer,
        imageBuffer.length,
        effectiveEndpoint ?? '',
        configuredFileSizeLimit,
      );
      if (!validation.isValid) {
        throw new Error(`Image validation failed for ${file.filename}: ${validation.error}`);
      }
    }

    const url = isURL ? imageContent : `data:${file.type};base64,${imageContent}`;
    if (mode === VisionModes.agents) {
      result.image_urls.push({ type: ContentTypes.IMAGE_URL, image_url: { url, detail } });
    } else if (effectiveEndpoint === EModelEndpoint.google && mode === VisionModes.generative) {
      result.image_urls.push({
        type: ContentTypes.IMAGE_URL,
        inlineData: { mimeType: file.type, data: imageContent },
      });
    } else if (effectiveEndpoint === EModelEndpoint.google) {
      result.image_urls.push({ type: ContentTypes.IMAGE_URL, image_url: url });
    } else if (effectiveEndpoint === EModelEndpoint.anthropic) {
      result.image_urls.push({
        type: 'image',
        source: { type: 'base64', media_type: file.type, data: imageContent },
      });
    } else {
      result.image_urls.push({ type: ContentTypes.IMAGE_URL, image_url: { url, detail } });
    }
  }
  return result;
}
