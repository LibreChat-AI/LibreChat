import { randomUUID } from 'node:crypto';
import { PR_AUTOMATION_STOP_CODES, MAX_PR_AUTOMATION_BOTS } from 'librechat-data-provider';
import type { PRAutomationTrustLevel } from 'librechat-data-provider';
import type { PRAutomationStopCode } from 'librechat-data-provider';
import type { PRAutomationState } from 'librechat-data-provider';
import type * as t from '~/types/prAutomation';

const PROJECTION = '-_id -__v';
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
  stopPRAutomation: (
    key: t.PRAutomationKey,
    stopCode: PRAutomationStopCode,
  ) => Promise<t.IPRAutomation | null>;
  stopPRAutomations: (
    userId: string,
    stopCode: PRAutomationStopCode,
    conversationIds?: string[],
  ) => Promise<void>;
  deletePRAutomations: (userId: string, conversationIds?: string[]) => Promise<void>;
  setPRAutomationTrust: (
    key: t.PRAutomationKey,
    trust: PRAutomationTrustLevel,
  ) => Promise<t.IPRAutomation | null>;
  addPRAutomationBot: (
    key: t.PRAutomationKey,
    bot: t.IPRAutomationBot,
    maxBots: number,
  ) => Promise<t.PRAutomationBotResult>;
  removePRAutomationBot: (key: t.PRAutomationKey, botId: number) => Promise<t.IPRAutomation | null>;
} {
  const keyFilter = ({ userId, conversationId }: t.PRAutomationKey) => ({
    user: userId,
    conversationId,
  });

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
   * `binding` names the pull request. The repository and the number are one
   * conditional write, so concurrent requests cannot leave a pair nobody asked
   * for. A different repository clears the approved bots, which belong to one
   * repository, and starts a fresh run. A different pull request in the same
   * repository keeps the bots and starts a fresh run, because the round count,
   * the time window and the claimed heads describe the previous pull request.
   */
  async function enablePRAutomation({
    trust,
    binding,
    ...key
  }: t.EnablePRAutomationParams): Promise<t.IPRAutomation> {
    const PRAutomation = mongoose.models.PRAutomation;
    const filter = keyFilter(key);
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
        },
      },
      { upsert: true, runValidators: true },
    );
    await PRAutomation.updateOne(
      { ...filter, state: 'stopped' },
      {
        $set: { ...RUN_RESET.$set, ...(trust != null && { trust }) },
        $unset: RUN_RESET.$unset,
      },
    );
    if (binding != null) {
      await PRAutomation.updateOne(
        { ...filter, repository: { $ne: binding.repository } },
        {
          $set: { ...RUN_RESET.$set, ...binding, trustedBots: [] },
          $unset: RUN_RESET.$unset,
        },
        { runValidators: true },
      );
      await PRAutomation.updateOne(
        { ...filter, repository: binding.repository, pullNumber: { $ne: binding.pullNumber } },
        { $set: { ...RUN_RESET.$set, ...binding }, $unset: RUN_RESET.$unset },
        { runValidators: true },
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
   * the round must present to settle.
   *
   * A force-push back to an earlier SHA is rejected the same way; the user
   * restarts the automation to work on it.
   */
  async function claimPRAutomationRound({
    maxRounds,
    maxMinutes,
    headSha,
    now = new Date(),
    ...key
  }: t.ClaimPRAutomationRoundParams): Promise<t.ClaimPRAutomationRoundResult> {
    const PRAutomation = mongoose.models.PRAutomation;
    const filter = keyFilter(key);
    const cutoff = new Date(now.getTime() - maxMinutes * 60_000);
    const runId = randomUUID();

    /** The window opens at the first claim attempt on an active record, once. */
    await PRAutomation.updateOne(
      { ...filter, state: { $in: CLAIMABLE_STATES }, startedAt: { $exists: false } },
      { $set: { startedAt: now } },
    );

    const claimed = await PRAutomation.findOneAndUpdate(
      {
        ...filter,
        state: { $in: CLAIMABLE_STATES },
        round: { $lt: maxRounds },
        startedAt: { $gte: cutoff },
        claimedHeads: { $ne: headSha },
      },
      {
        $inc: { round: 1 },
        $set: { state: 'fixing', lastHeadSha: headSha, runId },
        $push: { claimedHeads: headSha },
        $unset: { stopCode: '' },
      },
      { new: true, select: PROJECTION },
    ).lean<t.IPRAutomation>();
    if (claimed != null) {
      return { ok: true, value: { ...claimed, runId } };
    }

    const current = await getPRAutomation(key);
    if (current == null) {
      return { ok: false, error: { code: 'not_found' } };
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
   * Stops the automation whatever round is running, so a user stop is never
   * lost to a race. A stop code is required: the client maps it to the reason
   * it shows. The first stop wins, and a stopped record leaves that state only
   * through `enablePRAutomation`.
   */
  async function stopPRAutomation(
    key: t.PRAutomationKey,
    stopCode: PRAutomationStopCode,
  ): Promise<t.IPRAutomation | null> {
    assertStopCode(stopCode);
    const PRAutomation = mongoose.models.PRAutomation;
    return PRAutomation.findOneAndUpdate(
      { ...keyFilter(key), state: { $ne: 'stopped' } },
      { $set: { state: 'stopped', stopCode } },
      { new: true, select: PROJECTION },
    ).lean<t.IPRAutomation>();
  }

  /**
   * Fences every record of a user, or of the listed conversations, without
   * removing it. A deletion fences first so a webhook cannot claim a record
   * whose conversation or account is going away, and removes the record only
   * after the delete committed, so a failed delete keeps the stored state.
   */
  async function stopPRAutomations(
    userId: string,
    stopCode: PRAutomationStopCode,
    conversationIds?: string[],
  ): Promise<void> {
    assertStopCode(stopCode);
    const PRAutomation = mongoose.models.PRAutomation;
    if (PRAutomation == null || conversationIds?.length === 0) {
      return;
    }
    await PRAutomation.updateMany(
      {
        user: userId,
        state: { $ne: 'stopped' },
        ...(conversationIds != null && { conversationId: { $in: conversationIds } }),
      },
      { $set: { state: 'stopped', stopCode } },
    );
  }

  /** Removes every record of a user, or of the listed conversations. */
  async function deletePRAutomations(userId: string, conversationIds?: string[]): Promise<void> {
    const PRAutomation = mongoose.models.PRAutomation;
    if (PRAutomation == null || conversationIds?.length === 0) {
      return;
    }
    await PRAutomation.deleteMany({
      user: userId,
      ...(conversationIds != null && { conversationId: { $in: conversationIds } }),
    });
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
   * display only.
   */
  async function addPRAutomationBot(
    key: t.PRAutomationKey,
    bot: t.IPRAutomationBot,
    maxBots: number,
  ): Promise<t.PRAutomationBotResult> {
    if (!Number.isInteger(maxBots) || maxBots < 1 || maxBots > MAX_PR_AUTOMATION_BOTS) {
      throw new RangeError(`maxBots must be an integer from 1 to ${MAX_PR_AUTOMATION_BOTS}`);
    }
    const PRAutomation = mongoose.models.PRAutomation;
    const updated = await PRAutomation.findOneAndUpdate(
      {
        ...keyFilter(key),
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
    if (current.trustedBots.some((existing) => existing.id === bot.id)) {
      return { ok: true, value: current };
    }
    return { ok: false, error: { code: 'bot_limit' } };
  }

  async function removePRAutomationBot(
    key: t.PRAutomationKey,
    botId: number,
  ): Promise<t.IPRAutomation | null> {
    const PRAutomation = mongoose.models.PRAutomation;
    return PRAutomation.findOneAndUpdate(
      keyFilter(key),
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
    stopPRAutomations,
    deletePRAutomations,
    setPRAutomationTrust,
    addPRAutomationBot,
    removePRAutomationBot,
  };
}

export type PRAutomationMethods = ReturnType<typeof createPRAutomationMethods>;
