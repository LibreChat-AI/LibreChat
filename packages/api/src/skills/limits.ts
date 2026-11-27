export type ImportLimits = {
  maxZipBytes: number;
  maxDecompressedBytes: number;
  /** Caps aggregate decompression and synchronous pattern scans during filtered preflight. */
  maxContentInspectionBytes: number;
  maxEntries: number;
  maxSingleFileBytes: number;
};

export const DEFAULT_SKILL_IMPORT_LIMITS: ImportLimits = {
  maxZipBytes: 50 * 1024 * 1024,
  maxDecompressedBytes: 500 * 1024 * 1024,
  maxContentInspectionBytes: 25 * 1024 * 1024,
  maxEntries: 500,
  maxSingleFileBytes: 10 * 1024 * 1024,
};

/** Multipart import accepts exactly one file and no text metadata. */
export function skillImportMultipartLimits(fileSize: number): { fileSize: number; fields: number } {
  return { fileSize, fields: 0 };
}

/** File editing accepts a path and an optional revision beside the file. */
export function skillFileMultipartLimits(): { fileSize: number; fields: number } {
  return { fileSize: DEFAULT_SKILL_IMPORT_LIMITS.maxSingleFileBytes, fields: 2 };
}
