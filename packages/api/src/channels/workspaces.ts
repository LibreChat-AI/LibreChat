import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { getTenantId, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import { SLACK_CHANNEL_BOT_SCOPES, configureSlackAppSchema } from 'librechat-data-provider';
import type {
  ChannelConfig,
  SlackWorkspace,
  SlackWorkspaceConnect,
  ConfigureSlackApp,
  SlackAppRegistration,
} from 'librechat-data-provider';
import type {
  SlackWorkspaceStorage,
  SlackInstallRecord,
  SlackClaimedInstall,
} from '@librechat/data-schemas';

export const SLACK_WORKSPACE_CALLBACK_PATH = '/api/channels/workspaces/oauth/callback';

export interface SlackWorkspacePrincipal {
  id: string;
  tenantId?: string;
}

export interface SlackWorkspaceApp {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  redirectUri: string;
  flowLifetimeMs: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
}

export type SlackWorkspaceFetch = (url: string, init: RequestInit) => Promise<Response>;

export type SlackWorkspaceError =
  | 'not_configured'
  | 'forbidden'
  | 'invalid_install'
  | 'stale_install'
  | 'workspace_in_use'
  | 'workspace_changed'
  | 'slack_refused'
  | 'unsupported_installation'
  | 'missing_scopes';

type Result<T> = { ok: true; value: T } | { ok: false; error: { code: SlackWorkspaceError } };
const failure = (
  code: SlackWorkspaceError,
): { ok: false; error: { code: SlackWorkspaceError } } => ({ ok: false, error: { code } });
const stateHash = (state: string) => createHash('sha256').update(state).digest('hex');
const statePattern = /^[A-Za-z0-9_-]{43}$/;

export function slackPublicURL(value: string): URL {
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Slack installation requires trusted public URLs');
  return url;
}

const grantSchema = z.object({
  ok: z.literal(true),
  app_id: z.string().regex(/^A[A-Z0-9]+$/),
  token_type: z.literal('bot'),
  access_token: z.string().startsWith('xoxb-').min(6).max(512),
  bot_user_id: z.string().regex(/^U[A-Z0-9]+$/),
  team: z
    .object({ id: z.string().regex(/^T[A-Z0-9]+$/), name: z.string().min(1).max(256) })
    .nullable(),
  scope: z.string().max(8192),
  is_enterprise_install: z.boolean().optional(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
});

/** Operator policy enables the service; application credentials belong to the current organization. */
export function resolveSlackWorkspaceApp(
  config: ChannelConfig,
  redirectUri: string,
  credentials?: Pick<SlackWorkspaceApp, 'appId' | 'clientId' | 'clientSecret' | 'signingSecret'>,
): SlackWorkspaceApp | undefined {
  const app = config.slackApp;
  if (!config.enabled || !app?.enabled || !credentials) return undefined;
  if (
    config.transport !== 'webhook' ||
    !/^A[A-Z0-9]+$/.test(credentials.appId) ||
    !credentials.clientId.trim() ||
    !credentials.clientSecret.trim() ||
    !credentials.signingSecret.trim()
  )
    throw new Error(
      'Shared Slack workspaces require webhook transport and organization app credentials',
    );
  slackPublicURL(redirectUri);
  return {
    ...app,
    ...credentials,
    redirectUri,
  };
}

export async function readSlackJSON(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Slack returned an empty OAuth response');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('Slack OAuth response exceeded its limit');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** OAuth installs a workspace for an org; it never grants the installer's execution identity. */
export function createSlackWorkspaceService(deps: {
  storage: SlackWorkspaceStorage;
  config: (appId?: string) => Promise<SlackWorkspaceApp | undefined>;
  canManage: (principal: SlackWorkspacePrincipal) => Promise<boolean>;
  encrypt: (token: string) => Promise<string>;
  fetch: SlackWorkspaceFetch;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;

  function inScope(principal: SlackWorkspacePrincipal): boolean {
    const tenant = getTenantId();
    return (
      Boolean(principal.id) &&
      tenant !== SYSTEM_TENANT_ID &&
      (tenant || undefined) === (principal.tenantId || undefined)
    );
  }

  return {
    async configureApp(
      principal: SlackWorkspacePrincipal,
      input: ConfigureSlackApp,
    ): Promise<Result<SlackAppRegistration>> {
      if (!inScope(principal) || !(await deps.canManage(principal))) return failure('forbidden');
      const parsed = configureSlackAppSchema.safeParse(input);
      if (!parsed.success) return failure('invalid_install');
      const configuration = parsed.data;
      const [encryptedClientSecret, encryptedSigningSecret] = await Promise.all([
        configuration.clientSecret ? deps.encrypt(configuration.clientSecret) : undefined,
        configuration.signingSecret ? deps.encrypt(configuration.signingSecret) : undefined,
      ]);
      const saved = await deps.storage.configureApp(
        {
          appId: configuration.appId,
          clientId: configuration.clientId,
          ...(configuration.name !== undefined ? { name: configuration.name } : {}),
          ...(encryptedClientSecret ? { encryptedClientSecret } : {}),
          ...(encryptedSigningSecret ? { encryptedSigningSecret } : {}),
        },
        principal.id,
        configuration.expectedRevision,
      );
      return saved ? { ok: true, value: saved } : failure('stale_install');
    },
    async removeApp(
      principal: SlackWorkspacePrincipal,
      appId: string,
      revision: string,
    ): Promise<Result<boolean>> {
      if (!inScope(principal) || !(await deps.canManage(principal))) return failure('forbidden');
      const result = await deps.storage.removeApp(appId, revision);
      if (result === 'workspace_in_use') return failure('workspace_in_use');
      return result === 'removed' ? { ok: true, value: true } : failure('stale_install');
    },
    async start(
      principal: SlackWorkspacePrincipal,
      workspaceId?: string,
      appId?: string,
    ): Promise<Result<SlackWorkspaceConnect>> {
      if (!inScope(principal) || !(await deps.canManage(principal))) return failure('forbidden');
      const current = workspaceId ? await deps.storage.read(workspaceId) : null;
      const app = await deps.config(current?.appId ?? appId);
      if (!app) return failure('not_configured');
      if (workspaceId && (!current || current.appId !== app.appId))
        return failure('workspace_changed');
      if (await deps.storage.appInUse(app.appId, current?.workspaceId))
        return failure('workspace_in_use');
      const state = randomBytes(32).toString('base64url');
      const flowId = stateHash(state);
      await deps.storage.startInstall({
        stateHash: flowId,
        userId: principal.id,
        appId: app.appId,
        clientId: app.clientId,
        expiresAt: new Date(now() + app.flowLifetimeMs),
        ...(current
          ? { workspaceId: current.workspaceId, workspaceRevision: current.revision }
          : {}),
      });
      const url = new URL('https://slack.com/oauth/v2/authorize');
      url.searchParams.set('client_id', app.clientId);
      url.searchParams.set('redirect_uri', app.redirectUri);
      url.searchParams.set('scope', SLACK_CHANNEL_BOT_SCOPES.join(','));
      url.searchParams.set('state', state);
      if (current) url.searchParams.set('team', current.teamId);
      return {
        ok: true,
        value: {
          url: url.toString(),
          flowId,
          expiresInSeconds: Math.ceil(app.flowLifetimeMs / 1000),
        },
      };
    },

    async flow(state: string): Promise<SlackInstallRecord | null> {
      if (!statePattern.test(state)) return null;
      const flow = await deps.storage.findInstall(stateHash(state));
      return flow && flow.expiresAt.getTime() > now() ? flow : null;
    },

    async cancel(principal: SlackWorkspacePrincipal, flowId: string): Promise<Result<boolean>> {
      if (!inScope(principal)) return failure('forbidden');
      await deps.storage.cancelInstall(flowId, principal.id);
      return { ok: true, value: true };
    },

    async claim(flow: SlackInstallRecord): Promise<SlackClaimedInstall | null> {
      if (!inScope({ id: flow.userId, tenantId: flow.tenantId })) return null;
      return deps.storage.claimInstall(flow.stateHash, flow.userId, new Date(now()));
    },

    async retire(flow: SlackClaimedInstall): Promise<void> {
      if (!inScope({ id: flow.userId, tenantId: flow.tenantId }))
        throw new Error('Slack callback tenant changed');
      await deps.storage.retireInstall(flow.stateHash, flow.callbackId);
    },

    async finish(flow: SlackClaimedInstall, code: string): Promise<Result<SlackWorkspace>> {
      const principal = { id: flow.userId, tenantId: flow.tenantId };
      if (!inScope(principal) || !(await deps.canManage(principal))) return failure('forbidden');
      const app = await deps.config(flow.appId);
      if (!app) return failure('not_configured');
      if (
        flow.appId !== app.appId ||
        flow.clientId !== app.clientId ||
        flow.expiresAt.getTime() <= now()
      )
        return failure('invalid_install');
      if (!code || code.length > 2048) return failure('invalid_install');
      const response = await deps.fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: app.clientId,
          client_secret: app.clientSecret,
          redirect_uri: app.redirectUri,
          code,
        }),
        signal: AbortSignal.timeout(app.requestTimeoutMs),
      });
      if (!response.ok) throw new Error('Slack OAuth service unavailable');
      const grant = grantSchema.safeParse(await readSlackJSON(response, app.maxResponseBytes));
      if (!grant.success || grant.data.app_id !== app.appId) return failure('slack_refused');
      if (
        grant.data.is_enterprise_install ||
        !grant.data.team ||
        grant.data.expires_in != null ||
        grant.data.refresh_token
      )
        return failure('unsupported_installation');
      const scopes = [...new Set(grant.data.scope.split(',').map((scope) => scope.trim()))];
      if (!SLACK_CHANNEL_BOT_SCOPES.every((scope) => scopes.includes(scope)))
        return failure('missing_scopes');
      const configured = await deps.config(flow.appId);
      if (
        !configured ||
        configured.appId !== app.appId ||
        configured.clientId !== app.clientId ||
        configured.clientSecret !== app.clientSecret ||
        configured.redirectUri !== app.redirectUri
      )
        return failure('stale_install');
      if (!(await deps.canManage(principal))) return failure('forbidden');
      const installed = await deps.storage.completeInstall(
        flow.stateHash,
        flow.callbackId,
        {
          appId: app.appId,
          teamId: grant.data.team.id,
          teamName: grant.data.team.name,
          botUserId: grant.data.bot_user_id,
          scopes,
          encryptedBotToken: await deps.encrypt(grant.data.access_token),
        },
        new Date(now()),
      );
      return installed.ok ? { ok: true, value: installed.workspace } : failure(installed.code);
    },

    async remove(
      principal: SlackWorkspacePrincipal,
      workspaceId: string,
      expectedRevision: string,
    ): Promise<Result<boolean>> {
      if (!inScope(principal) || !(await deps.canManage(principal))) return failure('forbidden');
      return (await deps.storage.remove(workspaceId, expectedRevision))
        ? { ok: true, value: true }
        : failure('workspace_changed');
    },
    async disconnect(
      principal: SlackWorkspacePrincipal,
      workspaceId: string,
      expectedRevision: string,
    ): Promise<Result<boolean>> {
      if (!inScope(principal) || !(await deps.canManage(principal))) return failure('forbidden');
      return (await deps.storage.disconnect(workspaceId, expectedRevision))
        ? { ok: true, value: true }
        : failure('workspace_changed');
    },
  };
}

export type SlackWorkspaceService = ReturnType<typeof createSlackWorkspaceService>;
