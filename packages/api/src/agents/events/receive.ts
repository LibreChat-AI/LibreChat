import { createHash } from 'node:crypto';
import { logger, tenantStorage } from '@librechat/data-schemas';
import type { Connections } from '@librechat/data-schemas';
import type { Connection } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { EventsConfigSource, EventSettings, GitHubSettings } from './settings';
import type { App, AppConfig, Installation, Reply } from './github/app';
import type { Inbound, Lifecycle, Provider } from './provider';
import type { Route, RouteDeps, Routed } from './route';
import type { PullRequestFetch } from '~/pulls/shared';
import { getSafeErrorMetadata } from '~/utils/errors';
import { createAccessCheck } from './access';
import { github } from './github/provider';
import { eventSettings } from './settings';
import { createApp } from './github/app';
import { createRoute } from './route';

/**
 * Why a delivery was answered as it was. Every code is safe to send back: none echoes the
 * body, a header or an error's text.
 * - `not_found`: events are off, or no provider has that name. Answered as if the route did
 *   not exist.
 * - `too_large`: the body is longer than `maxBodyBytes`; it was not read further.
 * - `unconfigured`: events are on but the provider's app does not resolve, so nothing can be
 *   verified.
 * - `signature`: the signature is missing, does not read, or does not match.
 * - `malformed`: the body does not read as the event it claims to be.
 * - `ignored`: a verified delivery of an event, action or item nothing subscribes to.
 * - `unbound`: no connection holds the delivery's install; nothing is run for it.
 * - `suspended`: the connection holding the install is suspended.
 * - `installation`: the provider reported a change to the install itself; the connection now
 *   holds the install's state as the provider reports it at this moment.
 * - `routed`: matched against the connection's subscriptions.
 * - `unavailable`: the store, the queue or the provider failed; the provider marks the
 *   delivery failed, and a later redelivery is absorbed by the body's digest (or, for an
 *   install change, applies the install's state as it then is).
 */
export type ReceiveCode =
  | 'not_found'
  | 'too_large'
  | 'unconfigured'
  | 'signature'
  | 'malformed'
  | 'ignored'
  | 'unbound'
  | 'suspended'
  | 'installation'
  | 'routed'
  | 'unavailable';

export interface Received {
  status: number;
  body: {
    code: ReceiveCode;
    /** For `malformed`: the field path the provider's reader stopped at. */
    field?: string;
    /** For `ignored`: whether the event, the action or the item was not one listened for. */
    reason?: string;
    /** For `installation`: the install's state as the provider reports it now. */
    state?: InstallState;
    /** For `routed`. */
    enqueued?: number;
    duplicates?: number;
    skipped?: Routed['skipped'];
  };
}

export interface ReceiveDeps {
  connections: Pick<Connections, 'resolve' | 'mark' | 'remove'>;
  /** The enabled subscriptions on a connection that listen for an event type. */
  match: RouteDeps['match'];
  /** The trigger service's in-process enqueue. */
  enqueue: RouteDeps['enqueue'];
  /** The HTTP client GitHub is asked through. */
  fetch: PullRequestFetch;
  now?: () => number;
}

/** The providers a delivery may name, by the path segment it is posted to. */
const PROVIDERS: Readonly<Record<string, Provider>> = { github };

/** What a connection was set to after the provider reported a change to its install. */
export type InstallState = 'active' | 'suspended' | 'removed';

const reply = (status: number, body: Received['body']): Received => ({ status, body });

/** A delivery's install, for a provider whose app every tenant shares. */
function installationOf(occurrences: readonly { installation?: number }[]): string | null {
  const ids = new Set(occurrences.map((occurrence) => occurrence.installation));
  if (ids.size !== 1) return null;
  const [id] = ids;
  return id == null ? null : String(id);
}

/** The install's state from the provider's answer; only a `missing` refusal reaches here. */
function stateOf(answer: Reply<Installation>): InstallState {
  if (!answer.ok) return 'removed';
  return answer.value.suspended ? 'suspended' : 'active';
}

/** Runs a connection write inside the tenant that holds it; connection writes are scoped. */
function within<T>(connection: Connection, fn: () => Promise<T>): Promise<T> {
  return connection.tenantId == null
    ? fn()
    : tenantStorage.run({ tenantId: connection.tenantId }, fn);
}

/**
 * Receives one delivery a provider signed and posted. Nothing the body names is looked up until
 * its signature passes: the order is verify, then read, then resolve the connection, then
 * route. The answer never carries the body, a header or an error's text.
 */
export function createReceive(deps: ReceiveDeps) {
  /**
   * One app client and router per app configuration, so the app's tokens and access answers
   * are reused across deliveries.
   */
  let held: { key: string; app: App; route: Route } | null = null;
  function heldFor(settings: GitHubSettings): { app: App; route: Route } {
    const config: AppConfig = settings.app;
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          config.id,
          config.host,
          config.timeoutMs,
          config.key,
          settings.accessTtlMs,
        ]),
      )
      .digest('hex');
    if (held?.key !== key) {
      const app = createApp(config, { fetch: deps.fetch, ...(deps.now && { now: deps.now }) });
      const access = createAccessCheck(app, {
        ttlMs: settings.accessTtlMs,
        ...(deps.now && { now: deps.now }),
      });
      held = {
        key,
        app,
        route: createRoute({
          match: deps.match,
          enqueue: deps.enqueue,
          access,
          ...(deps.now && { now: deps.now }),
        }),
      };
    }
    return held;
  }

  /**
   * Brings the connection holding an install in line with the install as the provider reports
   * it now. The delivery's action is not applied: deliveries can arrive late or twice, so
   * applying the install's current state gives the same outcome whatever order they come in.
   * The provider having no such install removes the connection; any other refusal, or an
   * outage, is thrown so the delivery is answered as failed and can be redelivered. Nothing is
   * cached.
   */
  async function reconcile(
    lifecycle: Lifecycle,
    provider: Provider['name'],
    app: App,
  ): Promise<Received> {
    const connection = await deps.connections.resolve({
      provider,
      installation: lifecycle.installation,
    });
    if (connection == null) {
      return reply(202, { code: 'unbound' });
    }
    const answer = await app.installation(Number(lifecycle.installation));
    if (!answer.ok && answer.error.code !== 'missing') {
      throw new Error(`The installation lookup was refused: ${answer.error.code}`);
    }
    const state = stateOf(answer);
    if (state === 'removed') {
      await within(connection, () => deps.connections.remove(connection.id));
    } else if (connection.status !== state) {
      await within(connection, () => deps.connections.mark(connection.id, state));
    }
    logger.info(`[events] ${provider} install of ${connection.id} is now ${state}`);
    return reply(200, { code: 'installation', state });
  }

  return async function receive(
    settings: EventSettings | null,
    name: string,
    inbound: Inbound,
  ): Promise<Received> {
    const provider = Object.prototype.hasOwnProperty.call(PROVIDERS, name)
      ? PROVIDERS[name]
      : undefined;
    if (settings == null || provider == null) {
      return reply(404, { code: 'not_found' });
    }
    if (inbound.body.byteLength > settings.maxBodyBytes) {
      return reply(413, { code: 'too_large' });
    }
    if (settings.github == null) {
      logger.warn('[events] a delivery arrived but the GitHub App settings do not resolve');
      return reply(503, { code: 'unconfigured' });
    }
    const verdict = provider.verify(inbound, settings.github.secret);
    if (!verdict.ok) {
      return reply(401, { code: 'signature' });
    }
    const verified = verdict.value;
    /** Ids only: the provider's name and the delivery's GUID, which verify kept only if plain. */
    const label = `${provider.name} delivery ${verified.delivery ?? '(no id)'}`;
    try {
      const lifecycle = provider.lifecycle(verified);
      if (lifecycle != null) {
        return await reconcile(lifecycle, provider.name, heldFor(settings.github).app);
      }
      const outcome = provider.parse(verified, settings.limits);
      if (!outcome.ok) {
        if (outcome.error.code === 'ignored') {
          return reply(202, { code: 'ignored', reason: outcome.error.reason });
        }
        return reply(400, { code: 'malformed', field: outcome.error.field });
      }
      const installation = installationOf(outcome.value);
      const connection =
        installation == null
          ? null
          : await deps.connections.resolve({ provider: provider.name, installation });
      if (connection == null) {
        logger.info(`[events] ${label} names no bound install`);
        return reply(202, { code: 'unbound' });
      }
      if (connection.status !== 'active') {
        logger.info(`[events] ${label} dropped: ${connection.id} is suspended`);
        return reply(202, { code: 'suspended' });
      }
      const routed = await heldFor(settings.github).route({
        verified,
        occurrences: outcome.value,
        connection,
      });
      return reply(202, { code: 'routed', ...routed });
    } catch (error) {
      logger.error(`[events] ${label} could not be received`, getSafeErrorMetadata(error));
      return reply(503, { code: 'unavailable' });
    }
  };
}

export type Receive = ReturnType<typeof createReceive>;

/**
 * Reads a request body up to `max` bytes. `null` when the declared or actual length is longer,
 * in which case the rest is not read.
 */
function collect(
  req: NodeJS.ReadableStream & { headers?: Record<string, unknown> },
  max: number,
): Promise<Uint8Array | null> {
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > max) {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      cleanup();
      fn();
    };
    function onData(chunk: Buffer | string) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += bytes.length;
      if (size > max) {
        req.pause();
        settle(() => resolve(null));
        return;
      }
      chunks.push(bytes);
    }
    function onEnd() {
      settle(() => resolve(Buffer.concat(chunks)));
    }
    function onError(error: Error) {
      settle(() => reject(error));
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

export interface IngressDeps extends ReceiveDeps {
  /**
   * The deployment's config. Called with `baseOnly`, since `endpoints.agents.events` is read
   * from librechat.yaml only and a delivery carries no user or tenant to resolve it for.
   */
  getAppConfig: (options: { baseOnly: true }) => Promise<EventsConfigSource | null | undefined>;
  /** Where the config's environment variable references are resolved. */
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * The HTTP side of `receive`, for `POST /api/agents/events/in/:provider`. It must be mounted
 * before any body parser, since the signature is checked over the body's raw bytes.
 */
export function createIngressHandler(deps: IngressDeps) {
  const receive = createReceive(deps);
  return async (req: Request, res: Response): Promise<void> => {
    let result: Received;
    try {
      const config = await deps.getAppConfig({ baseOnly: true });
      const settings = eventSettings(config?.endpoints?.agents?.events, deps.env);
      const name = String(req.params.provider ?? '');
      if (settings == null || !Object.prototype.hasOwnProperty.call(PROVIDERS, name)) {
        result = reply(404, { code: 'not_found' });
      } else {
        const body = await collect(req, settings.maxBodyBytes);
        if (body == null) {
          res.set('Connection', 'close');
          res.once('finish', () => req.destroy());
          result = reply(413, { code: 'too_large' });
        } else {
          result = await receive(settings, name, { body, headers: req.headers });
        }
      }
    } catch (error) {
      logger.error('[events] a delivery could not be read', getSafeErrorMetadata(error));
      result = reply(503, { code: 'unavailable' });
    }
    res.status(result.status).json(result.body);
  };
}
