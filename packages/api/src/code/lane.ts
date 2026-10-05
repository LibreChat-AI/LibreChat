import { logger } from '@librechat/data-schemas';
import type { WorkspaceLaneGit } from './workspace';
import { getSafeErrorMetadata } from '~/utils';

export type LaneGitWriter = (input: {
  user: string;
  conversationId: string;
  laneGit: WorkspaceLaneGit;
  repo?: string;
}) => Promise<boolean>;

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_REPO_LENGTH = 256;

const isSafeRepo = (repo: string | undefined): repo is string =>
  repo != null &&
  repo.length <= MAX_REPO_LENGTH &&
  REPO_PATTERN.test(repo) &&
  repo.split('/').every((segment) => segment !== '.' && segment !== '..');

/**
 * The tail of each conversation's pending writes. A later command's report must not be applied
 * before an earlier one finishes: database completion order is not request order, so an
 * unordered older write could land last and leave the conversation on a stale branch. Entries
 * leave the map as soon as their chain drains, so it only holds conversations with a write in
 * flight.
 */
const pendingWrites = new Map<string, Promise<unknown>>();

/**
 * Records the lane state a finished command reported, for the owner's conversation. It never
 * throws and is never awaited by the command: the branch is a header affordance, so a database
 * outage must not fail or delay the agent's tool call. Writes for one conversation run in the
 * order they were reported. Resolves to whether the stored value changed, which is false for an
 * unchanged lane and for a conversation not saved yet. A repo that is not a plain `owner/name`
 * is dropped rather than stored.
 */
export function createLaneGitRecorder({
  user,
  conversationId,
  repo,
  setConvoLaneGit,
}: {
  user: string | undefined;
  conversationId: string | undefined;
  repo?: string;
  setConvoLaneGit: LaneGitWriter;
}): ((laneGit: WorkspaceLaneGit) => Promise<boolean>) | undefined {
  if (!user || !conversationId) return undefined;
  const safeRepo = isSafeRepo(repo) ? repo : undefined;
  const queueKey = `${user}\0${conversationId}`;

  const write = async (laneGit: WorkspaceLaneGit): Promise<boolean> => {
    try {
      return await setConvoLaneGit({
        user,
        conversationId,
        laneGit,
        ...(safeRepo ? { repo: safeRepo } : {}),
      });
    } catch (error) {
      logger.warn('[LaneGit] Failed to record lane state', getSafeErrorMetadata(error));
      return false;
    }
  };

  return (laneGit) => {
    const previous = pendingWrites.get(queueKey) ?? Promise.resolve();
    /** `write` never rejects, so a failed write cannot stall the writes queued behind it. */
    const next = previous.then(() => write(laneGit));
    pendingWrites.set(queueKey, next);
    void next.then(() => {
      if (pendingWrites.get(queueKey) === next) pendingWrites.delete(queueKey);
    });
    return next;
  };
}
