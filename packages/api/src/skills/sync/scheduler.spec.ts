import type { SkillSyncConfig } from 'librechat-data-provider';
import type { GitHubSkillSyncRunner } from './github';
import { SKILL_SYNC_MAX_TIMER_INTERVAL_MINUTES, startGitHubSkillSyncScheduler } from './scheduler';
import { __resetShutdownStateForTests } from '~/app/shutdown';

const source = {
  id: 'librechat-skills',
  owner: 'LibreChat',
  repo: 'skills',
  ref: 'main',
  paths: ['skills'],
  credentialKey: 'github-skills-prod',
};

function config(intervalMinutes: number, enabled = true): SkillSyncConfig {
  return {
    github: {
      enabled,
      intervalMinutes,
      runOnStartup: false,
      sources: [source],
    },
  };
}

function runner(): GitHubSkillSyncRunner {
  return {
    getStatus: jest.fn(),
    runOnce: jest.fn(async () => ({ status: 'completed', sources: [] })),
  } as unknown as GitHubSkillSyncRunner;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('startGitHubSkillSyncScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    __resetShutdownStateForTests();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    __resetShutdownStateForTests();
  });

  it('clamps oversized intervals before scheduling a timer', async () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const scheduler = startGitHubSkillSyncScheduler({
      getConfig: () => config(Number.MAX_SAFE_INTEGER),
      runner: runner(),
    });

    await flushPromises();

    expect(setTimeoutSpy).toHaveBeenLastCalledWith(
      expect.any(Function),
      SKILL_SYNC_MAX_TIMER_INTERVAL_MINUTES * 60 * 1000,
    );
    scheduler.stop();
  });

  it('uses fresh config when scheduling the next run', async () => {
    let intervalMinutes = 5;
    const skillRunner = runner();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const scheduler = startGitHubSkillSyncScheduler({
      getConfig: () => config(intervalMinutes),
      runner: skillRunner,
    });
    await flushPromises();

    intervalMinutes = 10;
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    await flushPromises();

    expect(skillRunner.runOnce).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 10 * 60 * 1000);
    scheduler.stop();
  });
});
