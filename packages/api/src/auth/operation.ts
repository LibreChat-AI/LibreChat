import type { SafeErrorMetadata } from '../utils/errors';
import { getSafeErrorMetadata } from '../utils/errors';

interface AuthenticationOperationDependencies {
  initialize(): Promise<void>;
  close(): Promise<void>;
  disconnect(): Promise<void>;
  error(message: string, metadata?: SafeErrorMetadata): void;
}

/** Initializes the selected authority before writes and settles both connections before exit. */
export async function runAuthenticationOperation(
  deps: AuthenticationOperationDependencies,
  operation: () => Promise<number>,
): Promise<number> {
  let code = 1;
  try {
    await deps.initialize();
    code = await operation();
  } catch (error) {
    deps.error('Authentication operation failed.', getSafeErrorMetadata(error));
  }
  const cleanup = await Promise.allSettled([
    Promise.resolve().then(() => deps.close()),
    Promise.resolve().then(() => deps.disconnect()),
  ]);
  if (cleanup.some((result) => result.status === 'rejected')) {
    deps.error('Error closing authentication storage.');
    return 1;
  }
  return code;
}
