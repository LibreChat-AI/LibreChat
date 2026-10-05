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
 * Records the lane state a finished command reported, for the owner's conversation. It never
 * throws and is never awaited by the command: the branch is a header affordance, so a database
 * outage must not fail or delay the agent's tool call. Resolves to whether the stored value
 * changed, which is false for an unchanged lane and for a conversation not saved yet. A repo that
 * is not a plain `owner/name` is dropped rather than stored.
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
  return async (laneGit) => {
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
}
