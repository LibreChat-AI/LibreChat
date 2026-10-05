import { logger } from '@librechat/data-schemas';
import type { WorkspaceLaneGit } from './workspace';
import { getSafeErrorMetadata } from '~/utils';

/** The workspace a command ran in. `required` demands the conversation have it recorded. */
export type LaneWorkspace = { environmentId: string; workspaceId: string; required?: boolean };

export type LaneGitWriter = (input: {
  user: string;
  conversationId: string;
  laneGit: WorkspaceLaneGit;
  repo?: string;
  /** When the command settled; the database ignores a report older than the one it holds. */
  reportedAt: Date;
  /** The database ignores the report once the conversation is no longer on this workspace. */
  workspace?: LaneWorkspace;
}) => Promise<boolean>;

/** Reads what the recorder needs to place a conversation: whether it is a subagent thread. */
export type LaneOwnershipReader = (
  user: string,
  conversationId: string,
) => Promise<{ subagentThread?: { rootConversationId?: string | null } | null } | null | undefined>;

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
  workspace,
  getConvoOwnership,
  setConvoLaneGit,
  now = () => new Date(),
}: {
  user: string | undefined;
  conversationId: string | undefined;
  repo?: string;
  workspace?: { environmentId: string; workspaceId: string };
  getConvoOwnership?: LaneOwnershipReader;
  setConvoLaneGit: LaneGitWriter;
  now?: () => Date;
}): ((laneGit: WorkspaceLaneGit) => Promise<boolean>) | undefined {
  if (!user || !conversationId) return undefined;
  const safeRepo = isSafeRepo(repo) ? repo : undefined;
  const queueKey = `${user}\0${conversationId}`;

  /**
   * A subagent thread is a hidden child of the conversation the user sees, and its commands run on
   * the parent's machine, so its lane belongs to the visible root. That write must also match the
   * root's recorded workspace, since nothing else ties the child to it. The lookup is made once;
   * a failed one is retried on the next report.
   */
  let target: Promise<{ conversationId: string; required: boolean }> | undefined;
  const resolveTarget = (): Promise<{ conversationId: string; required: boolean }> => {
    if (target == null) {
      const resolving = (async () => {
        if (getConvoOwnership == null) return { conversationId, required: false };
        const owned = await getConvoOwnership(user, conversationId);
        const root = owned?.subagentThread?.rootConversationId;
        return root
          ? { conversationId: root, required: true }
          : { conversationId, required: false };
      })();
      target = resolving;
      resolving.catch(() => {
        if (target === resolving) target = undefined;
      });
    }
    return target;
  };

  const write = async (laneGit: WorkspaceLaneGit, reportedAt: Date): Promise<boolean> => {
    try {
      const placed = await resolveTarget();
      if (placed.required && workspace == null) return false;
      return await setConvoLaneGit({
        user,
        conversationId: placed.conversationId,
        laneGit,
        ...(safeRepo ? { repo: safeRepo } : {}),
        reportedAt,
        ...(workspace
          ? { workspace: { ...workspace, ...(placed.required ? { required: true } : {}) } }
          : {}),
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
