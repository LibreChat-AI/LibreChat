import { z } from 'zod';
import { FileSources } from './types/files';

/** Storage strategies which can own uploaded/generated files. */
export const fileStorageSchema = z.enum([
  FileSources.local,
  FileSources.firebase,
  FileSources.s3,
  FileSources.azure_blob,
  FileSources.cloudfront,
]);
export type FileStorage = z.infer<typeof fileStorageSchema>;
