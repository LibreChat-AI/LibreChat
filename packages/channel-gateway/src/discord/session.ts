import type { DiscordChannelConfig, DiscordGatewayBootstrap } from 'librechat-data-provider';
import type {
  DiscordGatewayDependencies,
  DiscordGatewayEvent,
  DiscordGatewayOwner,
} from './gateway';
import type { DiscordGatewayControlClient } from './ownership';
import type { Logger } from '../types';
import { OwnedDiscordGateway } from './gateway';

/** The caller holds the application lease until this session and every dispatch have drained. */
export async function runDiscordSession(
  deps: {
    owner: DiscordGatewayOwner;
    policy: DiscordChannelConfig;
    ownership: DiscordGatewayControlClient;
    dispatch(
      application: DiscordGatewayBootstrap,
      event: DiscordGatewayEvent,
      signal: AbortSignal,
    ): Promise<void>;
    createDriver?: DiscordGatewayDependencies['createDriver'];
    log: Logger;
  },
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const application = await deps.ownership.bootstrap(deps.owner, signal);
  signal.throwIfAborted();
  if (!application) throw new Error('Discord application ownership unavailable');
  const dispatches = new Set<Promise<void>>();
  const gateway = new OwnedDiscordGateway(
    {
      applicationId: application.applicationId,
      applicationRevision: application.applicationRevision,
      botUserId: application.botUserId,
      botToken: application.botToken,
    },
    {
      ownerId: deps.owner.ownerId,
      log: deps.log,
      createDriver: deps.createDriver,
      ownership: {
        // Renew the existing lease; a late startup must never reacquire a released owner.
        acquire: (owner, leaseMs) => deps.ownership.renew(owner, leaseMs, signal),
        renew: (owner, leaseMs) => deps.ownership.renew(owner, leaseMs, signal),
        // The outer application owns release, after REST workers and dispatches have drained.
        release: async () => {},
      },
      checkpoints: {
        load: (owner) => deps.ownership.load(owner, signal),
        save: (owner, batch, checkpointSignal) =>
          deps.ownership.save(owner, batch, AbortSignal.any([signal, checkpointSignal])),
      },
      dispatch: async (event, dispatchSignal) => {
        const combined = AbortSignal.any([signal, dispatchSignal]);
        combined.throwIfAborted();
        const work = deps.dispatch(application, event, combined);
        dispatches.add(work);
        try {
          await work;
        } finally {
          dispatches.delete(work);
        }
      },
    },
    { ...deps.policy, gateway: application.policy },
  );
  try {
    if (await gateway.start(signal)) await gateway.closed;
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    await gateway.stop();
    await Promise.allSettled([...dispatches]);
  }
}
