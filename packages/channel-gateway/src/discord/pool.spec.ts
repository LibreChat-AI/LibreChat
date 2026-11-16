import { discordChannelConfigSchema } from 'librechat-data-provider';
import { DiscordGatewayFailure } from './recovery';
import { runDiscordApplications } from './pool';

const first = { applicationId: '123456789012345678', applicationRevision: 'revision' };
const second = { applicationId: '123456789012345679', applicationRevision: 'revision' };
const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const policy = { maxApplications: 1, pollIntervalMs: 100 };
const untilAbort = (signal: AbortSignal) =>
  signal.aborted
    ? Promise.resolve()
    : new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
let controller: AbortController;
beforeEach(() => {
  controller = new AbortController();
});
afterEach(() => controller.abort());

it('keeps bounded residents, drains on shutdown, and does not repeat an unchanged application', async () => {
  let scans = 0;
  const start = jest.fn(async (_owner, signal: AbortSignal) => untilAbort(signal));
  await runDiscordApplications(
    {
      policy,
      log,
      start,
      discover: async () => {
        if (++scans === 3) controller.abort();
        return { applications: [first, second] };
      },
    },
    controller.signal,
  );
  expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0][1].aborted).toBe(true);
  expect(log.warn).toHaveBeenCalledWith('discord_application_capacity_exhausted');
});

it('rotates a full scan so a busy first candidate cannot starve another application', async () => {
  const owners: string[] = [];
  await runDiscordApplications(
    {
      policy,
      log,
      discover: async () => ({ applications: [first, second] }),
      start: async (owner) => {
        owners.push(owner.applicationId);
        if (owner.applicationId === second.applicationId) controller.abort();
      },
    },
    controller.signal,
  );
  expect(owners).toEqual([first.applicationId, second.applicationId]);
});

it('continues past an empty filtered page and strips tenant metadata from ownership', async () => {
  const cursors: (string | undefined)[] = [];
  const start = jest.fn(async () => controller.abort());
  await runDiscordApplications(
    {
      policy,
      log,
      start,
      discover: async (cursor) => {
        cursors.push(cursor);
        return cursor
          ? { applications: [{ ...first, tenantId: 'canonical-tenant' }] }
          : { applications: [], next: 'cursor' };
      },
    },
    controller.signal,
  );
  expect(cursors).toEqual([undefined, 'cursor']);
  expect(start).toHaveBeenCalledWith(
    { ...first, ownerId: expect.stringMatching(/^[a-f0-9]{32}$/) },
    expect.any(AbortSignal),
  );
});

it('drains the previous credential revision before starting its replacement', async () => {
  const events: string[] = [];
  let scans = 0;
  await runDiscordApplications(
    {
      policy,
      log,
      discover: async () => ({
        applications: [{ ...first, applicationRevision: ++scans === 1 ? 'old' : 'new' }],
      }),
      start: async (owner, signal) => {
        events.push(`start:${owner.applicationRevision}`);
        if (owner.applicationRevision === 'new') controller.abort();
        await untilAbort(signal);
        events.push(`stop:${owner.applicationRevision}`);
      },
    },
    controller.signal,
  );
  expect(events).toEqual(['start:old', 'stop:old', 'start:new', 'stop:new']);
});

it('retries a discovery failure without retaining raw errors or abandoning residents', async () => {
  let scans = 0;
  await runDiscordApplications(
    {
      policy,
      log,
      start: async () => controller.abort(),
      discover: async () => {
        if (++scans === 1) throw new Error('private credential');
        return { applications: [first] };
      },
    },
    controller.signal,
  );
  expect(scans).toBe(2);
  expect(log.warn).toHaveBeenCalledWith('discord_application_discovery_unavailable');
  expect(JSON.stringify(log.warn.mock.calls)).not.toContain('private credential');
});

const recoveryPolicy = (
  overrides: Partial<
    ReturnType<typeof discordChannelConfigSchema.parse>['gateway']['recovery']
  > = {},
) => ({
  ...policy,
  recovery: discordChannelConfigSchema.parse({
    gateway: {
      recovery: {
        fatalRetryMinMs: 1000,
        fatalRetryMaxMs: 4000,
        resetAfterMs: 1000,
        retryMaxMs: 1000,
        ...overrides,
      },
    },
  }).gateway.recovery,
});

it('quarantines fatal sessions with exponential delay capped independently of discovery polling', async () => {
  let clock = 0;
  const starts: number[] = [];
  await runDiscordApplications(
    {
      policy: recoveryPolicy(),
      log,
      now: () => clock,
      discover: async () => {
        clock += 500;
        if (clock > 12500) controller.abort();
        return { applications: [first] };
      },
      start: async () => {
        starts.push(clock);
        throw new DiscordGatewayFailure('configuration');
      },
    },
    controller.signal,
  );
  expect(starts).toEqual([500, 1500, 3500, 7500, 11500]);
  expect(log.warn).toHaveBeenCalledWith('discord_application_quarantined');
});

it('immediately retries a new credential revision while other quarantines stay isolated', async () => {
  let scans = 0;
  let clock = 0;
  const starts: string[] = [];
  await runDiscordApplications(
    {
      policy: { ...recoveryPolicy(), maxApplications: 2 },
      log,
      now: () => clock,
      discover: async () => {
        clock += 100;
        scans++;
        if (scans === 4) controller.abort();
        return {
          applications: [
            { ...first, applicationRevision: scans >= 2 ? 'rotated' : 'revision' },
            second,
          ],
        };
      },
      start: async (owner) => {
        starts.push(owner.applicationId + ':' + owner.applicationRevision);
        throw new DiscordGatewayFailure('credentials');
      },
    },
    controller.signal,
  );
  expect(starts.filter((id) => id.startsWith(first.applicationId))).toEqual([
    first.applicationId + ':revision',
    first.applicationId + ':rotated',
  ]);
  expect(starts.filter((id) => id.startsWith(second.applicationId))).toHaveLength(1);
});

it('backs off transient failures with bounded jitter and resets after a verified healthy session', async () => {
  let clock = 0;
  const starts: number[] = [];
  await runDiscordApplications(
    {
      policy: recoveryPolicy(),
      log,
      now: () => clock,
      random: () => 1,
      discover: async () => {
        clock += 100;
        if (clock > 1000) controller.abort();
        return { applications: [first] };
      },
      start: async () => {
        starts.push(clock);
        throw new DiscordGatewayFailure('dispatch', starts.length === 3 ? 1000 : 0);
      },
    },
    controller.signal,
  );
  expect(starts).toEqual([100, 200, 400, 500, 700]);
});

it('bounds tracked failures and releases absent applications only after a complete discovery scan', async () => {
  let scans = 0;
  const starts: string[] = [];
  await runDiscordApplications(
    {
      policy: recoveryPolicy({ maxTrackedApplications: 1 }),
      log,
      now: () => 0,
      discover: async () => {
        scans++;
        if (scans === 2) throw new Error('private discovery diagnostic');
        if (scans > 5) controller.abort();
        return { applications: scans <= 3 ? [first, second] : [second] };
      },
      start: async (owner) => {
        starts.push(owner.applicationId);
        throw new DiscordGatewayFailure('configuration');
      },
    },
    controller.signal,
  );
  expect(starts).toEqual([first.applicationId, second.applicationId]);
});
