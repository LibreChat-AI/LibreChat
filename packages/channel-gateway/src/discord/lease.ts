import { discordChannelConfigSchema } from 'librechat-data-provider';
import type { DiscordGatewayOwner } from './gateway';
import type { Logger } from '../types';

export interface DiscordApplicationOwnership {
  acquire(owner: DiscordGatewayOwner, leaseMs: number, signal: AbortSignal): Promise<boolean>;
  renew(owner: DiscordGatewayOwner, leaseMs: number, signal: AbortSignal): Promise<boolean>;
  release(owner: DiscordGatewayOwner): Promise<boolean>;
}

/** One application owner shares bot rate limits across replies, channel workers and Gateway shards.
 * The service must grant the exact requested duration or reject the acquisition/renewal. */
export async function withDiscordApplicationLease(
  deps: {
    owner: DiscordGatewayOwner;
    leaseMs: number;
    ownership: DiscordApplicationOwnership;
    log: Logger;
  },
  work: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<boolean> {
  const leaseMs = discordChannelConfigSchema.parse({
    gateway: { ownershipLeaseMs: deps.leaseMs },
  }).gateway.ownershipLeaseMs;
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  let owned = false;
  let expiresAt = 0;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let renewals: Promise<void> | undefined;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => controller.abort();
  function grant(startedAt: number): void {
    expiresAt = startedAt + leaseMs;
    clearTimeout(expiry);
    if (Date.now() >= expiresAt) {
      stop();
      return;
    }
    expiry = setTimeout(stop, expiresAt - Date.now());
  }
  function scheduleRenewal(): void {
    if (controller.signal.aborted) return;
    renewalTimer = setTimeout(
      () => {
        renewals = renew().catch(() => {
          if (!controller.signal.aborted) deps.log.warn('discord_application_renewal_unavailable');
          stop();
        });
      },
      Math.floor(leaseMs / 3),
    );
  }
  async function renew(): Promise<void> {
    if (controller.signal.aborted) return;
    const startedAt = Date.now();
    if (startedAt >= expiresAt) return stop();
    const held = await deps.ownership.renew(deps.owner, leaseMs, controller.signal);
    if (controller.signal.aborted) return;
    if (!held) {
      deps.log.warn('discord_application_ownership_lost');
      return stop();
    }
    grant(startedAt);
    scheduleRenewal();
  }
  try {
    const startedAt = Date.now();
    owned = await deps.ownership.acquire(deps.owner, leaseMs, controller.signal);
    if (!owned) return false;
    grant(startedAt);
    if (controller.signal.aborted) return false;
    scheduleRenewal();
    await work(controller.signal);
    return true;
  } finally {
    stop();
    clearTimeout(expiry);
    clearTimeout(renewalTimer);
    signal.removeEventListener('abort', abort);
    await renewals;
    if (owned) {
      try {
        await deps.ownership.release(deps.owner);
      } catch {
        deps.log.warn('discord_application_release_unavailable');
      }
    }
  }
}
