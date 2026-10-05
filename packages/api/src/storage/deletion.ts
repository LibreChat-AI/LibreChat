/** Missing local bytes are already deleted; every other storage failure must remain retryable. */
export async function unlinkLocalFile(
  filepath: string,
  deps: {
    unlink(filepath: string): Promise<void>;
    logger: {
      warn(message: string, error: Error): void;
      error(message: string, error: Error): void;
    };
  },
): Promise<void> {
  try {
    await deps.unlink(filepath);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('Local file deletion failed');
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      deps.logger.warn('Local file was already missing during delete:', failure);
      return;
    }
    deps.logger.error('Error deleting file:', failure);
    throw error;
  }
}
