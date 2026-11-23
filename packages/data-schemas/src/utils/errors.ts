/** What a log may keep of a failure: an error's message can echo query text, filters or connection details. */
export interface SafeErrorFields {
  errName: string;
  errCode: string | number | null;
}

/** The failure's name and driver code, never its message or stack. */
export function getSafeErrorFields(error: unknown): SafeErrorFields {
  const code =
    error != null && typeof error === 'object' ? (error as { code?: unknown }).code : null;
  return {
    errName: error instanceof Error ? error.name : typeof error,
    errCode: typeof code === 'string' || typeof code === 'number' ? code : null,
  };
}
