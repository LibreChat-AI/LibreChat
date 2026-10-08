import type { GenerationJob } from '../types/stream';

/** A settled status can precede final persistence and terminal host actions. */
export async function waitForGenerationPersistence(
  streamId: string,
  createdAt: number,
  readJob: (
    id: string,
  ) => Promise<Pick<GenerationJob, 'createdAt' | 'metadata'> | null | undefined>,
  { timeoutMs = 45_000, pollMs = 100 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const current = await readJob(streamId);
    if (current != null && current.createdAt !== createdAt) {
      throw new Error(`Generation replaced during deletion: ${streamId}`);
    }
    if (
      current == null ||
      (current.metadata?.terminalPersistencePending !== true &&
        current.metadata?.terminalHostActionPending !== true)
    )
      return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for generation persistence: ${streamId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
