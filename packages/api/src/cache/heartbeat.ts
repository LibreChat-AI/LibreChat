import { logger } from '@librechat/data-schemas';

/** The slice of an ioredis `Redis` or `Cluster` client the heartbeat needs. */
export interface HeartbeatClient {
  readonly status: string;
  readonly options?: object;
  ping(): Promise<unknown>;
  on(event: 'end', listener: () => void): unknown;
  off(event: 'end', listener: () => void): unknown;
  disconnect(reconnect?: boolean): void;
  /** Present on a standalone client and on every cluster node; a cluster itself owns no socket. */
  stream?: { readonly destroyed: boolean; destroy(error?: Error): unknown };
  /** A cluster exposes its node connections, each with a socket of its own to probe. */
  nodes?(role: 'all'): HeartbeatClient[];
}

export interface RedisHeartbeatOptions {
  client: HeartbeatClient;
  /** Milliseconds between probes; a non-positive value disables the heartbeat. */
  intervalMs: number;
  /** Milliseconds a probe may go unanswered before the socket is presumed dead. */
  timeoutMs: number;
  /** Client label used in log lines. */
  label: string;
}

type ProbeOutcome = 'pong' | 'rejected' | 'expired';

function describeTarget(target: HeartbeatClient, label: string): string {
  const options = target.options;
  if (options != null && 'host' in options && 'port' in options) {
    return `${label} ${String(options.host)}:${String(options.port)}`;
  }
  return label;
}

/**
 * A cluster's sockets belong to its nodes, and a cluster-level PING is routed to one of
 * them, so a healthy reply there says nothing about the others. A standalone client is
 * its own single target.
 */
function probeTargets(client: HeartbeatClient): HeartbeatClient[] {
  return client.nodes != null ? client.nodes('all') : [client];
}

/**
 * Drops the current socket without waiting for the peer. `disconnect(true)` calls
 * `stream.end()`, whose FIN a vanished peer never acknowledges, so ioredis would not
 * observe `close` until the kernel retransmission timeout — the very wait a heartbeat
 * exists to avoid. Destroying the stream raises `close` immediately, after which ioredis
 * reconnects through its retry strategy, replays the commands it was holding, and
 * re-subscribes a subscriber's channels. A cluster node whose socket closes is dropped
 * from the pool and recreated on the next slot refresh, with its commands retried through
 * the cluster's redirection path. Anything without a socket falls back to the regular
 * reconnect.
 */
export function forceRedisReconnect(client: HeartbeatClient, reason: string): void {
  const stream = client.stream;
  if (stream != null && !stream.destroyed) {
    stream.destroy(new Error(reason));
    return;
  }
  client.disconnect(true);
}

/**
 * Probes each connection with deadline-bounded PINGs and tears a socket down when its
 * probe goes unanswered. A peer that disappears without a FIN or RST (a dropped NAT
 * entry, a proxy failover, a migrated VM) leaves the socket "connected" from ioredis's
 * point of view: no error fires, every command waits, and only the kernel's
 * retransmission or keepalive timeout — about fifteen minutes at Linux defaults — ends
 * the wait. Dedicated subscriber connections are the worst case, since nothing else
 * ever writes to them. A cluster is probed node by node for the same reason.
 *
 * Only a probe that neither resolves nor rejects within `timeoutMs` counts: a rejected
 * probe means ioredis already knows the connection state and is handling it. A target is
 * skipped while it is not ready or its previous probe is still waiting, and the heartbeat
 * ends with the client (`end` fires only once ioredis stops reconnecting).
 */
export function startRedisHeartbeat(options: RedisHeartbeatOptions): () => void {
  const { client, intervalMs, timeoutMs, label } = options;
  if (intervalMs <= 0) {
    return () => undefined;
  }
  if (timeoutMs <= 0) {
    logger.warn(
      `${label} heartbeat disabled: the probe deadline must be positive, got ${timeoutMs}ms`,
    );
    return () => undefined;
  }

  const inFlight = new Set<HeartbeatClient>();
  let stopped = false;

  const probe = async (target: HeartbeatClient): Promise<void> => {
    if (stopped || inFlight.has(target) || target.status !== 'ready') {
      return;
    }
    inFlight.add(target);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<ProbeOutcome>((resolve) => {
      deadline = setTimeout(() => resolve('expired'), timeoutMs);
      deadline.unref?.();
    });
    const answered = target.ping().then(
      (): ProbeOutcome => 'pong',
      (): ProbeOutcome => 'rejected',
    );
    try {
      const outcome = await Promise.race([answered, expired]);
      if (outcome !== 'expired' || stopped) {
        return;
      }
      const name = describeTarget(target, label);
      logger.warn(`${name} heartbeat: no PING reply within ${timeoutMs}ms, reconnecting`);
      forceRedisReconnect(target, `${name} heartbeat timed out after ${timeoutMs}ms`);
    } finally {
      clearTimeout(deadline);
      inFlight.delete(target);
    }
  };

  const timer = setInterval(() => {
    for (const target of probeTargets(client)) {
      void probe(target);
    }
  }, intervalMs);
  timer.unref?.();

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
    client.off('end', stop);
  };
  client.on('end', stop);
  return stop;
}
