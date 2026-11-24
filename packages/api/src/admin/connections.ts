import jwt from 'jsonwebtoken';
import { logger } from '@librechat/data-schemas';
import { createHash, randomUUID } from 'node:crypto';
import { ConnectionError, connectionStatuses } from 'librechat-data-provider';
import type {
  ConnectionErrorCode,
  ConnectionStatus,
  AdminConnections,
  ConnectionRemoved,
  ConnectionInstall,
  AdminConnection,
  Connection,
} from 'librechat-data-provider';
import type { Connections } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { App, AppConfig, Reply } from '~/agents/events/github/app';
import type { AdminAuditEvent, RecordAuditEntry } from './audit';
import type { EventConfig } from '~/agents/events/settings';
import type { PullRequestFetch } from '~/pulls/shared';
import type { ServerRequest } from '~/types/http';
import { createApp, GitHubError } from '~/agents/events/github/app';
import { eventSettings } from '~/agents/events/settings';
import { getSafeErrorMetadata } from '~/utils/errors';
import { createAdminAuditEmitter } from './audit';

type Env = Readonly<Record<string, string | undefined>>;

/** The part of the deployment's configuration this reads. */
export interface EventsConfigSource {
  endpoints?: { agents?: { events?: Partial<EventConfig> | null } | null } | null;
}

export interface AdminConnectionDeps {
  /** The caller's tenant's connections; the store never reads or writes another tenant's. */
  connections: Pick<Connections, 'bind' | 'get' | 'list' | 'mark' | 'remove'>;
  /** The deployment's configuration, read per request so a reload applies. */
  getAppConfig: () => Promise<EventsConfigSource | null | undefined>;
  /**
   * The process environment: the GitHub App's credentials by the names the config gives,
   * `JWT_SECRET` to sign install states, and `DOMAIN_SERVER` for the webhook URL.
   */
  env: Env;
  /** The deployment's HTTP client, so proxying is the caller's choice. */
  fetch: PullRequestFetch;
  /** Audit emission for every write; fail-open unless `auditFailClosed`. */
  recordAuditEntry?: RecordAuditEntry;
  auditFailClosed?: boolean;
  /** Unix time in milliseconds; the system clock when omitted. */
  now?: () => number;
}

/** Where GitHub posts the app's deliveries, below the deployment's public origin. */
export const INGRESS_PATH = '/api/agents/events/in/github';
/** Binds a state to installs of the events app, so no other signed token is accepted as one. */
const AUDIENCE = 'agent-events-install';
/** How long an install link stays good: enough to pick an account and approve the app. */
const STATE_LIFETIME_S = 600;
const STATE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const INSTALLATION = /^[1-9][0-9]{0,15}$/;
const CONNECTION = /^conn_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What an install state carries: who started the install, in which tenant. */
interface InstallState {
  sub: string;
  tenant: string | null;
  nonce: string;
}

type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

type Action =
  | 'event_connection.bound'
  | 'event_connection.suspended'
  | 'event_connection.resumed'
  | 'event_connection.removed';

function view(connection: Connection): AdminConnection {
  return {
    id: connection.id,
    provider: connection.provider,
    installation: connection.installation,
    account: { id: connection.account.id, name: connection.account.name },
    status: connection.status,
    createdBy: connection.createdBy,
  };
}

function refuse(
  res: Response,
  status: number,
  code: ConnectionErrorCode,
  error: string,
  retryAfterMs?: number,
): Response {
  if (retryAfterMs != null) {
    res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  }
  return res.status(status).json({ error, code });
}

function isStatus(value: unknown): value is ConnectionStatus {
  return (connectionStatuses as readonly unknown[]).includes(value);
}

/** The installation id GitHub sent the Setup URL, as a string or a number. */
function installationOf(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !INSTALLATION.test(text)) {
    return null;
  }
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}

/** A refusal GitHub gave, as the admin API words it. */
function refused(res: Response, reply: Extract<Reply<never>, { ok: false }>): Response {
  const { code, retryAfterMs } = reply.error;
  if (code === 'missing') {
    return refuse(res, 404, ConnectionError.installation, 'Installation not found for this app');
  }
  if (code === 'limited') {
    return refuse(
      res,
      503,
      ConnectionError.unavailable,
      'GitHub is limiting requests',
      retryAfterMs,
    );
  }
  if (code === 'code') {
    return refuse(res, 400, ConnectionError.code, 'Authorization code is not valid');
  }
  return refuse(res, 502, ConnectionError.refused, 'GitHub refused the app');
}

/**
 * Admin routes for the installs of the operator's GitHub App: start an install, bind the
 * install GitHub reports back to the caller's tenant, list, suspend or resume, and remove.
 *
 * Binding is a two-step flow. Starting an install signs a short-lived state for the calling
 * admin and tenant into the app's install and authorize links. GitHub returns the admin to the
 * app's Callback URL with an authorization `code`, and the Admin Panel posts the installation's
 * id, the code and the state here with the admin's own bearer token. Three proofs must hold:
 * the state names this admin and tenant, so a link someone else crafted binds nothing; the
 * code, redeemed for the admin's GitHub token, shows the admin can access the installation,
 * since the id alone could be anyone's installation of the app; and the app's own token shows
 * the installation is this app's.
 */
export function createAdminConnectionHandlers(deps: AdminConnectionDeps): {
  list: (req: ServerRequest, res: Response) => Promise<Response>;
  install: (req: ServerRequest, res: Response) => Promise<Response>;
  bind: (req: ServerRequest, res: Response) => Promise<Response>;
  mark: (req: ServerRequest, res: Response) => Promise<Response>;
  remove: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const { connections, env } = deps;
  const now = deps.now ?? Date.now;
  const emitIntent = createAdminAuditEmitter({
    recordAuditEntry: deps.recordAuditEntry,
    failClosed: deps.auditFailClosed,
    logPrefix: '[adminConnections]',
  });
  /** An outcome entry records what already happened, so an audit outage does not undo it. */
  const emitOutcome = createAdminAuditEmitter({
    recordAuditEntry: deps.recordAuditEntry,
    logPrefix: '[adminConnections]',
  });
  const secret = (): string | null => env.JWT_SECRET || null;
  const ingress = `${(env.DOMAIN_SERVER || 'http://localhost:3080').replace(/\/+$/, '')}${INGRESS_PATH}`;

  /** One client per app configuration, so its tokens are reused until the config changes. */
  let held: { key: string; app: App } | null = null;
  function appFor(config: AppConfig): App {
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          config.id,
          config.host,
          config.timeoutMs,
          config.key,
          config.client?.id ?? null,
          config.client?.secret ?? null,
        ]),
      )
      .digest('hex');
    if (held?.key !== key) {
      held = { key, app: createApp(config, { fetch: deps.fetch, now }) };
    }
    return held.app;
  }

  /**
   * The app, when an install can be bound: events on, the app's settings resolving, its OAuth
   * client configured, and a secret to sign states with. `null` otherwise.
   */
  async function settings(): Promise<{ app: AppConfig; key: string } | null> {
    const config = await deps.getAppConfig();
    const app = eventSettings(config?.endpoints?.agents?.events, env)?.github?.app;
    const key = secret();
    return app?.client != null && key != null ? { app, key } : null;
  }

  function verify(state: string, key: string, req: ServerRequest): boolean {
    if (!STATE.test(state) || state.length > 2048) {
      return false;
    }
    try {
      const claims = jwt.verify(state, key, {
        audience: AUDIENCE,
        algorithms: ['HS256'],
        clockTimestamp: Math.floor(now() / 1000),
      }) as Partial<InstallState>;
      return (
        claims.sub === req.user?.id &&
        (claims.tenant ?? null) === (req.user?.tenantId ?? null) &&
        typeof claims.nonce === 'string'
      );
    } catch {
      return false;
    }
  }

  /**
   * Records the intent, runs the write, records the outcome. With fail-closed auditing a write
   * never happens without its entry; `null` means the refusal for that was already sent.
   */
  async function audited<T>(
    req: ServerRequest,
    res: Response,
    entry: Omit<AdminAuditEvent, 'outcome'>,
    run: () => Promise<Result<T>>,
  ): Promise<Result<T> | null> {
    try {
      await emitIntent(req, { ...entry, outcome: 'pending' });
    } catch (error) {
      logger.error(
        `[adminConnections] ${entry.action} audit failed (fail-closed), nothing changed`,
        getSafeErrorMetadata(error),
      );
      refuse(res, 500, ConnectionError.audit, 'Failed to record audit entry');
      return null;
    }
    let result: Result<T>;
    try {
      result = await run();
    } catch (error) {
      await emitOutcome(req, { ...entry, outcome: 'failure' });
      throw error;
    }
    await emitOutcome(
      req,
      result.ok
        ? { ...entry, outcome: 'success' }
        : { ...entry, outcome: 'failure', metadata: { ...entry.metadata, reason: result.reason } },
    );
    return result;
  }

  /** Every handler's last word: an outage of GitHub is a 503, anything else a plain 500. */
  function guard(
    name: string,
    failed: string,
    handler: (req: ServerRequest, res: Response) => Promise<Response>,
  ) {
    return async (req: ServerRequest, res: Response): Promise<Response> => {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      try {
        return await handler(req, res);
      } catch (error) {
        if (error instanceof GitHubError) {
          logger.warn(`[adminConnections] ${name}: GitHub unavailable`, {
            code: error.code,
            status: error.status,
          });
          return refuse(res, 503, ConnectionError.unavailable, 'GitHub is not reachable');
        }
        logger.error(`[adminConnections] ${name} error:`, getSafeErrorMetadata(error));
        return res.status(500).json({ error: failed });
      }
    };
  }

  const list = guard('list', 'Failed to list connections', async (_req, res) => {
    const [found, ready] = await Promise.all([connections.list(), settings()]);
    const body: AdminConnections = {
      connections: found.map(view),
      ingress,
      configured: ready != null,
    };
    return res.status(200).json(body);
  });

  const install = guard('install', 'Failed to start an install', async (req, res) => {
    const ready = await settings();
    if (ready == null) {
      return refuse(res, 409, ConnectionError.unconfigured, 'Agent events are not configured');
    }
    const { app: config, key } = ready;
    const about = await appFor(config).about();
    if (!about.ok) {
      return refused(res, about);
    }
    const claims: InstallState = {
      sub: req.user!.id,
      tenant: req.user!.tenantId ?? null,
      nonce: randomUUID(),
    };
    // Dated by the same clock it is checked against.
    const state = jwt.sign({ ...claims, iat: Math.floor(now() / 1000) }, key, {
      audience: AUDIENCE,
      algorithm: 'HS256',
      expiresIn: STATE_LIFETIME_S,
    });
    const query = encodeURIComponent(state);
    const body: ConnectionInstall = {
      url: `${about.value.url}/installations/new?state=${query}`,
      authorize: `https://${config.host}/login/oauth/authorize?client_id=${encodeURIComponent(
        config.client!.id,
      )}&state=${query}`,
    };
    return res.status(200).json(body);
  });

  const bind = guard('bind', 'Failed to bind the installation', async (req, res) => {
    const {
      installation: raw,
      state,
      code,
    } = (req.body ?? {}) as {
      installation?: unknown;
      state?: unknown;
      code?: unknown;
    };
    const id = installationOf(raw);
    if (id == null || typeof state !== 'string' || typeof code !== 'string') {
      return refuse(res, 400, ConnectionError.invalid, 'Invalid installation, state or code');
    }
    const ready = await settings();
    if (ready == null) {
      return refuse(res, 409, ConnectionError.unconfigured, 'Agent events are not configured');
    }
    const { app: config, key } = ready;
    if (!verify(state, key, req)) {
      return refuse(res, 403, ConnectionError.state, 'Install state is not valid for this admin');
    }
    const app = appFor(config);
    // GitHub's proof that this admin can access the installation: the id alone could be
    // anyone's installation of the app.
    const owned = await app.owns(code, id);
    if (!owned.ok) {
      return refused(res, owned);
    }
    if (!owned.value) {
      return refuse(
        res,
        403,
        ConnectionError.inaccessible,
        'Installation is not accessible to this GitHub account',
      );
    }
    const reported = await app.installation(id);
    if (!reported.ok) {
      return refused(res, reported);
    }
    const { account, suspended } = reported.value;
    const done = await audited(
      req,
      res,
      {
        action: 'event_connection.bound',
        severity: 'warning',
        target: { type: 'event_connection', id: String(id), name: account.name },
        metadata: { provider: 'github', account: account.name },
      },
      async (): Promise<Result<Connection>> => {
        const bound = await connections.bind({
          provider: 'github',
          installation: String(id),
          account,
          createdBy: req.user!.id,
        });
        if (!bound.ok) {
          return { ok: false, reason: bound.error.code };
        }
        const status: ConnectionStatus = suspended ? 'suspended' : 'active';
        if (bound.value.status === status) {
          return bound;
        }
        // GitHub's own hold wins when the install is bound: the record follows what GitHub says.
        const marked = await connections.mark(bound.value.id, status);
        return marked == null ? { ok: false, reason: 'missing' } : { ok: true, value: marked };
      },
    );
    if (done == null) {
      return res;
    }
    if (!done.ok) {
      return done.reason === 'taken'
        ? refuse(res, 409, ConnectionError.taken, 'Installation is bound elsewhere')
        : refuse(res, 404, ConnectionError.missing, 'Connection not found');
    }
    return res.status(201).json(view(done.value));
  });

  /** The connection a path names, or `null` once its refusal is sent. */
  async function named(req: ServerRequest, res: Response): Promise<Connection | null> {
    const { id = '' } = req.params as { id?: string };
    if (!CONNECTION.test(id)) {
      refuse(res, 400, ConnectionError.invalid, 'Invalid connection id');
      return null;
    }
    const found = await connections.get(id);
    if (found == null) {
      refuse(res, 404, ConnectionError.missing, 'Connection not found');
    }
    return found;
  }

  function entry(action: Action, connection: Connection): Omit<AdminAuditEvent, 'outcome'> {
    return {
      action,
      severity: 'warning',
      target: {
        type: 'event_connection',
        id: connection.installation,
        name: connection.account.name,
      },
      metadata: { provider: connection.provider, connection: connection.id },
    };
  }

  const mark = guard('mark', 'Failed to update the connection', async (req, res) => {
    const { status } = (req.body ?? {}) as { status?: unknown };
    if (!isStatus(status)) {
      return refuse(res, 400, ConnectionError.invalid, 'Invalid status');
    }
    const connection = await named(req, res);
    if (connection == null) {
      return res;
    }
    if (connection.status === status) {
      return res.status(200).json(view(connection));
    }
    const action =
      status === 'suspended' ? 'event_connection.suspended' : 'event_connection.resumed';
    const done = await audited(
      req,
      res,
      entry(action, connection),
      async (): Promise<Result<Connection>> => {
        const marked = await connections.mark(connection.id, status);
        return marked == null ? { ok: false, reason: 'missing' } : { ok: true, value: marked };
      },
    );
    if (done == null) {
      return res;
    }
    return done.ok
      ? res.status(200).json(view(done.value))
      : refuse(res, 404, ConnectionError.missing, 'Connection not found');
  });

  const remove = guard('remove', 'Failed to remove the connection', async (req, res) => {
    const connection = await named(req, res);
    if (connection == null) {
      return res;
    }
    const done = await audited(
      req,
      res,
      entry('event_connection.removed', connection),
      async (): Promise<Result<true>> =>
        (await connections.remove(connection.id))
          ? { ok: true, value: true }
          : { ok: false, reason: 'missing' },
    );
    if (done == null) {
      return res;
    }
    if (!done.ok) {
      return refuse(res, 404, ConnectionError.missing, 'Connection not found');
    }
    const body: ConnectionRemoved = { id: connection.id, removed: true };
    return res.status(200).json(body);
  });

  return { list, install, bind, mark, remove };
}
