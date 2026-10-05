import { logger } from '@librechat/data-schemas';
import type { WorkspaceLaneGit } from './workspace';
import { getSafeErrorMetadata } from '~/utils';

export type LaneGitWriter = (input: {
  user: string;
  conversationId: string;
  laneGit: WorkspaceLaneGit;
  repo?: string;
  /** When the command settled; the database ignores a report older than the one it holds. */
  reportedAt: Date;
}) => Promise<boolean>;

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_REPO_LENGTH = 256;

const isSafeRepo = (repo: string | undefined): repo is string =>
  repo != null &&
  repo.length <= MAX_REPO_LENGTH &&
  REPO_PATTERN.test(repo) &&
  repo.split('/').every((segment) => segment !== '.' && segment !== '..');

/**
 * The tail of each conversation's pending writes in this process. It keeps one process from
 * racing its own writes; correctness across replicas comes from `reportedAt`, which the database
 * fences on, so an older report is ignored wherever it lands. Entries leave the map as soon as
 * their chain drains, so it only holds conversations with a write in flight.
 */
const pendingWrites = new Map<string, Promise<unknown>>();

/**
 * Records the lane state a finished command reported, for the owner's conversation. It never
 * throws and is never awaited by the command: the branch is a header affordance, so a database
 * outage must not fail or delay the agent's tool call. Writes for one conversation run in the
 * order they were reported, and each carries the time it was reported so the database can ignore
 * a stale one. Resolves to whether the write applied, which is false when a newer report is
 * already stored and for a conversation not saved yet. A repo that is not a plain `owner/name`
 * is dropped rather than stored.
 */
export function createLaneGitRecorder({
  user,
  conversationId,
  repo,
  setConvoLaneGit,
  now = () => new Date(),
}: {
  user: string | undefined;
  conversationId: string | undefined;
  repo?: string;
  setConvoLaneGit: LaneGitWriter;
  now?: () => Date;
}): ((laneGit: WorkspaceLaneGit) => Promise<boolean>) | undefined {
  if (!user || !conversationId) return undefined;
  const safeRepo = isSafeRepo(repo) ? repo : undefined;
  const queueKey = `${user}\0${conversationId}`;

  const write = async (laneGit: WorkspaceLaneGit, reportedAt: Date): Promise<boolean> => {
    try {
      return await setConvoLaneGit({
        user,
        conversationId,
        laneGit,
        ...(safeRepo ? { repo: safeRepo } : {}),
        reportedAt,
      });
    } catch (error) {
      logger.warn('[LaneGit] Failed to record lane state', getSafeErrorMetadata(error));
      return false;
    }
  };

  return (laneGit) => {
    /** Stamped when the command settles, not when its write finally runs. */
    const reportedAt = now();
    const previous = pendingWrites.get(queueKey) ?? Promise.resolve();
    /** `write` never rejects, so a failed write cannot stall the writes queued behind it. */
    const next = previous.then(() => write(laneGit, reportedAt));
    pendingWrites.set(queueKey, next);
    void next.then(() => {
      if (pendingWrites.get(queueKey) === next) pendingWrites.delete(queueKey);
    });
    return next;
  };
}
