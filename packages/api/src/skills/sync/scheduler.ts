import { logger } from '@librechat/data-schemas';
import type { SkillSyncConfig } from 'librechat-data-provider';
import type { GitHubSkillSyncRunner } from './github';
import { registerShutdownTask } from '~/app/shutdown';

const NODE_TIMER_MAX_MS = 2147483647;
const SKILL_SYNC_MIN_INTERVAL_MINUTES = 5;
export const SKILL_SYNC_MAX_TIMER_INTERVAL_MINUTES: number = Math.floor(NODE_TIMER_MAX_MS / 60_000);

type MaybePromise<T> = T | Promise<T>;

export type GitHubSkillSyncScheduler = {
  stop: () => void;
};

function normalizeIntervalMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 60;
  }
  return Math.min(
    SKILL_SYNC_MAX_TIMER_INTERVAL_MINUTES,
    Math.max(SKILL_SYNC_MIN_INTERVAL_MINUTES, Math.floor(value)),
  );
}

function getSources(config: SkillSyncConfig | undefined) {
  const sources = config?.github?.sources;
  return Array.isArray(sources) ? sources : [];
}

export function startGitHubSkillSyncScheduler(params: {
  getConfig: () => MaybePromise<SkillSyncConfig | undefined>;
  runner: GitHubSkillSyncRunner;
}): GitHubSkillSyncScheduler {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const getConfig = async (): Promise<SkillSyncConfig | undefined> => {
    try {
      return await params.getConfig();
    } catch (error) {
      logger.error('[GitHubSkillSync] Failed to load scheduler config:', error);
      return undefined;
    }
  };

  const scheduleNext = (config: SkillSyncConfig | undefined) => {
    if (stopped) {
      return;
    }
    const delayMs = normalizeIntervalMinutes(config?.github?.intervalMinutes) * 60 * 1000;
    timer = setTimeout(tick, delayMs);
    timer.unref?.();
  };

  const runIfEnabled = async () => {
    const config = await getConfig();
    const github = config?.github;
    if (!github?.enabled || getSources(config).length === 0) {
      return config;
    }
    try {
      await params.runner.runOnce();
    } catch (error) {
      logger.error('[GitHubSkillSync] Scheduled run failed:', error);
    }
    return getConfig();
  };

  async function tick() {
    if (stopped) {
      return;
    }
    const config = await runIfEnabled();
    scheduleNext(config);
  }

  const scheduler = {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };

  void (async () => {
    const config = await getConfig();
    if (config?.github?.enabled && config.github.runOnStartup && getSources(config).length > 0) {
      void params.runner.runOnce().catch((error) => {
        logger.error('[GitHubSkillSync] Scheduled startup run failed:', error);
      });
    }
    scheduleNext(config);
  })();

  registerShutdownTask('github skill sync scheduler', () => {
    scheduler.stop();
  });

  return scheduler;
}
