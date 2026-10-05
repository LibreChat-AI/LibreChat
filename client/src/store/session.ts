import logger from '~/utils/logger';

type SessionCleanup = () => void;

const cleanups = new Set<SessionCleanup>();

/** Features can register account-specific cleanup without adding imports to the auth boundary.
 * Existing auth cleanups in AuthContext remain there until their features adopt this registry.
 * The returned function unregisters, for tests and for modules that are torn down. */
export function registerSessionCleanup(cleanup: SessionCleanup): () => void {
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
  };
}

/** Runs every registered cleanup; one that throws does not stop the others. */
export function runSessionCleanups(): void {
  cleanups.forEach((cleanup) => {
    try {
      cleanup();
    } catch (error) {
      logger.error('Session cleanup failed', error);
    }
  });
}
