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
