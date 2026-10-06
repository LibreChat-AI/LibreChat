import { logger } from '@librechat/data-schemas';
import type { WorkspaceLaneGit } from './workspace';
import { getSafeErrorMetadata } from '~/utils';

/**
 * The workspace a command ran in. `required` demands the conversation have it recorded, and
 * `epoch` is the attachment epoch read when the tool was created.
 */
export type LaneWorkspace = {
  environmentId: string;
  workspaceId: string;
  required?: boolean;
  epoch?: number;
};

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

/**
 * Reads what the recorder needs to place and fence its reports: the subagent route of the
 * conversation and its workspace attachment epoch. Null when the conversation is not saved yet.
 */
export type LaneContextReader = (
  user: string,
  conversationId: string,
) => Promise<{
  subagentThread?: { rootConversationId?: string | null } | null;
  codeAttachmentEpoch?: number;
} | null>;

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_REPO_LENGTH = 256;

const isSafeRepo = (repo: string | undefined): repo is string =>
  repo != null &&
  repo.length <= MAX_REPO_LENGTH &&
  REPO_PATTERN.test(repo) &&
  repo.split('/').every((segment) => segment !== '.' && segment !== '..');

type Placement = { conversationId: string; required: boolean; epoch: number };
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
 * Builds the recorder for one tool, placing it once, here, so no report waits on a lookup that
 * could let a later report take an earlier turn. The conversation's route and attachment epoch
 * are read when the tool is created: a subagent thread is a hidden child of the conversation the
 * user sees, its commands run on the parent's machine, so its lane belongs to the visible root
 * and that write must match the root's recorded workspace; the epoch fences out a report that
 * outlives a move of the workspace, even one that moved away and back. A conversation not saved
 * yet is placed on itself at epoch 0. When the context cannot be read nothing is recorded: the
 * branch is a header affordance, so a database outage never fails or delays the tool call.
 * Resolves to undefined when there is nothing to record against.
 */
export async function createLaneGitRecorder({
  enabled,
  user,
  conversationId,
  repo,
  workspace,
  getConvoLaneContext,
  reserveConvoLaneGitSeq,
  setConvoLaneGit,
}: {
  /** Whether the deployment shows pull requests; when it does not, nothing is read or recorded. */
  enabled: boolean;
  user: string | undefined;
  conversationId: string | undefined;
  repo?: string;
  workspace?: { environmentId: string; workspaceId: string };
  getConvoLaneContext?: LaneContextReader;
  reserveConvoLaneGitSeq: LaneSeqReserver;
  setConvoLaneGit: LaneGitWriter;
}): Promise<((laneGit: WorkspaceLaneGit) => Promise<boolean>) | undefined> {
  if (!enabled || !user || !conversationId) return undefined;
  const safeRepo = isSafeRepo(repo) ? repo : undefined;

  let placed: Placement;
  try {
    const context = getConvoLaneContext ? await getConvoLaneContext(user, conversationId) : null;
    const root = context?.subagentThread?.rootConversationId;
    placed = {
      conversationId: root || conversationId,
      required: Boolean(root),
      epoch: context?.codeAttachmentEpoch ?? 0,
    };
  } catch (error) {
    logger.warn('[LaneGit] Failed to place a lane recorder', getSafeErrorMetadata(error));
    return undefined;
  }
  if (placed.required && workspace == null) return undefined;
  const queueKey = `${user}\0${placed.conversationId}`;

  /** Never rejects, so a failed reservation cannot stall the ones queued behind it. */
  const reserve = async (): Promise<Reservation | null> => {
    try {
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
          ? {
              workspace: {
                ...workspace,
                ...(reserved.required ? { required: true } : {}),
                epoch: reserved.epoch,
              },
            }
          : {}),
      });
    } catch (error) {
      logger.warn('[LaneGit] Failed to record lane state', getSafeErrorMetadata(error));
      return false;
    }
  };

  /**
   * Fire-and-forget for the command: it never throws and is never awaited. Each report takes its
   * sequence number from the database in report order and is written with it, so the newest report
   * wins whatever order the writes land in. Every report is written, repeats included, because
   * another recorder (a sibling thread, another replica) may have changed the lane since this one
   * last wrote, and the database already ignores a write that changes nothing the reader can see.
   * Resolves to whether the write applied, which is false when a newer report is already stored
   * and for a conversation not saved yet. A repo that is not a plain `owner/name` is dropped.
   */
  return (laneGit) => {
    const previous = reservationTails.get(queueKey) ?? Promise.resolve();
    const reservation = previous.then(() => reserve());
    reservationTails.set(queueKey, reservation);
    void reservation.then(() => {
      if (reservationTails.get(queueKey) === reservation) reservationTails.delete(queueKey);
    });
    return reservation.then((reserved) => (reserved == null ? false : write(laneGit, reserved)));
  };
}
