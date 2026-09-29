import {
  FileSources,
  getEndpointFileConfig,
  mergeFileConfig,
  fileConfig,
} from 'librechat-data-provider';
import type { AppConfig, IMongoFile } from '@librechat/data-schemas';
import type { RegexLike, TFile } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';

/**
 * Checks if a MIME type is supported by the endpoint configuration
 * @param mimeType - The MIME type to check
 * @param supportedMimeTypes - Array of compiled matchers (RegexLike) to test against
 * @returns True if the MIME type matches any pattern
 */
function isMimeTypeSupported(mimeType: string, supportedMimeTypes?: RegexLike[]): boolean {
  if (!supportedMimeTypes || supportedMimeTypes.length === 0) {
    return true;
  }
  return fileConfig.checkType(mimeType, supportedMimeTypes);
}

/**
 * Filters out files based on endpoint configuration including:
 * - Disabled status
 * - File size limits
 * - MIME type restrictions
 * - Total size limits
 * @param req - The server request object containing config
 * @param params - Object containing files, endpoint, and endpointType
 * @param params.files - Array of processed file documents from MongoDB
 * @param params.endpoint - The endpoint name to check configuration for
 * @param params.endpointType - The endpoint type to check configuration for
 * @returns Filtered array of files
 */
export function filterFilesByEndpointConfig(
  req: ServerRequest,
  params: {
    files: IMongoFile[] | undefined;
    endpoint?: string | null;
    endpointType?: string | null;
    skipTotalSizeLimit?: boolean;
    preserveTextSources?: boolean;
  },
): IMongoFile[] {
  return filterFilesByEndpointRuntimeConfig(req.config, params);
}

/** Request-free endpoint file-policy adapter used by Agent execution hosts. */
/**
 * Whether this endpoint still presents the explicit upload-destination chooser. In that
 * mode the destination is the user's choice and the upload path acts on it immediately,
 * so nothing may be provisioned to a service they did not select.
 */
export function isLegacyFileUploadUX(
  appConfig: AppConfig | undefined,
  params: { endpoint?: string | null; endpointType?: string | null },
): boolean {
  const endpointFileConfig = getEndpointFileConfig({
    fileConfig: mergeFileConfig(appConfig?.fileConfig),
    endpoint: params.endpoint,
    endpointType: params.endpointType,
  });
  return endpointFileConfig?.legacyFileUploadUX === true;
}

type EndpointPolicyFile = Pick<TFile, 'bytes' | 'type'> & {
  source?: string;
  metadata?: { routingMimeType?: string };
};

export function filterFilesByEndpointRuntimeConfig<T extends EndpointPolicyFile>(
  appConfig: AppConfig | undefined,
  params: {
    files: T[] | undefined;
    endpoint?: string | null;
    endpointType?: string | null;
    /** Bytes already committed by an earlier call, so a request split across several
     *  sets spends one shared `totalSizeLimit` instead of restarting it per set. */
    consumedBytes?: number;
    skipTotalSizeLimit?: boolean;
    preserveTextSources?: boolean;
  },
): T[] {
  const {
    files,
    endpoint,
    endpointType,
    consumedBytes = 0,
    skipTotalSizeLimit = false,
    preserveTextSources = false,
  } = params;

  if (!files || files.length === 0) {
    return [];
  }

  const mergedFileConfig = mergeFileConfig(appConfig?.fileConfig);
  const endpointFileConfig = getEndpointFileConfig({
    fileConfig: mergedFileConfig,
    endpoint,
    endpointType,
  });

  /**
   * If endpoint has files explicitly disabled, filter out all files
   * Only filter if disabled is explicitly set to true
   */
  if (endpointFileConfig?.disabled === true) {
    return [];
  }

  const { fileSizeLimit, supportedMimeTypes, totalSizeLimit } = endpointFileConfig;

  /** Filter files based on individual file size and MIME type */
  let filteredFiles = files;

  /** Filter by individual file size limit */
  if (fileSizeLimit !== undefined && fileSizeLimit > 0) {
    filteredFiles = filteredFiles.filter((file) => {
      return file.bytes <= fileSizeLimit;
    });
  }

  /** Filter by MIME type, against the type the upload was accepted as. Conversion rewrites
   *  `type`, so screening a converted image by its stored format drops a file the same
   *  allowlist admitted minutes earlier. */
  if (supportedMimeTypes && supportedMimeTypes.length > 0) {
    filteredFiles = filteredFiles.filter((file) => {
      return (
        (preserveTextSources && (file.source ?? FileSources.local) === FileSources.text) ||
        isMimeTypeSupported(file.metadata?.routingMimeType ?? file.type, supportedMimeTypes)
      );
    });
  }

  /** Filter by total size limit - keep files until total exceeds limit */
  if (!skipTotalSizeLimit && totalSizeLimit !== undefined && totalSizeLimit > 0) {
    let totalSize = consumedBytes;
    const withinTotalLimit: T[] = [];

    for (let i = 0; i < filteredFiles.length; i++) {
      const file = filteredFiles[i];
      if (totalSize + file.bytes <= totalSizeLimit) {
        withinTotalLimit.push(file);
        totalSize += file.bytes;
      }
    }

    filteredFiles = withinTotalLimit;
  }

  return filteredFiles;
}
