import { randomUUID } from 'node:crypto';
import { PR_AUTOMATION_STOP_CODES, MAX_PR_AUTOMATION_BOTS } from 'librechat-data-provider';
import type { PRAutomationTrustLevel } from 'librechat-data-provider';
import type { PRAutomationStopCode } from 'librechat-data-provider';
import type { PRAutomationState } from 'librechat-data-provider';
import type * as t from '~/types/prAutomation';
import { activeExpirationFilter } from '~/utils/retention';
import { isValidObjectIdString } from '~/utils/objectId';
import { createIndexesWithRetry } from '~/utils/retry';

const PROJECTION = '-_id -__v';
const RESTARTABLE = { state: 'stopped' };
/** Records removed per write, so a cleanup never holds one unbounded `$in`. */
const DELETE_BATCH = 1000;

type Liveness = 'live' | 'conversation_gone' | 'owner_inactive';
const CLAIMABLE_STATES: PRAutomationState[] = ['idle', 'waiting'];
const SETTLEABLE_STATES: PRAutomationState[] = ['fixing', 'needs_user'];
const SETTLED_STATES: PRAutomationState[] = ['waiting', 'needs_user'];
/** Everything that belongs to one run on one pull request. */
const RUN_RESET = {
  $set: { state: 'idle', round: 0, claimedHeads: [] },
  $unset: { stopCode: '', startedAt: '', lastHeadSha: '', runId: '' },
};

export function createPRAutomationMethods(mongoose: typeof import('mongoose')): {
  getPRAutomation: (key: t.PRAutomationKey) => Promise<t.IPRAutomation | null>;
  enablePRAutomation: (params: t.EnablePRAutomationParams) => Promise<t.IPRAutomation>;
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
      stopCode: PRAutomationStopCode,
      binding: t.PRAutomationBinding,
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
    repository: string,
  ) => Promise<t.PRAutomationBotResult>;
  removePRAutomationBot: (
    key: t.PRAutomationKey,
    botId: number,
    repository: string,
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
   * subagent thread is controlled by its parent and its root, and a deletion removes the
   * root before it discovers the descendants. Deletions do not fence the record; the claim
   * asks this on both sides of its write instead.
   */
  async function checkLiveness(key: t.PRAutomationKey): Promise<Liveness> {
    if (!isValidObjectIdString(key.userId)) {
      return 'owner_inactive';
    }
    const Conversation = mongoose.models.Conversation;
    const active = activeExpirationFilter();
    const [owner, conversation] = await Promise.all([
      mongoose.models.User.exists({
        _id: key.userId,
        agentTriggerDeletionStartedAt: { $exists: false },
      }),
      Conversation.findOne({ user: key.userId, conversationId: key.conversationId, ...active })
        .select('subagentThread')
        .lean<{ subagentThread?: { rootConversationId: string; parentConversationId: string } }>(),
    ]);
    if (owner == null) {
      return 'owner_inactive';
    }
    if (conversation == null) {
      return 'conversation_gone';
    }
    const thread = conversation.subagentThread;
    if (thread == null) {
      return 'live';
    }
    const ancestors = [...new Set([thread.rootConversationId, thread.parentConversationId])];
    const activeAncestors = await Conversation.countDocuments({
      user: key.userId,
      conversationId: { $in: ancestors },
      ...active,
    });
    return activeAncestors === ancestors.length ? 'live' : 'conversation_gone';
  }

  /** A record whose conversation is gone can never run again, so it is removed. */
  async function refuseClaim(
    key: t.PRAutomationKey,
    liveness: Exclude<Liveness, 'live'>,
  ): Promise<t.ClaimPRAutomationRoundResult> {
    if (liveness === 'owner_inactive') {
      return { ok: false, error: { code: 'owner_inactive' } };
    }
    const removed = await mongoose.models.PRAutomation.deleteOne(keyFilter(key));
    return {
      ok: false,
      error: { code: removed.deletedCount > 0 ? 'conversation_gone' : 'not_found' },
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
   */
  async function enablePRAutomation({
    trust,
    binding,
    ...key
  }: t.EnablePRAutomationParams): Promise<t.IPRAutomation> {
    await ensureIndexes();
    const PRAutomation = mongoose.models.PRAutomation;
    const filter = keyFilter(key);
    const reset = (fields: Record<string, unknown>) => ({
      $set: { ...RUN_RESET.$set, ...fields },
      $unset: RUN_RESET.$unset,
    });
    const options = { runValidators: true };
    await PRAutomation.updateOne(
      filter,
      {
        $setOnInsert: {
          ...filter,
          state: 'idle',
          round: 0,
          trustedBots: [],
          claimedHeads: [],
          trust: trust ?? 'approvedBots',
          ...binding,
        },
      },
      { upsert: true, ...options },
    );
    const revive = trust != null ? { trust } : {};
    if (binding == null) {
      await PRAutomation.updateOne({ ...filter, ...RESTARTABLE }, reset(revive), options);
    } else {
      const { repository } = binding;
      const otherRepository = { repository: { $ne: repository } };
      await PRAutomation.updateOne(
        { ...filter, ...RESTARTABLE, ...otherRepository },
        reset({ ...revive, ...binding, trustedBots: [] }),
        options,
      );
      await PRAutomation.updateOne(
        { ...filter, ...RESTARTABLE, repository },
        reset({ ...revive, ...binding }),
        options,
      );
      await PRAutomation.updateOne(
        { ...filter, state: { $ne: 'stopped' }, ...otherRepository },
        reset({ ...binding, trustedBots: [] }),
        options,
      );
      await PRAutomation.updateOne(
        {
          ...filter,
          state: { $ne: 'stopped' },
          repository,
          pullNumber: { $ne: binding.pullNumber },
        },
        reset({ ...binding }),
        options,
      );
    }
    const record = await getPRAutomation(key);
    if (record == null) {
      throw new Error('PR automation record missing after enable');
    }
    return record;
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
    headSha,
    now = new Date(),
    ...key
  }: t.ClaimPRAutomationRoundParams): Promise<t.ClaimPRAutomationRoundResult> {
    const PRAutomation = mongoose.models.PRAutomation;
    const filter = { ...keyFilter(key), ...binding };
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
       * claimed round is handed back to `waiting` under its own run id, so it never starts
       * work, and a record whose conversation is gone is removed.
       */
      const after = await checkLiveness(key);
      if (after === 'live') {
        return { ok: true, value: { ...claimed, runId } };
      }
      await PRAutomation.updateOne(
        { ...keyFilter(key), runId, state: 'fixing' },
        { $set: { state: 'waiting' } },
      );
      return refuseClaim(key, after);
    }

    const current = await getPRAutomation(key);
    if (current == null) {
      return { ok: false, error: { code: 'not_found' } };
    }
    if (current.repository !== binding.repository || current.pullNumber !== binding.pullNumber) {
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
    return { ok: false, error: { code: 'stale_head' } };
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
   * A user stop is unconditional, so it is never lost to a race. Every other code comes from
   * an event about one pull request, and a delayed one must not stop the run that replaced
   * it, so it names the pull request it is for and applies only while the record is still
   * bound to it.
   */
  async function stopPRAutomation(
    key: t.PRAutomationKey,
    stopCode: PRAutomationStopCode,
    binding?: t.PRAutomationBinding,
  ): Promise<t.IPRAutomation | null> {
    assertStopCode(stopCode);
    if (stopCode !== 'user_stopped' && binding == null) {
      throw new RangeError('An event-driven stop must name the pull request it is for');
    }
    const PRAutomation = mongoose.models.PRAutomation;
    return PRAutomation.findOneAndUpdate(
      { ...keyFilter(key), ...binding, state: { $ne: 'stopped' } },
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
   * display only. The approval names the repository it was authorized against and
   * applies only while the record is still bound to it, so an approval that
   * overlaps a rebind cannot add a bot to a repository nobody approved it for.
   */
  async function addPRAutomationBot(
    key: t.PRAutomationKey,
    bot: t.IPRAutomationBot,
    maxBots: number,
    repository: string,
  ): Promise<t.PRAutomationBotResult> {
    if (!Number.isInteger(maxBots) || maxBots < 1 || maxBots > MAX_PR_AUTOMATION_BOTS) {
      throw new RangeError(`maxBots must be an integer from 1 to ${MAX_PR_AUTOMATION_BOTS}`);
    }
    const PRAutomation = mongoose.models.PRAutomation;
    const updated = await PRAutomation.findOneAndUpdate(
      {
        ...keyFilter(key),
        repository,
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
    if (current.repository !== repository) {
      return { ok: false, error: { code: 'binding_mismatch' } };
    }
    if (current.trustedBots.some((existing) => existing.id === bot.id)) {
      return { ok: true, value: current };
    }
    return { ok: false, error: { code: 'bot_limit' } };
  }

  /** Names the repository like an approval does, so a delayed removal cannot delete a newer approval. */
  async function removePRAutomationBot(
    key: t.PRAutomationKey,
    botId: number,
    repository: string,
  ): Promise<t.IPRAutomation | null> {
    const PRAutomation = mongoose.models.PRAutomation;
    return PRAutomation.findOneAndUpdate(
      { ...keyFilter(key), repository },
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
