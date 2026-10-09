import { randomUUID } from 'node:crypto';
import {
  MAX_SUBAGENT_DEPTH,
  MAX_PR_AUTOMATION_BOTS,
  PR_AUTOMATION_STOP_CODES,
} from 'librechat-data-provider';
import type { PRAutomationTrustLevel } from 'librechat-data-provider';
import type { PRAutomationStopCode } from 'librechat-data-provider';
import type { PRAutomationState } from 'librechat-data-provider';
import type { PipelineStage } from 'mongoose';
import type * as t from '~/types/prAutomation';
import { isValidObjectIdString } from '~/utils/objectId';
import { createIndexesWithRetry } from '~/utils/retry';

const PROJECTION = '-_id -__v';
const RESTARTABLE = { state: 'stopped' };
/** Records removed per write, so a cleanup never holds one unbounded `$in`. */
const DELETE_BATCH = 1000;
/** A full SHA-1 or SHA-256 commit id; anything else is refused before it is stored. */
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * `owner_inactive` is an account deletion in progress, which can still be cancelled, so the
 * record is kept. `owner_gone` and `conversation_gone` can never run again.
 */
type Liveness = 'live' | 'conversation_gone' | 'owner_gone' | 'owner_inactive';
type Gone = Extract<Liveness, 'conversation_gone' | 'owner_gone'>;
const CLAIMABLE_STATES: PRAutomationState[] = ['idle', 'waiting'];
const SETTLEABLE_STATES: PRAutomationState[] = ['fixing', 'needs_user'];
const SETTLED_STATES: PRAutomationState[] = ['waiting', 'needs_user'];
/** Everything that belongs to one run on one pull request, under the given new epoch. */
const runReset = (epoch: string, fields: Record<string, unknown> = {}) => ({
  $set: { state: 'idle', round: 0, claimedHeads: [], epoch, ...fields },
  $unset: { stopCode: '', startedAt: '', lastHeadSha: '', runId: '' },
});
/** GitHub compares `owner/name` without case, so records store and match the lower case form. */
const canonicalRepository = (repository: string) => repository.toLowerCase();
const LINK_FIELDS = [
  'conversationId',
  'user',
  'expiredAt',
  'subagentThread.rootConversationId',
  'subagentThread.parentConversationId',
];

/**
 * One aggregation that reads a conversation and up to `MAX_SUBAGENT_DEPTH` ancestors, one
 * `$lookup` per generation, so a liveness check is one round trip at any depth. `$graphLookup`
 * would be shorter but Amazon DocumentDB rejects it. Each lookup is served by the unique
 * `{ conversationId, user, tenantId }` index; ownership and retention are judged on the result.
 */
function lineagePipeline({ userId, conversationId }: t.PRAutomationKey): PipelineStage[] {
  const stages: PipelineStage[] = [
    { $match: { user: userId, conversationId } },
    { $limit: 1 },
    {
      $project: {
        _id: 0,
        l0: Object.fromEntries(LINK_FIELDS.map((field) => [field, `$${field}`])),
      },
    },
  ];
  for (let level = 1; level <= MAX_SUBAGENT_DEPTH; level++) {
    const as = `l${level}`;
    stages.push(
      {
        $lookup: {
          from: 'conversations',
          localField: `l${level - 1}.subagentThread.parentConversationId`,
          foreignField: 'conversationId',
          as,
        },
      },
      { $unwind: { path: `$${as}`, preserveNullAndEmptyArrays: true } },
    );
  }
  const keep: Record<string, 1> = {};
  for (let level = 0; level <= MAX_SUBAGENT_DEPTH; level++) {
    for (const field of LINK_FIELDS) {
      keep[`l${level}.${field}`] = 1;
    }
  }
  stages.push({ $project: { _id: 0, ...keep } });
  return stages;
}

const isGone = (liveness: Liveness): liveness is Gone =>
  liveness === 'conversation_gone' || liveness === 'owner_gone';

export function createPRAutomationMethods(mongoose: typeof import('mongoose')): {
  getPRAutomation: (key: t.PRAutomationKey) => Promise<t.IPRAutomation | null>;
  enablePRAutomation: (params: t.EnablePRAutomationParams) => Promise<t.EnablePRAutomationResult>;
  disablePRAutomation: (key: t.PRAutomationKey) => Promise<{ removed: boolean }>;
  claimPRAutomationRound: (
    params: t.ClaimPRAutomationRoundParams,
  ) => Promise<t.ClaimPRAutomationRoundResult>;
  settlePRAutomationRound: (
    params: t.SettlePRAutomationRoundParams,
  ) => Promise<t.IPRAutomation | null>;
  stopPRAutomation: {
    (key: t.PRAutomationKey, stopCode: 'user_stopped'): Promise<t.IPRAutomation | null>;
    (
      key: t.PRAutomationKey,
      stopCode: t.PRAutomationEventStopCode,
      fence: t.PRAutomationRunFence,
    ): Promise<t.IPRAutomation | null>;
  };
  deletePRAutomations: (userId: string, conversationIds?: string[]) => Promise<void>;
  setPRAutomationTrust: (
    key: t.PRAutomationKey,
    trust: PRAutomationTrustLevel,
  ) => Promise<t.IPRAutomation | null>;
  addPRAutomationBot: (
    key: t.PRAutomationKey,
    bot: t.IPRAutomationBot,
    maxBots: number,
    fence: t.PRAutomationBotFence,
  ) => Promise<t.PRAutomationBotResult>;
  removePRAutomationBot: (
    key: t.PRAutomationKey,
    botId: number,
    fence: t.PRAutomationBotFence,
  ) => Promise<t.IPRAutomation | null>;
} {
  let indexesPromise: Promise<void> | null = null;

  /**
   * The unique `{ user, conversationId }` index is what keeps concurrent first-time enables
   * from inserting two records that are then claimed independently and exceed the round cap.
   * With `MONGO_AUTO_INDEX=false` the schema declaration alone never builds it, so it is
   * ensured before the first write.
   */
  function ensureIndexes(): Promise<void> {
    if (!indexesPromise) {
      indexesPromise = createIndexesWithRetry(mongoose.models.PRAutomation).catch((error) => {
        indexesPromise = null;
        throw error;
      });
    }
    return indexesPromise;
  }

  const keyFilter = ({ userId, conversationId }: t.PRAutomationKey) => ({
    user: userId,
    conversationId,
  });

  /**
   * Whether a round may run for this record right now: the owner exists and no account
   * deletion has started (the same durable marker agent triggers use), and the conversation
   * and every conversation that controls it still exist and are inside their retention. A
   * subagent thread is controlled by every ancestor up to its root, and a deletion removes
   * one generation before it discovers the next, so the whole parent chain is checked, read in
   * one aggregation. The chain is live only when every link belongs to the owner, is inside
   * its retention and the walk ends at the recorded root. The walk is bounded by
   * `MAX_SUBAGENT_DEPTH`; a longer chain fails closed.
   * Deletions do not fence the record; enable and claim ask this on both sides of their write
   * instead.
   */
  async function checkLiveness(key: t.PRAutomationKey): Promise<Liveness> {
    if (!isValidObjectIdString(key.userId)) {
      return 'owner_inactive';
    }
    const Conversation = mongoose.models.Conversation;
    type Link = {
      conversationId: string;
      user: string;
      expiredAt?: Date | null;
      subagentThread?: { rootConversationId?: string; parentConversationId?: string };
    };
    const [owner, rows] = await Promise.all([
      mongoose.models.User.findById(key.userId)
        .select('agentTriggerDeletionStartedAt')
        .lean<{ agentTriggerDeletionStartedAt?: Date }>(),
      Conversation.aggregate<Record<string, Link | undefined>>(lineagePipeline(key)),
    ]);
    if (owner == null) {
      return 'owner_gone';
    }
    if (owner.agentTriggerDeletionStartedAt != null) {
      return 'owner_inactive';
    }
    /** Links of other users never count: a lookup by `conversationId` is not scoped by owner. */
    const now = Date.now();
    const links = new Map<string, Link>();
    for (const row of rows) {
      for (const link of Object.values(row)) {
        const active = link?.expiredAt == null || new Date(link.expiredAt).getTime() > now;
        if (link != null && String(link.user) === key.userId && active) {
          links.set(link.conversationId, link);
        }
      }
    }
    const conversation = links.get(key.conversationId);
    if (conversation == null) {
      return 'conversation_gone';
    }
    let current: Link | undefined = conversation;
    for (let hops = 0; current?.subagentThread?.parentConversationId != null; hops++) {
      if (hops >= MAX_SUBAGENT_DEPTH) {
        return 'conversation_gone';
      }
      current = links.get(current.subagentThread.parentConversationId);
    }
    const root = conversation.subagentThread?.rootConversationId;
    if (current == null || (root != null && current.conversationId !== root)) {
      return 'conversation_gone';
    }
    return 'live';
  }

  /** A missing owner reads as inactive to callers; the distinction only decides removal. */
  const goneCode = (liveness: Gone) =>
    liveness === 'owner_gone' ? 'owner_inactive' : 'conversation_gone';

  /**
   * A record whose conversation or owner is gone can never run again, so it is removed. This
   * also converges a cleanup that failed after the delete committed.
   */
  async function refuseClaim(
    key: t.PRAutomationKey,
    liveness: Exclude<Liveness, 'live'>,
  ): Promise<t.ClaimPRAutomationRoundResult> {
    if (!isGone(liveness)) {
      return { ok: false, error: { code: liveness } };
    }
    const removed = await mongoose.models.PRAutomation.deleteOne(keyFilter(key));
    return {
      ok: false,
      error: { code: removed.deletedCount > 0 ? goneCode(liveness) : 'not_found' },
    };
  }

  function assertStopCode(stopCode: PRAutomationStopCode): void {
    if (!PR_AUTOMATION_STOP_CODES.includes(stopCode)) {
      throw new RangeError('A stopped PR automation needs a known stop code');
    }
  }

  /** Absence is a normal answer here; a query failure throws. */
  async function getPRAutomation(key: t.PRAutomationKey): Promise<t.IPRAutomation | null> {
    const PRAutomation = mongoose.models.PRAutomation;
    return PRAutomation.findOne(keyFilter(key)).select(PROJECTION).lean<t.IPRAutomation>();
  }

  /**
   * Idempotent. An existing active record is returned unchanged. A stopped
   * record is the user explicitly turning the automation back on, so it starts
   * a fresh run: the round counter, the time window, the claimed heads and the
   * run identity reset, which they could not do from a webhook-triggered turn.
   *
   * `binding` names the pull request. Each case below is one conditional write that
   * carries the whole pair and the run reset together, so concurrent requests cannot
   * leave a pair nobody asked for, and a stopped record is revived only by the write
   * that binds it: a binding that is rejected leaves it stopped. A different repository
   * clears the approved bots, which belong to one repository, and starts a fresh run.
   * A different pull request in the same repository keeps the bots and starts a fresh
   * run, because the round count, the time window and the claimed heads describe the
   * previous pull request.
   *
   * Liveness is checked on both sides of the writes, like a claim. An enable for a conversation
   * or owner that is already gone writes nothing. One that passed the first check but lost a
   * race with the deletion and its cleanup removes the record it wrote, so a late enable cannot
   * recreate a record nobody will clean up.
   */
  async function enablePRAutomation({
    trust,
    binding: requested,
    ...key
  }: t.EnablePRAutomationParams): Promise<t.EnablePRAutomationResult> {
    const binding =
      requested == null
        ? undefined
        : { ...requested, repository: canonicalRepository(requested.repository) };
    const before = await checkLiveness(key);
    if (before !== 'live') {
      return { ok: false, error: { code: isGone(before) ? goneCode(before) : before } };
    }
    await ensureIndexes();
    const PRAutomation = mongoose.models.PRAutomation;
    const filter = keyFilter(key);
    /**
     * Every write of this attempt stamps the same new epoch, so the record carries it only when
     * this attempt changed it. Each write returns the record as it was just before that write,
     * atomically with it, and the last one this attempt did not already own is what a crossed
     * deletion restores: a later enable that landed between this attempt's read and write is
     * kept, and nothing a later enable wrote afterwards is reverted.
     */
    const attempt = randomUUID();
    const reset = (fields: Record<string, unknown>) => runReset(attempt, fields);
    const options = { runValidators: true };
    let undo: { previous: t.IPRAutomation | null } | undefined;
    const write = async (condition: Record<string, unknown>, update: Record<string, unknown>) => {
      const before = await PRAutomation.findOneAndUpdate({ ...filter, ...condition }, update, {
        ...options,
        new: false,
      }).lean<t.IPRAutomation>();
      if (before != null && before.epoch !== attempt) {
        undo = { previous: before };
      }
    };
    const existing = await PRAutomation.findOneAndUpdate(
      filter,
      {
        $setOnInsert: {
          ...filter,
          state: 'idle',
          round: 0,
          trustedBots: [],
          claimedHeads: [],
          epoch: attempt,
          trust: trust ?? 'approvedBots',
          ...binding,
        },
      },
      { upsert: true, new: false, ...options },
    ).lean<t.IPRAutomation>();
    if (existing == null) {
      undo = { previous: null };
    }
    /** A trust level passed with the request applies to every write that starts a run. */
    const revive = trust != null ? { trust } : {};
    if (binding == null) {
      await write(RESTARTABLE, reset(revive));
    } else {
      const { repository } = binding;
      const otherRepository = { repository: { $ne: repository } };
      await write(
        { ...RESTARTABLE, ...otherRepository },
        reset({ ...revive, ...binding, trustedBots: [] }),
      );
      await write({ ...RESTARTABLE, repository }, reset({ ...revive, ...binding }));
      await write(
        { state: { $ne: 'stopped' }, ...otherRepository },
        reset({ ...revive, ...binding, trustedBots: [] }),
      );
      await write(
        { state: { $ne: 'stopped' }, repository, pullNumber: { $ne: binding.pullNumber } },
        reset({ ...revive, ...binding }),
      );
    }
    const after = await checkLiveness(key);
    if (isGone(after)) {
      await PRAutomation.deleteOne(filter);
      return { ok: false, error: { code: goneCode(after) } };
    }
    if (after !== 'live') {
      if (undo != null) {
        await undoEnable({ ...filter, epoch: attempt }, undo.previous);
      }
      return { ok: false, error: { code: after } };
    }
    const record = await getPRAutomation(key);
    if (record == null) {
      throw new Error('PR automation record missing after enable');
    }
    return { ok: true, value: record };
  }

  /**
   * Puts the record back as this enable's own write found it when an account deletion started
   * during the write, which can still be cancelled. `guard` names the epoch only this attempt
   * wrote, so a record a later enable already replaced is left alone.
   */
  async function undoEnable(
    guard: ReturnType<typeof keyFilter> & { epoch: string },
    previous: t.IPRAutomation | null,
  ): Promise<void> {
    const PRAutomation = mongoose.models.PRAutomation;
    if (previous == null) {
      await PRAutomation.deleteOne(guard);
      return;
    }
    await PRAutomation.replaceOne(guard, previous);
  }

  async function disablePRAutomation(key: t.PRAutomationKey): Promise<{ removed: boolean }> {
    const PRAutomation = mongoose.models.PRAutomation;
    const result = await PRAutomation.deleteOne(keyFilter(key));
    return { removed: result.deletedCount > 0 };
  }

  /**
   * Starts one fix round, atomically. The round count, the time window, the
   * state and the head are all conditions of a single `findOneAndUpdate`, so two
   * deliveries racing for the same record cannot both pass the cap. A head that
   * any earlier round already claimed is rejected, so a delayed delivery of a
   * superseded commit cannot spend the budget. The persisted counter is what
   * stops a new turn from resetting the cap. Each claim gets a `runId`, which
   * the round must present to settle. The delivery names the pull request it is
   * for, and the claim applies only while the record is still bound to it, so an
   * event that arrives after a rebind cannot spend the new pull request's budget.
   *
   * A force-push back to an earlier SHA is rejected the same way; the user
   * restarts the automation to work on it.
   */
  async function claimPRAutomationRound({
    binding,
    maxRounds,
    maxMinutes,
    headSha: rawHeadSha,
    now = new Date(),
    ...key
  }: t.ClaimPRAutomationRoundParams): Promise<t.ClaimPRAutomationRoundResult> {
    if (!COMMIT_SHA.test(rawHeadSha)) {
      throw new RangeError('headSha must be a full commit SHA');
    }
    /** One Git object, one identity: hex case must not let a commit spend two rounds. */
    const headSha = rawHeadSha.toLowerCase();
    const PRAutomation = mongoose.models.PRAutomation;
    const repository = canonicalRepository(binding.repository);
    const filter = {
      ...keyFilter(key),
      repository,
      pullNumber: binding.pullNumber,
      epoch: binding.epoch,
    };
    const cutoff = new Date(now.getTime() - maxMinutes * 60_000);
    const runId = randomUUID();

    /**
     * Conversations also leave through the retention index, which never runs
     * `deleteConvos`, so liveness is checked here rather than trusted to a cascade.
     */
    const before = await checkLiveness(key);
    if (before !== 'live') {
      return refuseClaim(key, before);
    }

    /**
     * The window opens with the first round that is actually claimed. `$min` sets `startedAt`
     * only when it is missing and keeps the earlier time otherwise, so the window is part of the
     * same atomic write: a claim that fails or is abandoned leaves nothing behind to count
     * against `maxMinutes`.
     */
    const claimed = await PRAutomation.findOneAndUpdate(
      {
        ...filter,
        state: { $in: CLAIMABLE_STATES },
        round: { $lt: maxRounds },
        $or: [{ startedAt: { $exists: false } }, { startedAt: { $gte: cutoff } }],
        claimedHeads: { $ne: headSha },
      },
      {
        $min: { startedAt: now },
        $inc: { round: 1 },
        $set: { state: 'fixing', lastHeadSha: headSha, runId },
        $push: { claimedHeads: headSha },
        $unset: { stopCode: '' },
      },
      { new: true, select: PROJECTION },
    ).lean<t.IPRAutomation>();
    if (claimed != null) {
      /**
       * A deletion that started between the first check and the write is seen here. The
       * whole claim is undone under its own run id, so it never starts work and a cancelled
       * deletion leaves the record as it was: the round, the window and the head are not
       * spent. Rounds and heads are claimed one for one and the window opens with the first
       * round, so the state before the claim follows from the claimed record. A record whose
       * conversation or owner is gone is removed.
       */
      const after = await checkLiveness(key);
      if (after === 'live') {
        return { ok: true, value: { ...claimed, runId } };
      }
      const previousHeads = claimed.claimedHeads.slice(0, -1);
      const lastHeadSha = previousHeads[previousHeads.length - 1];
      await PRAutomation.updateOne(
        { ...keyFilter(key), runId, state: 'fixing', round: claimed.round },
        {
          $set: {
            state: lastHeadSha == null ? 'idle' : 'waiting',
            round: claimed.round - 1,
            claimedHeads: previousHeads,
            ...(lastHeadSha != null && { lastHeadSha }),
          },
          $unset: {
            runId: '',
            ...(lastHeadSha == null && { startedAt: '', lastHeadSha: '' }),
          },
        },
      );
      return refuseClaim(key, after);
    }

    const current = await getPRAutomation(key);
    if (current == null) {
      return { ok: false, error: { code: 'not_found' } };
    }
    if (
      current.repository !== repository ||
      current.pullNumber !== binding.pullNumber ||
      current.epoch !== binding.epoch
    ) {
      return { ok: false, error: { code: 'binding_mismatch' } };
    }
    if (!CLAIMABLE_STATES.includes(current.state)) {
      return { ok: false, error: { code: 'not_active' } };
    }
    if (current.round >= maxRounds) {
      return { ok: false, error: { code: 'round_cap' } };
    }
    if (current.startedAt != null && current.startedAt < cutoff) {
      return { ok: false, error: { code: 'time_cap' } };
    }
    if (current.claimedHeads.includes(headSha)) {
      return { ok: false, error: { code: 'stale_head' } };
    }
    /** Every condition passes now, so the record changed between the write and this read. */
    return { ok: false, error: { code: 'conflict' } };
  }

  /**
   * Reports where the round that owns the record ended up. The transition only
   * applies while that round is still the current one, identified by its
   * `runId`, so a completion that is retried after a later round was claimed, or
   * after the run was stopped, restarted or rebound, cannot move the newer run
   * to `waiting` and open the way for an overlapping claim. Returns `null` when
   * nothing changed: no record, a stopped record, or a round that is not the
   * current one.
   */
  async function settlePRAutomationRound({
    round,
    runId,
    state,
    ...key
  }: t.SettlePRAutomationRoundParams): Promise<t.IPRAutomation | null> {
    if (!SETTLED_STATES.includes(state)) {
      throw new RangeError(
        'A round settles as waiting or needs_user; use stopPRAutomation to stop',
      );
    }
    const PRAutomation = mongoose.models.PRAutomation;
    return PRAutomation.findOneAndUpdate(
      { ...keyFilter(key), state: { $in: SETTLEABLE_STATES }, round, runId },
      { $set: { state } },
      { new: true, select: PROJECTION },
    ).lean<t.IPRAutomation>();
  }

  /**
   * Stops the automation whatever round is running. A stop code is required: the client
   * maps it to the reason it shows. The first stop wins, and a stopped record leaves that
   * state only through `enablePRAutomation`.
   *
   * A user stop is unconditional, so it is never lost to a race; any fence passed with it is
   * ignored. Every other code comes from an event about one run, and a delayed one must not
   * stop the run that replaced it, so it names the pull request and the epoch it saw and
   * applies only while both are current. A restart on the same pull request starts a new
   * epoch, so a stop meant for the previous run cannot end the new one.
   */
  async function stopPRAutomation(
    key: t.PRAutomationKey,
    stopCode: PRAutomationStopCode,
    fence?: t.PRAutomationRunFence,
  ): Promise<t.IPRAutomation | null> {
    assertStopCode(stopCode);
    const user = stopCode === 'user_stopped';
    if (!user && (fence?.repository == null || fence.pullNumber == null || !fence.epoch)) {
      throw new RangeError('An event-driven stop must name the pull request and run it is for');
    }
    const condition =
      user || fence == null
        ? {}
        : {
            repository: canonicalRepository(fence.repository),
            pullNumber: fence.pullNumber,
            epoch: fence.epoch,
          };
    const PRAutomation = mongoose.models.PRAutomation;
    return PRAutomation.findOneAndUpdate(
      { ...keyFilter(key), ...condition, state: { $ne: 'stopped' } },
      { $set: { state: 'stopped', stopCode } },
      { new: true, select: PROJECTION },
    ).lean<t.IPRAutomation>();
  }

  /**
   * Removes every record of a user, or of the listed conversations, in bounded batches.
   * Cleanup only: it creates nothing, so a deployment that never used the feature pays one
   * indexed delete that matches no document.
   */
  async function deletePRAutomations(userId: string, conversationIds?: string[]): Promise<void> {
    const PRAutomation = mongoose.models.PRAutomation;
    if (PRAutomation == null || conversationIds?.length === 0) {
      return;
    }
    if (conversationIds == null) {
      await PRAutomation.deleteMany({ user: userId });
      return;
    }
    for (let start = 0; start < conversationIds.length; start += DELETE_BATCH) {
      await PRAutomation.deleteMany({
        user: userId,
        conversationId: { $in: conversationIds.slice(start, start + DELETE_BATCH) },
      });
    }
  }

  async function setPRAutomationTrust(
    key: t.PRAutomationKey,
    trust: PRAutomationTrustLevel,
  ): Promise<t.IPRAutomation | null> {
    const PRAutomation = mongoose.models.PRAutomation;
    return PRAutomation.findOneAndUpdate(
      keyFilter(key),
      { $set: { trust } },
      { new: true, select: PROJECTION, runValidators: true },
    ).lean<t.IPRAutomation>();
  }

  /**
   * Idempotent by numeric id. The limit is the configured `maxBots`, resolved by
   * the caller, and cannot exceed the schema ceiling. A login is stored for
   * display only. The approval names the repository and the epoch it was authorized
   * against and applies only while both are current, so an approval that overlaps a
   * rebind, including one away and back to the same repository that cleared the list,
   * cannot add a bot nobody approved for the current binding.
   */
  async function addPRAutomationBot(
    key: t.PRAutomationKey,
    bot: t.IPRAutomationBot,
    maxBots: number,
    fence: t.PRAutomationBotFence,
  ): Promise<t.PRAutomationBotResult> {
    const repository = canonicalRepository(fence.repository);
    const { epoch } = fence;
    if (!Number.isInteger(maxBots) || maxBots < 1 || maxBots > MAX_PR_AUTOMATION_BOTS) {
      throw new RangeError(`maxBots must be an integer from 1 to ${MAX_PR_AUTOMATION_BOTS}`);
    }
    const PRAutomation = mongoose.models.PRAutomation;
    const updated = await PRAutomation.findOneAndUpdate(
      {
        ...keyFilter(key),
        repository,
        epoch,
        'trustedBots.id': { $ne: bot.id },
        [`trustedBots.${maxBots - 1}`]: { $exists: false },
      },
      { $push: { trustedBots: bot } },
      { new: true, select: PROJECTION, runValidators: true },
    ).lean<t.IPRAutomation>();
    if (updated != null) {
      return { ok: true, value: updated };
    }

    const current = await getPRAutomation(key);
    if (current == null) {
      return { ok: false, error: { code: 'not_found' } };
    }
    if (current.repository !== repository || current.epoch !== epoch) {
      return { ok: false, error: { code: 'binding_mismatch' } };
    }
    if (current.trustedBots.some((existing) => existing.id === bot.id)) {
      return { ok: true, value: current };
    }
    return { ok: false, error: { code: 'bot_limit' } };
  }

  /**
   * Names the repository and epoch like an approval does, so a delayed removal cannot delete
   * an approval made for a later binding, including one away and back to the same repository.
   */
  async function removePRAutomationBot(
    key: t.PRAutomationKey,
    botId: number,
    { repository, epoch }: t.PRAutomationBotFence,
  ): Promise<t.IPRAutomation | null> {
    const PRAutomation = mongoose.models.PRAutomation;
    return PRAutomation.findOneAndUpdate(
      { ...keyFilter(key), repository: canonicalRepository(repository), epoch },
      { $pull: { trustedBots: { id: botId } } },
      { new: true, select: PROJECTION },
    ).lean<t.IPRAutomation>();
  }

  return {
    getPRAutomation,
    enablePRAutomation,
    disablePRAutomation,
    claimPRAutomationRound,
    settlePRAutomationRound,
    stopPRAutomation,
    deletePRAutomations,
    setPRAutomationTrust,
    addPRAutomationBot,
    removePRAutomationBot,
  };
}

export type PRAutomationMethods = ReturnType<typeof createPRAutomationMethods>;
