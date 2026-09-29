export type PromptStoreStage = 'read' | 'write';

/**
 * Wraps a prompt database failure with the operation stage where it occurred. The HTTP
 * boundary uses the stage to keep each route's existing response for that failure.
 */
export class PromptStoreError extends Error {
  readonly stage: PromptStoreStage;
  readonly cause: unknown;

  constructor(stage: PromptStoreStage, cause: unknown) {
    super(`Prompt ${stage} failed`);
    this.name = 'PromptStoreError';
    this.stage = stage;
    this.cause = cause;
  }
}

export function isPromptStoreError(error: unknown, stage: PromptStoreStage): boolean {
  return error instanceof PromptStoreError && error.stage === stage;
}

/** Runs a database call and tags its failure with the stage. */
export async function withPromptStage<T>(
  stage: PromptStoreStage,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new PromptStoreError(stage, error);
  }
}
