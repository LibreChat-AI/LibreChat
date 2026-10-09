import type { TFile } from 'librechat-data-provider';
import type { ServerRequest } from '~/types/http';

export interface SaveBufferParams {
  userId: string;
  buffer: Buffer;
  fileName: string;
  basePath?: string;
  tenantId?: string | null;
  storageRegion?: string | null;
  includeRegionInPath?: boolean;
  useInlinePath?: boolean;
}

export interface GetURLParams {
  userId: string;
  fileName: string;
  basePath?: string;
  customFilename?: string | null;
  contentType?: string | null;
  tenantId?: string | null;
  storageRegion?: string | null;
  includeRegionInPath?: boolean;
  useInlinePath?: boolean;
}

export interface SaveURLParams {
  userId: string;
  URL: string;
  fileName: string;
  basePath?: string;
  tenantId?: string | null;
  storageRegion?: string | null;
  includeRegionInPath?: boolean;
  useInlinePath?: boolean;
}

export interface SaveURLResult {
  filepath: string;
  storageKey?: string;
  storageRegion?: string;
  bytes?: number;
  type?: string;
  dimensions?: {
    width?: number;
    height?: number;
  };
}

export interface UploadFileParams {
  req: ServerRequest;
  file: Express.Multer.File;
  file_id: string;
  basePath?: string;
  tenantId?: string | null;
  storageRegion?: string | null;
  includeRegionInPath?: boolean;
  useInlinePath?: boolean;
}

export interface DownloadURLParams {
  req?: ServerRequest;
  file: TFile;
  customFilename?: string | null;
  contentType?: string | null;
}

export interface UploadImageParams extends UploadFileParams {
  endpoint: string;
  resolution?: string;
}

export interface UploadResult {
  filepath: string;
  storageKey?: string;
  storageRegion?: string;
  bytes: number;
}

export interface ImageUploadResult extends UploadResult {
  width: number;
  height: number;
}

export interface ProcessAvatarParams {
  buffer: Buffer;
  userId: string;
  manual: string;
  agentId?: string;
  basePath?: string;
  tenantId?: string | null;
}

export interface S3FileRef {
  filepath: string;
  storageKey?: string;
  storageRegion?: string;
  source: string;
}

export type SaveBufferFn = (params: SaveBufferParams) => Promise<string>;

export type BatchUpdateFn = (
  files: Array<{ file_id: string; filepath: string; storageKey?: string; storageRegion?: string }>,
) => Promise<void>;

export type UrlBuilder = (params: GetURLParams) => Promise<string>;
