import { z } from 'zod';
import { PrincipalType, PrincipalModel } from 'librechat-data-provider';
import { logger, BASE_CONFIG_PRINCIPAL_ID } from '@librechat/data-schemas';
import type {
  TCustomConfig,
  TLangfuseConnectionStatus,
  TUpdateLangfuseConnectionRequest,
  TLangfuseConnectionTestErrorCode,
  TLangfuseConnectionTestRequest,
  TLangfuseConnectionTestResponse,
  TLangfuseSessionLinkResponse,
  TUpdateLangfusePromptSyncRequest,
  TLangfusePromptListResponse,
  TLangfusePromptGetResponse,
  TLangfusePromptErrorBody,
} from 'librechat-data-provider';
import type { AppConfig, IConfig, MessageMethods } from '@librechat/data-schemas';
import type { Types, ClientSession } from 'mongoose';
import type { Response } from 'express';
import type {
  LangfusePromptConnection,
  LangfuseTextPromptSelector,
  LangfusePromptRequestErrorCode,
} from '~/langfuse/prompts';
import type { LangfuseTenantDestination } from '~/langfuse/tenantDestinations';
import type { ServerRequest } from '~/types/http';
import {
  resolveLangfusePromptConnection,
  listLangfusePrompts,
  getLangfuseTextPrompt,
  LangfusePromptRequestError,
} from '~/langfuse/prompts';
import {
  isLangfuseConnectionAvailable,
  isLangfusePromptSyncAvailable,
  getLangfusePromptSyncTimeoutMs,
} from '~/langfuse/policy';
import {
  getLangfuseTenantDestinations,
  resolveLangfuseTenantDestination,
} from '~/langfuse/tenantDestinations';
import { redirectPolicyFor, resolveLangfuseHeaders } from '~/langfuse/utils';
import { decryptConfigSecret, encryptConfigSecretFields } from './secrets';
import { scopeHeadersToDestination } from '~/langfuse/destinations';
import { resolveLangfuseSession } from '~/langfuse/session';
import { mergeHeaders } from '~/utils/headers';

const DEFAULT_PRIORITY = 10;
const ENCRYPTED_PREFIX = 'v3:';
const LANGFUSE_VERIFICATION_TIMEOUT_MS = 10_000;

type LangfuseConnectionChange =
  | 'created'
  | 'credentials_rotated'
  | 'destination_changed'
  | 'disabled'
  | 'enabled'
  | 'updated';
type LangfuseConnectionChanges = [LangfuseConnectionChange, ...LangfuseConnectionChange[]];

export interface LangfuseConnectionEvent {
  event_name: 'librechat.langfuse.connection.changed';
  tenant_id?: string;
  configured: boolean;
  enabled: boolean;
  destination?: string;
  change: LangfuseConnectionChange;
  changes: LangfuseConnectionChange[];
  verification_result: 'skipped' | 'success';
}

export interface AdminLangfuseDeps {
  findConfigByPrincipal: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    options?: { includeInactive?: boolean },
    session?: ClientSession,
  ) => Promise<IConfig | null>;
  patchConfigFields: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    principalModel: PrincipalModel,
    fields: Record<string, unknown>,
    priority: number,
    session?: ClientSession,
  ) => Promise<IConfig | null>;
  toggleConfigActive: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    isActive: boolean,
    session?: ClientSession,
  ) => Promise<IConfig | null>;
  getMessages: MessageMethods['getMessages'];
  invalidateConfigCaches?: (tenantId?: string) => Promise<void>;
  recordConnectionUpdate?: (event: LangfuseConnectionEvent) => void;
}

function getTenantId(req: ServerRequest): string | undefined {
  return (req.user as { tenantId?: string } | undefined)?.tenantId;
}

/** Reads from the stored override tree, so this is `TCustomConfig`'s
 *  `DeepPartial` view of the section rather than the standalone
 *  `LangfuseConfig` — record-valued fields carry optional values here. */
function readStoredLangfuse(config: IConfig | null): TCustomConfig['langfuse'] {
  const overrides = config?.overrides as Partial<TCustomConfig> | undefined;
  return overrides?.langfuse;
}

function buildStatus(config: IConfig | null): TLangfuseConnectionStatus {
  const stored = readStoredLangfuse(config);
  const configured = Boolean(stored?.publicKey && stored?.secretKey);
  const promptSyncAvailable = isLangfusePromptSyncAvailable();
  return {
    configured,
    enabled: configured && stored?.enabled === true,
    destinations: getLangfuseTenantDestinations(),
    destination: stored?.destination,
    publicKey: stored?.publicKey,
    secretKeyPreview: stored?.secretKeyPreview,
    updatedAt: config?.updatedAt ? new Date(config.updatedAt).toISOString() : undefined,
    promptSync: {
      available: promptSyncAvailable,
      enabled: promptSyncAvailable && stored?.promptSync?.enabled === true,
    },
  };
}

function getConnectionChanges(
  stored: TCustomConfig['langfuse'],
  enabled: boolean,
  destination: string,
  publicKey: string,
  secretKey: string,
): LangfuseConnectionChanges {
  if (!stored?.publicKey || !stored.secretKey) {
    return ['created'];
  }
  const changes: LangfuseConnectionChange[] = [];
  if (stored.destination !== destination) {
    changes.push('destination_changed');
  }
  if (stored.publicKey !== publicKey || secretKey !== '') {
    changes.push('credentials_rotated');
  }
  if (stored.enabled !== true && enabled) {
    changes.push('enabled');
  }
  if (stored.enabled === true && !enabled) {
    changes.push('disabled');
  }
  const [change, ...additionalChanges] = changes;
  return change ? [change, ...additionalChanges] : ['updated'];
}

function rejectWhenConnectionUnavailable(res: Response): Response | undefined {
  if (isLangfuseConnectionAvailable()) {
    return undefined;
  }

  return res.status(404).json({ error: 'Langfuse connection settings are not available' });
}

const promptSyncUpdateSchema: z.ZodType<TUpdateLangfusePromptSyncRequest> = z
  .object({ enabled: z.boolean() })
  .strict();

const trimmedPromptString = (maxLength: number) => z.string().trim().min(1).max(maxLength);

const promptListQuerySchema = z.object({
  name: trimmedPromptString(256).optional(),
  label: trimmedPromptString(256).optional(),
  tag: trimmedPromptString(256).optional(),
  page: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  fromUpdatedAt: z.string().datetime().optional(),
  toUpdatedAt: z.string().datetime().optional(),
});

const promptNameParamSchema = trimmedPromptString(256);

const promptVersionQuerySchema = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .optional();

/** HTTP status for a `LangfusePromptRequestError`. A Langfuse `unauthorized`
 *  never maps to 401/403: the LibreChat client treats either as its own
 *  session expiring and reacts by refreshing the token or signing out. */
function promptRequestErrorStatus(code: LangfusePromptRequestErrorCode): number {
  return code === 'timeout' ? 504 : 502;
}

/** Maps a thrown Langfuse prompt request failure to the stable `{ code }`
 *  contract. Never forwards the upstream body, headers or credentials; logs
 *  only the error's own code/status/message, which `prompts.ts` guarantees
 *  are free of secrets. */
function respondToPromptRequestError(res: Response, error: unknown, logPrefix: string): Response {
  if (error instanceof LangfusePromptRequestError) {
    logger.error(logPrefix, error);
    const body: TLangfusePromptErrorBody =
      error.code === 'upstream' && error.status != null
        ? { code: error.code, status: error.status }
        : { code: error.code };
    return res.status(promptRequestErrorStatus(error.code)).json(body);
  }

  logger.error(logPrefix, error);
  return res.status(500).json({ code: 'upstream' } satisfies TLangfusePromptErrorBody);
}

type LangfuseVerificationFailure = {
  errorCode: TLangfuseConnectionTestErrorCode;
  message: string;
};

function getLangfuseTestFailure(status: number): LangfuseVerificationFailure {
  if (status === 401) {
    return {
      errorCode: 'invalid_credentials',
      message: 'Langfuse rejected these keys. Check the destination and keys',
    };
  }

  if (status === 403) {
    return {
      errorCode: 'access_denied',
      message: 'Langfuse denied access. Check the API key type and project status.',
    };
  }

  if (status === 429) {
    return {
      errorCode: 'rate_limited',
      message: 'Langfuse is rate limiting verification. Try again later.',
    };
  }

  if (status >= 500) {
    return {
      errorCode: 'server_error',
      message: 'Langfuse is returning server errors. This may be a Langfuse incident.',
    };
  }

  return {
    errorCode: 'unexpected_response',
    message: `Langfuse responded with status ${status}`,
  };
}

type LangfuseVerificationResult =
  | { success: true; projectId: string }
  | {
      success: false;
      errorCode: TLangfuseConnectionTestErrorCode;
      message: string;
      responseStatus?: number;
    };

async function verifyLangfuseCredentials(
  destination: LangfuseTenantDestination,
  publicKey: string,
  secretKey: string,
  headers?: Record<string, string>,
): Promise<LangfuseVerificationResult> {
  try {
    const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
    const signal = AbortSignal.timeout(LANGFUSE_VERIFICATION_TIMEOUT_MS);
    const secretResponse = await fetch(`${destination.baseUrl}/api/public/projects`, {
      headers: mergeHeaders(headers, { Authorization: `Basic ${auth}` }),
      signal,
      ...redirectPolicyFor(headers),
    });
    if (!secretResponse.ok) {
      return {
        success: false,
        ...getLangfuseTestFailure(secretResponse.status),
        responseStatus: secretResponse.status >= 500 ? 502 : 400,
      };
    }
    let projects: unknown;
    try {
      projects = await secretResponse.json();
    } catch {
      return {
        success: false,
        errorCode: 'unexpected_response',
        message: 'Langfuse returned an invalid project response',
        responseStatus: 400,
      };
    }
    const projectId =
      projects != null &&
      typeof projects === 'object' &&
      Array.isArray((projects as { data?: unknown }).data) &&
      (projects as { data: unknown[] }).data.length === 1 &&
      typeof (projects as { data: Array<{ id?: unknown }> }).data[0]?.id === 'string'
        ? (projects as { data: Array<{ id: string }> }).data[0].id.trim()
        : '';
    if (!projectId) {
      return {
        success: false,
        errorCode: 'unexpected_response',
        message: 'Langfuse did not return a project identity',
        responseStatus: 400,
      };
    }

    const publicResponse = await fetch(`${destination.baseUrl}/api/public/ingestion`, {
      method: 'POST',
      headers: mergeHeaders(headers, {
        Authorization: `Bearer ${publicKey}`,
        'X-Langfuse-Public-Key': publicKey,
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ batch: [] }),
      signal,
      ...redirectPolicyFor(headers),
    });
    if (!publicResponse.ok) {
      return {
        success: false,
        ...getLangfuseTestFailure(publicResponse.status),
        responseStatus: publicResponse.status >= 500 ? 502 : 400,
      };
    }

    return { success: true, projectId };
  } catch (error) {
    logger.error('[adminLangfuse] connection verification error:', error);
    if (error instanceof Error && error.name === 'TimeoutError') {
      return {
        success: false,
        errorCode: 'timeout',
        message: 'Langfuse verification timed out',
        responseStatus: 502,
      };
    }
    return {
      success: false,
      errorCode: 'unreachable',
      message: 'Could not reach the Langfuse host',
      responseStatus: 502,
    };
  }
}

/**
 * Admin handlers for the per-tenant Langfuse connection.
 *
 * The connection is stored as a `langfuse` override on the base config so it is
 * resolved for every user in the tenant. The secret key is encrypted at rest and
 * never returned by read endpoints; reads expose only non-secret metadata.
 */
export function createAdminLangfuseHandlers(deps: AdminLangfuseDeps): {
  getConnection: (req: ServerRequest, res: Response) => Promise<Response>;
  getSessionLink: (req: ServerRequest, res: Response) => Promise<Response>;
  updateConnection: (req: ServerRequest, res: Response) => Promise<Response>;
  testConnection: (req: ServerRequest, res: Response) => Promise<Response>;
  updatePromptSync: (req: ServerRequest, res: Response) => Promise<Response>;
  listPrompts: (req: ServerRequest, res: Response) => Promise<Response>;
  getPrompt: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const {
    findConfigByPrincipal,
    patchConfigFields,
    toggleConfigActive,
    getMessages,
    invalidateConfigCaches,
    recordConnectionUpdate = (event) =>
      logger.info({ message: '[adminLangfuse] Connection updated', ...event }),
  } = deps;

  function findBaseConfig(options?: { includeInactive?: boolean }): Promise<IConfig | null> {
    return options
      ? findConfigByPrincipal(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID, options)
      : findConfigByPrincipal(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID);
  }

  /** Shared 404 gate for the prompt-sync routes. `updatePromptSync` only
   *  needs the env-availability check: it is itself the write path for the
   *  stored switch, so it has nothing stored to compare against. */
  function rejectWhenPromptSyncUnavailable(res: Response): Response | undefined {
    if (!isLangfusePromptSyncAvailable()) {
      return res.status(404).json({ error: 'Langfuse prompt sync is not available' });
    }
    return undefined;
  }

  /** Tenant-switch gate for the list/get prompt routes. Reads the stored base
   *  config once — the same source `buildStatus` reads — and hands that one
   *  document back to the caller so it can also become the connection's
   *  tenant-owned fields (destination, keys, `promptSync`) instead of the
   *  cached `req.config`: a rotated destination or key can then never be
   *  paired with a stale credential from another instance's config cache.
   *  Checking `promptSync.enabled` off this same read also keeps this gate
   *  from disagreeing with the toggle's own status response through the
   *  config cache's TTL or across instances. */
  async function gatePromptSyncTenantSwitch(
    res: Response,
  ): Promise<
    | { response: Response; stored?: undefined }
    | { response?: undefined; stored: TCustomConfig['langfuse'] }
  > {
    const disabledResponse = rejectWhenPromptSyncUnavailable(res);
    if (disabledResponse) {
      return { response: disabledResponse };
    }

    const stored = readStoredLangfuse(await findBaseConfig());
    if (stored?.promptSync?.enabled !== true) {
      return {
        response: res.status(404).json({ error: 'Langfuse prompt sync is not available' }),
      };
    }

    return { stored };
  }

  /** The connection a list/get prompt request resolves against: deployment/
   *  yaml-only fields such as `headers` still come from `req.config`, while
   *  everything the connection tab writes comes from the gate's single stored
   *  read, so the same document authorizes the request and supplies its
   *  credentials. */
  function resolvePromptSyncConnection(
    req: ServerRequest,
    stored: TCustomConfig['langfuse'],
  ): LangfusePromptConnection | null {
    const appConfig = {
      ...req.config,
      langfuse: { ...req.config?.langfuse, ...stored },
    } as AppConfig;
    return resolveLangfusePromptConnection(appConfig, { tenantId: getTenantId(req) });
  }

  async function getConnection(req: ServerRequest, res: Response): Promise<Response> {
    const disabledResponse = rejectWhenConnectionUnavailable(res);
    if (disabledResponse) {
      return disabledResponse;
    }

    try {
      const config = await findBaseConfig();
      return res.status(200).json(buildStatus(config));
    } catch (error) {
      logger.error('[adminLangfuse] getConnection error:', error);
      return res.status(500).json({ error: 'Failed to read Langfuse connection' });
    }
  }

  async function getSessionLink(req: ServerRequest, res: Response): Promise<Response> {
    const disabledResponse = rejectWhenConnectionUnavailable(res);
    if (disabledResponse) {
      return disabledResponse;
    }

    const conversationId = (req.params as { conversationId?: string }).conversationId?.trim();
    const userId = req.user?.id ?? req.user?._id?.toString();
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId is required' });
    }

    try {
      const session = await resolveLangfuseSession({
        config: readStoredLangfuse(await findBaseConfig()),
        conversationId,
        userId,
        getMessages,
      });
      const response: TLangfuseSessionLinkResponse = session
        ? { url: session.url, destinationId: session.destinationId }
        : { url: null };
      return res.status(200).json(response);
    } catch (error) {
      logger.error('[adminLangfuse] getSessionLink error:', error);
      return res.status(500).json({ error: 'Failed to resolve Langfuse session' });
    }
  }

  async function updateConnection(req: ServerRequest, res: Response): Promise<Response> {
    const disabledResponse = rejectWhenConnectionUnavailable(res);
    if (disabledResponse) {
      return disabledResponse;
    }

    try {
      const body = (req.body ?? {}) as TUpdateLangfuseConnectionRequest;
      const enabled = body.enabled === true;
      const destination = typeof body.destination === 'string' ? body.destination.trim() : '';
      const publicKey = typeof body.publicKey === 'string' ? body.publicKey.trim() : '';
      const secretKey = typeof body.secretKey === 'string' ? body.secretKey.trim() : '';

      if (!destination) {
        return res.status(400).json({ error: 'destination is required' });
      }
      if (!publicKey) {
        return res.status(400).json({ error: 'publicKey is required' });
      }
      if (secretKey.startsWith(ENCRYPTED_PREFIX)) {
        return res.status(400).json({ error: 'Encrypted secretKey values cannot be submitted' });
      }

      const existing = await findBaseConfig({ includeInactive: true });
      const stored = readStoredLangfuse(existing);
      const hasStoredSecret = Boolean(stored?.secretKey);
      const tenantDestination = resolveLangfuseTenantDestination(destination);
      const isPureDisableOfStoredConnection =
        !enabled &&
        secretKey === '' &&
        hasStoredSecret &&
        stored?.destination === destination &&
        stored.publicKey === publicKey;

      if (!tenantDestination && !isPureDisableOfStoredConnection) {
        return res.status(400).json({ error: 'destination is not configured' });
      }
      if (!secretKey && !hasStoredSecret) {
        return res
          .status(400)
          .json({ error: 'secretKey is required for first-time configuration' });
      }

      const persistedDestination = tenantDestination?.key ?? destination;
      const connectionChanged =
        secretKey !== '' ||
        stored?.destination !== persistedDestination ||
        stored?.publicKey !== publicKey;
      let verifiedProjectId = stored?.projectId;
      if (connectionChanged) {
        if (!tenantDestination) {
          return res.status(400).json({ error: 'destination is not configured' });
        }
        if (!secretKey) {
          return res
            .status(400)
            .json({ error: 'secretKey is required when changing the destination or publicKey' });
        }
        const verification = await verifyLangfuseCredentials(
          tenantDestination,
          publicKey,
          secretKey,
          scopeHeadersToDestination(
            resolveLangfuseHeaders(req.config?.langfuse?.headers),
            tenantDestination.baseUrl,
          ),
        );
        if (!verification.success) {
          return res
            .status(verification.responseStatus ?? 400)
            .json({ error: verification.message });
        }
        verifiedProjectId = verification.projectId;
      }

      const fields: Record<string, unknown> = {
        'langfuse.enabled': enabled,
        'langfuse.destination': persistedDestination,
        'langfuse.publicKey': publicKey,
      };
      if (verifiedProjectId) {
        fields['langfuse.projectId'] = verifiedProjectId;
      }
      if (secretKey) {
        fields['langfuse.secretKey'] = secretKey;
      }

      let updated = await patchConfigFields(
        PrincipalType.ROLE,
        BASE_CONFIG_PRINCIPAL_ID,
        PrincipalModel.ROLE,
        encryptConfigSecretFields(fields),
        existing?.priority ?? DEFAULT_PRIORITY,
      );
      if (updated?.isActive === false) {
        updated = await toggleConfigActive(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID, true);
      }

      const status = buildStatus(updated ?? existing);
      const changes = getConnectionChanges(
        stored,
        enabled,
        persistedDestination,
        publicKey,
        secretKey,
      );
      recordConnectionUpdate({
        event_name: 'librechat.langfuse.connection.changed',
        tenant_id: getTenantId(req),
        configured: status.configured,
        enabled: status.enabled,
        destination: status.destination,
        change: changes[0],
        changes,
        verification_result: connectionChanged ? 'success' : 'skipped',
      });

      invalidateConfigCaches?.(getTenantId(req))?.catch((err) =>
        logger.error('[adminLangfuse] Cache invalidation failed after update:', err),
      );

      return res.status(200).json(status);
    } catch (error) {
      logger.error('[adminLangfuse] updateConnection error:', error);
      return res.status(500).json({ error: 'Failed to update Langfuse connection' });
    }
  }

  async function testConnection(req: ServerRequest, res: Response): Promise<Response> {
    const disabledResponse = rejectWhenConnectionUnavailable(res);
    if (disabledResponse) {
      return disabledResponse;
    }

    try {
      const body = (req.body ?? {}) as TLangfuseConnectionTestRequest;
      const destination = typeof body.destination === 'string' ? body.destination.trim() : '';
      const publicKey = typeof body.publicKey === 'string' ? body.publicKey.trim() : '';
      let secretKey = typeof body.secretKey === 'string' ? body.secretKey.trim() : '';
      const tenantDestination = resolveLangfuseTenantDestination(destination);

      if (!destination || !publicKey) {
        return res.status(400).json({ error: 'destination and publicKey are required' });
      }
      if (!tenantDestination) {
        return res.status(400).json({ error: 'destination is not configured' });
      }
      if (secretKey.startsWith(ENCRYPTED_PREFIX)) {
        return res.status(400).json({ error: 'Encrypted secretKey values cannot be submitted' });
      }

      if (!secretKey) {
        const existing = await findBaseConfig();
        const stored = readStoredLangfuse(existing);
        const unchangedConnection =
          stored?.destination === tenantDestination.key && stored.publicKey === publicKey;
        if (unchangedConnection && stored.secretKey) {
          secretKey = decryptConfigSecret(stored.secretKey) ?? '';
          if (!secretKey) {
            const failed: TLangfuseConnectionTestResponse = {
              success: false,
              errorCode: 'stored_secret_unavailable',
            };
            return res.status(200).json(failed);
          }
        }
      }

      if (!secretKey) {
        const failed: TLangfuseConnectionTestResponse = {
          success: false,
          errorCode: 'missing_secret',
        };
        return res.status(200).json(failed);
      }

      const result = await verifyLangfuseCredentials(
        tenantDestination,
        publicKey,
        secretKey,
        scopeHeadersToDestination(
          resolveLangfuseHeaders(req.config?.langfuse?.headers),
          tenantDestination.baseUrl,
        ),
      );
      const response: TLangfuseConnectionTestResponse = result.success
        ? { success: true }
        : { success: false, errorCode: result.errorCode };
      return res.status(200).json(response);
    } catch (error) {
      logger.error('[adminLangfuse] testConnection error:', error);
      const result: TLangfuseConnectionTestResponse = {
        success: false,
        errorCode: 'unreachable',
      };
      return res.status(200).json(result);
    }
  }

  async function updatePromptSync(req: ServerRequest, res: Response): Promise<Response> {
    const disabledResponse = rejectWhenPromptSyncUnavailable(res);
    if (disabledResponse) {
      return disabledResponse;
    }

    const parsedBody = promptSyncUpdateSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({ code: 'invalid_request' } satisfies TLangfusePromptErrorBody);
    }

    try {
      // `includeInactive` so an inactive base config keeps its own `priority`
      // on this patch, matching `updateConnection` — toggling prompt sync must
      // never reactivate a config an admin deactivated for other reasons.
      const existing = await findBaseConfig({ includeInactive: true });
      const updated = await patchConfigFields(
        PrincipalType.ROLE,
        BASE_CONFIG_PRINCIPAL_ID,
        PrincipalModel.ROLE,
        { 'langfuse.promptSync.enabled': parsedBody.data.enabled },
        existing?.priority ?? DEFAULT_PRIORITY,
      );

      invalidateConfigCaches?.(getTenantId(req))?.catch((err) =>
        logger.error('[adminLangfuse] Cache invalidation failed after prompt sync update:', err),
      );

      // An inactive config is invisible to `getConnection` (which reads
      // without `includeInactive`), so report the same empty status here
      // rather than echoing back fields nobody else can see.
      return res.status(200).json(buildStatus(updated?.isActive === false ? null : updated));
    } catch (error) {
      logger.error('[adminLangfuse] updatePromptSync error:', error);
      return res.status(500).json({ error: 'Failed to update Langfuse prompt sync setting' });
    }
  }

  async function listPrompts(req: ServerRequest, res: Response): Promise<Response> {
    const gate = await gatePromptSyncTenantSwitch(res);
    if (gate.response) {
      return gate.response;
    }

    const parsedQuery = promptListQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({ code: 'invalid_request' } satisfies TLangfusePromptErrorBody);
    }

    const connection = resolvePromptSyncConnection(req, gate.stored);
    if (!connection) {
      return res.status(409).json({ code: 'not_configured' } satisfies TLangfusePromptErrorBody);
    }

    try {
      const result = await listLangfusePrompts(connection, parsedQuery.data, {
        timeoutMs: getLangfusePromptSyncTimeoutMs(),
      });
      return res.status(200).json(result satisfies TLangfusePromptListResponse);
    } catch (error) {
      return respondToPromptRequestError(res, error, '[adminLangfuse] listPrompts error:');
    }
  }

  async function getPrompt(req: ServerRequest, res: Response): Promise<Response> {
    const gate = await gatePromptSyncTenantSwitch(res);
    if (gate.response) {
      return gate.response;
    }

    const parsedName = promptNameParamSchema.safeParse((req.params as { name?: string }).name);
    const parsedVersion = promptVersionQuerySchema.safeParse(
      (req.query as { version?: unknown }).version,
    );
    if (!parsedName.success || !parsedVersion.success) {
      return res.status(400).json({ code: 'invalid_request' } satisfies TLangfusePromptErrorBody);
    }

    const connection = resolvePromptSyncConnection(req, gate.stored);
    if (!connection) {
      return res.status(409).json({ code: 'not_configured' } satisfies TLangfusePromptErrorBody);
    }

    const selector: LangfuseTextPromptSelector =
      parsedVersion.data != null ? { version: parsedVersion.data } : { label: 'production' };

    try {
      const result = await getLangfuseTextPrompt(connection, parsedName.data, selector, {
        timeoutMs: getLangfusePromptSyncTimeoutMs(),
      });
      if (!result.ok) {
        const status = result.error.code === 'not_found' ? 404 : 422;
        return res
          .status(status)
          .json({ code: result.error.code } satisfies TLangfusePromptErrorBody);
      }
      return res.status(200).json(result.value satisfies TLangfusePromptGetResponse);
    } catch (error) {
      return respondToPromptRequestError(res, error, '[adminLangfuse] getPrompt error:');
    }
  }

  return {
    getConnection,
    getSessionLink,
    updateConnection,
    testConnection,
    updatePromptSync,
    listPrompts,
    getPrompt,
  };
}
