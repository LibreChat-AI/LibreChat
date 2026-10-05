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
  /** Reserved when the command settled; the database ignores a report below the one it holds. */
  seq: number;
  /** The database ignores the report once the conversation is no longer on this workspace. */
  workspace?: LaneWorkspace;
}) => Promise<boolean>;

/** Draws the next report sequence number from the database, so every replica shares one order. */
export type LaneSeqReserver = (user: string, conversationId: string) => Promise<number | null>;

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

type Placement = { conversationId: string; required: boolean };
type Reservation = Placement & { seq: number };

/**
 * The tail of each visible conversation's pending sequence reservations in this process, keyed by
 * the conversation the write lands on (the root of a subagent thread, not the thread). Two
 * threads of one conversation therefore share a chain, and numbers are drawn one at a time in
 * report order, so one process never takes a lower number for a later report. Writes are not
 * queued: each carries its number and the database ignores a lower one, so a slow or reordered
 * write cannot replace a newer state, here or on another replica. Entries leave the map as soon
 * as their chain drains.
 */
const reservationTails = new Map<string, Promise<unknown>>();

/**
 * Records the lane state a finished command reported, for the owner's conversation. It never
 * throws and is never awaited by the command: the branch is a header affordance, so a database
 * outage must not fail or delay the agent's tool call. Each report takes a sequence number from
 * the database when it arrives and is written with it, so the newest report wins whatever order
 * the writes land in. Every report is written, repeats included, because another recorder (a
 * sibling subagent thread, another replica) may have changed the lane since this one last wrote,
 * and the database already ignores a write that changes nothing the reader can see. Resolves to
 * whether the write applied, which is false when a newer report is already stored and for a
 * conversation not saved yet. A repo that is not a plain `owner/name` is dropped rather than
 * stored.
 */
export function createLaneGitRecorder({
  user,
  conversationId,
  repo,
  workspace,
  getConvoOwnership,
  reserveConvoLaneGitSeq,
  setConvoLaneGit,
}: {
  user: string | undefined;
  conversationId: string | undefined;
  repo?: string;
  workspace?: { environmentId: string; workspaceId: string };
  getConvoOwnership?: LaneOwnershipReader;
  reserveConvoLaneGitSeq: LaneSeqReserver;
  setConvoLaneGit: LaneGitWriter;
}): ((laneGit: WorkspaceLaneGit) => Promise<boolean>) | undefined {
  if (!user || !conversationId) return undefined;
  const safeRepo = isSafeRepo(repo) ? repo : undefined;

  /**
   * A subagent thread is a hidden child of the conversation the user sees, and its commands run on
   * the parent's machine, so its lane belongs to the visible root. That write must also match the
   * root's recorded workspace, since nothing else ties the child to it. The lookup is made once;
   * a failed one is retried on the next report.
   */
  let target: Promise<Placement> | undefined;
  const resolveTarget = (): Promise<Placement> => {
    if (target == null) {
      const resolving = (async (): Promise<Placement> => {
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

  /** Never rejects, so a failed reservation cannot stall the ones queued behind it. */
  const reserve = async (): Promise<Reservation | null> => {
    try {
      const placed = await resolveTarget();
      if (placed.required && workspace == null) return null;
      const seq = await reserveConvoLaneGitSeq(user, placed.conversationId);
      return seq == null ? null : { ...placed, seq };
    } catch (error) {
      logger.warn('[LaneGit] Failed to reserve a lane report', getSafeErrorMetadata(error));
      return null;
    }
  };

  const write = async (laneGit: WorkspaceLaneGit, reserved: Reservation): Promise<boolean> => {
    try {
      return await setConvoLaneGit({
        user,
        conversationId: reserved.conversationId,
        laneGit,
        ...(safeRepo ? { repo: safeRepo } : {}),
        seq: reserved.seq,
        ...(workspace
          ? { workspace: { ...workspace, ...(reserved.required ? { required: true } : {}) } }
          : {}),
      });
    } catch (error) {
      logger.warn('[LaneGit] Failed to record lane state', getSafeErrorMetadata(error));
      return false;
    }
  };

  return (laneGit) => {
    /**
     * The chain is chosen after the target is resolved, so threads that share a visible
     * conversation share it. Resolution is memoised and idempotent, so waiting on it here costs
     * one lookup per recorder.
     */
    const run = async (): Promise<boolean> => {
      let placed: Placement;
      try {
        placed = await resolveTarget();
      } catch (error) {
        logger.warn('[LaneGit] Failed to place a lane report', getSafeErrorMetadata(error));
        return false;
      }
      const queueKey = `${user}\0${placed.conversationId}`;
      const previous = reservationTails.get(queueKey) ?? Promise.resolve();
      const reservation = previous.then(() => reserve());
      reservationTails.set(queueKey, reservation);
      void reservation.then(() => {
        if (reservationTails.get(queueKey) === reservation) reservationTails.delete(queueKey);
      });
      const reserved = await reservation;
      return reserved == null ? false : write(laneGit, reserved);
    };
    return run();
  };
}
