import type { PRAutomationState } from 'librechat-data-provider';
import type { PRAutomationStopCode } from 'librechat-data-provider';
import type { PRAutomationTrustLevel } from 'librechat-data-provider';
import type * as t from '~/types/prAutomation';
import { MAX_PR_AUTOMATION_BOTS } from '~/types/prAutomation';

const PROJECTION = '-_id -__v';
const CLAIMABLE_STATES: PRAutomationState[] = ['idle', 'waiting'];

export function createPRAutomationMethods(mongoose: typeof import('mongoose')): {
  getPRAutomation: (key: t.PRAutomationKey) => Promise<t.IPRAutomation | null>;
  enablePRAutomation: (params: t.EnablePRAutomationParams) => Promise<t.IPRAutomation>;
  disablePRAutomation: (key: t.PRAutomationKey) => Promise<{ removed: boolean }>;
  claimPRAutomationRound: (
    params: t.ClaimPRAutomationRoundParams,
  ) => Promise<t.ClaimPRAutomationRoundResult>;
  setPRAutomationState: (
    key: t.PRAutomationKey,
    next: { state: PRAutomationState; stopCode?: PRAutomationStopCode },
  ) => Promise<t.IPRAutomation | null>;
  setPRAutomationTrust: (
    key: t.PRAutomationKey,
    trust: PRAutomationTrustLevel,
  ) => Promise<t.IPRAutomation | null>;
  addPRAutomationBot: (
    key: t.PRAutomationKey,
    bot: t.IPRAutomationBot,
  ) => Promise<t.PRAutomationBotResult>;
  removePRAutomationBot: (key: t.PRAutomationKey, botId: number) => Promise<t.IPRAutomation | null>;
} {
  const keyFilter = ({ userId, conversationId }: t.PRAutomationKey) => ({
    user: userId,
    conversationId,
  });

  /** Absence is a normal answer here; a query failure throws. */
  async function getPRAutomation(key: t.PRAutomationKey): Promise<t.IPRAutomation | null> {
    const PRAutomation = mongoose.models.PRAutomation;
    return PRAutomation.findOne(keyFilter(key)).select(PROJECTION).lean<t.IPRAutomation>();
  }

  /**
   * Idempotent. An existing active record is returned unchanged. A stopped
   * record is the user explicitly turning the automation back on, so it starts
   * a fresh run: the round counter and the time window reset, which they could
   * not do from a webhook-triggered turn.
   */
  async function enablePRAutomation({
    trust,
    repository,
    pullNumber,
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
          trust: trust ?? 'approvedBots',
        },
      },
      { upsert: true, runValidators: true },
    );
    await PRAutomation.updateOne(
      { ...filter, state: 'stopped' },
      {
        $set: { state: 'idle', round: 0, ...(trust != null && { trust }) },
        $unset: { stopCode: '', startedAt: '', lastHeadSha: '' },
      },
    );
    if (repository != null || pullNumber != null) {
      await PRAutomation.updateOne(filter, {
        $set: {
          ...(repository != null && { repository }),
          ...(pullNumber != null && { pullNumber }),
        },
      });
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
   * deliveries racing for the same record cannot both pass the cap, and a
   * duplicate delivery for a head that was already claimed is rejected instead
   * of starting a second round. The persisted counter is what stops a new turn
   * from resetting the cap.
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
        lastHeadSha: { $ne: headSha },
      },
      {
        $inc: { round: 1 },
        $set: { state: 'fixing', lastHeadSha: headSha },
        $unset: { stopCode: '' },
      },
      { new: true, select: PROJECTION },
    ).lean<t.IPRAutomation>();
    if (claimed != null) {
      return { ok: true, value: claimed };
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

  /** A stopped record only leaves that state through `enablePRAutomation`. */
  async function setPRAutomationState(
    key: t.PRAutomationKey,
    next: { state: PRAutomationState; stopCode?: PRAutomationStopCode },
  ): Promise<t.IPRAutomation | null> {
    const PRAutomation = mongoose.models.PRAutomation;
    const stopCode = next.state === 'stopped' ? next.stopCode : undefined;
    return PRAutomation.findOneAndUpdate(
      { ...keyFilter(key), state: { $ne: 'stopped' } },
      stopCode != null
        ? { $set: { state: next.state, stopCode } }
        : { $set: { state: next.state }, $unset: { stopCode: '' } },
      { new: true, select: PROJECTION, runValidators: true },
    ).lean<t.IPRAutomation>();
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

  /** Idempotent by numeric id, and capped. A login is stored for display only. */
  async function addPRAutomationBot(
    key: t.PRAutomationKey,
    bot: t.IPRAutomationBot,
  ): Promise<t.PRAutomationBotResult> {
    const PRAutomation = mongoose.models.PRAutomation;
    const updated = await PRAutomation.findOneAndUpdate(
      {
        ...keyFilter(key),
        'trustedBots.id': { $ne: bot.id },
        [`trustedBots.${MAX_PR_AUTOMATION_BOTS - 1}`]: { $exists: false },
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
    setPRAutomationState,
    setPRAutomationTrust,
    addPRAutomationBot,
    removePRAutomationBot,
  };
}

export type PRAutomationMethods = ReturnType<typeof createPRAutomationMethods>;
