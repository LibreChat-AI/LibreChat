import { createHash, randomBytes } from 'node:crypto';
import {
  getTenantId,
  SYSTEM_TENANT_ID,
  TransactionUnavailableError,
} from '@librechat/data-schemas';
import {
  channelSnowflakeSchema,
  configureDiscordApplicationSchema,
  registerDiscordCommandsSchema,
} from 'librechat-data-provider';
import type {
  ConfigureDiscordApplication,
  RegisterDiscordCommands,
  DiscordCommandRegistration,
  DiscordApplication,
  DiscordGuild,
} from 'librechat-data-provider';
import type {
  DiscordInstallationStorage,
  DiscordInstallStorage,
  DiscordInstallView,
  DiscordStorageError,
  DiscordInstallError,
} from '@librechat/data-schemas';
import type { DiscordProviderClient, DiscordProviderError } from './client';
import type { SafeErrorMetadata } from '~/utils/errors';
import { getSafeErrorMetadata } from '~/utils/errors';

export interface DiscordManagementPrincipal {
  id: string;
  tenantId?: string;
}
export interface DiscordManagementSettings {
  enabled: boolean;
  flowLifetimeMs: number;
}
export type DiscordManagementError =
  | DiscordProviderError
  | DiscordStorageError
  | DiscordInstallError
  | 'forbidden'
  | 'not_configured'
  | 'transactions_unavailable'
  | 'unavailable';
export type DiscordManagementResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: DiscordManagementError } };
export interface DiscordConnectView {
  url: string;
  flowId: string;
  expiresInSeconds: number;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const rawState = /^[A-Za-z0-9_-]{43}$/;
const stateId = /^[a-f\d]{64}$/;
const identifier = /^[\w-]{1,128}$/;
const failure = (
  code: DiscordManagementError,
): { ok: false; error: { code: DiscordManagementError } } => ({ ok: false, error: { code } });
function validSession(value: string): boolean {
  return typeof value === 'string' && value.length >= 32 && value.length <= 4096;
}

/**
 * sessionBinding comes only from trusted authenticated-session middleware, never JSON/query fields.
 * canManage must check the active same-tenant user and ACCESS_ADMIN plus MANAGE_AGENTS capabilities.
 * The HTTP host supplies JWT, same-origin writes and existing OAuth CSRF/session cookie validation.
 */
export function createDiscordManagementService(deps: {
  installations: DiscordInstallationStorage;
  states: DiscordInstallStorage;
  provider: DiscordProviderClient;
  canManage: (principal: DiscordManagementPrincipal) => Promise<boolean>;
  settings: () => Promise<DiscordManagementSettings>;
  encrypt: (value: string) => Promise<string>;
  decrypt: (value: string) => Promise<string>;
  now?: () => number;
  logError?: (metadata: SafeErrorMetadata) => void;
}) {
  const now = deps.now ?? Date.now;
  async function authorized(principal: DiscordManagementPrincipal): Promise<boolean> {
    const tenantId = getTenantId();
    return Boolean(
      principal.id &&
        tenantId !== SYSTEM_TENANT_ID &&
        (tenantId || undefined) === (principal.tenantId || undefined) &&
        (await deps.canManage(principal)),
    );
  }
  async function settings(): Promise<DiscordManagementSettings> {
    const value = await deps.settings();
    if (
      !Number.isSafeInteger(value.flowLifetimeMs) ||
      value.flowLifetimeMs < 1 ||
      !Number.isFinite(new Date(now() + value.flowLifetimeMs).getTime())
    )
      throw new TypeError('Invalid Discord authorization lifetime');
    return value;
  }
  async function protect<T>(
    work: () => Promise<DiscordManagementResult<T>>,
  ): Promise<DiscordManagementResult<T>> {
    try {
      return await work();
    } catch (error) {
      deps.logError?.(getSafeErrorMetadata(error));
      return failure(error instanceof TransactionUnavailableError ? error.code : 'unavailable');
    }
  }
  return {
    register(
      principal: DiscordManagementPrincipal,
      input: RegisterDiscordCommands,
    ): Promise<DiscordManagementResult<DiscordCommandRegistration>> {
      return protect(async () => {
        if (!(await authorized(principal))) return failure('forbidden');
        if (!(await settings()).enabled) return failure('not_configured');
        const parsed = registerDiscordCommandsSchema.safeParse(input);
        if (!parsed.success) return failure('invalid_input');
        const authority = {
          actorId: principal.id,
          applicationId: parsed.data.applicationId,
          expectedRevision: parsed.data.expectedRevision,
        };
        const admitted = await deps.installations.authorizeApplication(authority);
        if (!admitted.ok) return admitted;
        const current = admitted.value;
        const botToken = await deps.decrypt(current.encryptedBotToken);
        if (!(await authorized(principal))) return failure('forbidden');
        if (!(await settings()).enabled) return failure('not_configured');
        const result = await deps.provider.registerCommands({
          application: {
            applicationId: current.applicationId,
            botUserId: current.botUserId,
            publicKey: current.publicKey,
            name: current.name ?? 'LibreChat',
          },
          botToken,
        });
        if (!(await authorized(principal))) return failure('forbidden');
        if (!(await settings()).enabled) return failure('not_configured');
        const latest = await deps.installations.authorizeApplication(authority);
        return latest.ok ? result : latest;
      });
    },
    configure(
      principal: DiscordManagementPrincipal,
      input: ConfigureDiscordApplication,
    ): Promise<DiscordManagementResult<DiscordApplication>> {
      return protect(async () => {
        if (!(await authorized(principal))) return failure('forbidden');
        if (!(await settings()).enabled) return failure('not_configured');
        const parsed = configureDiscordApplicationSchema.safeParse(input);
        if (!parsed.success) return failure('invalid_input');
        const data = parsed.data;
        const current = await deps.installations.readApplicationCredentials(data.applicationId);
        if (
          current ? current.revision !== data.expectedRevision : data.expectedRevision !== undefined
        )
          return failure('application_changed');
        const botToken =
          data.botToken ?? (current ? await deps.decrypt(current.encryptedBotToken) : '');
        if (!(await authorized(principal))) return failure('forbidden');
        if (!(await settings()).enabled) return failure('not_configured');
        const verified = await deps.provider.verifyApplication({
          applicationId: data.applicationId,
          botToken,
          ...(current ? { expectedBotUserId: current.botUserId } : {}),
        });
        if (!(await authorized(principal))) return failure('forbidden');
        if (!(await settings()).enabled) return failure('not_configured');
        if (!verified.ok) return verified;
        const [encryptedBotToken, encryptedClientSecret] = await Promise.all([
          data.botToken ? deps.encrypt(data.botToken) : undefined,
          data.clientSecret ? deps.encrypt(data.clientSecret) : undefined,
        ]);
        if (!(await authorized(principal))) return failure('forbidden');
        if (!(await settings()).enabled) return failure('not_configured');
        return deps.installations.configureApplication({
          actorId: principal.id,
          applicationId: verified.value.applicationId,
          botUserId: verified.value.botUserId,
          publicKey: verified.value.publicKey,
          name: data.name ?? verified.value.name,
          encryptedBotToken,
          encryptedClientSecret,
          expectedRevision: data.expectedRevision,
        });
      });
    },
    start(
      principal: DiscordManagementPrincipal,
      input: { applicationId: string; installationId?: string },
      sessionBinding: string,
    ): Promise<DiscordManagementResult<DiscordConnectView>> {
      return protect(async () => {
        if (!(await authorized(principal))) return failure('forbidden');
        const config = await settings();
        if (!config.enabled) return failure('not_configured');
        if (
          !validSession(sessionBinding) ||
          !channelSnowflakeSchema.safeParse(input.applicationId).success ||
          (input.installationId !== undefined && !identifier.test(input.installationId))
        )
          return failure('invalid_input');
        const application = await deps.installations.readApplication(input.applicationId);
        if (!application) return failure('application_unavailable');
        const guild = input.installationId
          ? await deps.installations.readGuild(input.installationId)
          : null;
        if (input.installationId && (!guild || guild.applicationId !== input.applicationId))
          return failure('installation_changed');
        const state = randomBytes(32).toString('base64url');
        const url = deps.provider.authorizationURL({
          applicationId: application.applicationId,
          state,
          ...(guild ? { guildId: guild.guildId } : {}),
        });
        if (!url.ok) return url;
        const saved = await deps.states.start({
          stateHash: digest(state),
          sessionHash: digest(sessionBinding),
          userId: principal.id,
          applicationId: application.applicationId,
          applicationRevision: application.revision,
          expiresAt: new Date(now() + config.flowLifetimeMs),
          ...(guild
            ? { installationId: guild.installationId, installationRevision: guild.revision }
            : {}),
        });
        if (!saved.ok) return saved;
        return {
          ok: true,
          value: {
            url: url.value,
            flowId: saved.value.stateHash,
            expiresInSeconds: Math.ceil(config.flowLifetimeMs / 1000),
          },
        };
      });
    },
    /** Server-only discovery for tenant/session restoration; never return this record to a browser. */
    inspect(state: string): Promise<DiscordManagementResult<DiscordInstallView | null>> {
      return protect(async () => ({
        ok: true,
        value: rawState.test(state)
          ? await deps.states.lookup(digest(state), new Date(now()))
          : null,
      }));
    },
    finish(
      principal: DiscordManagementPrincipal,
      input: { state: string; code: string; issuer: string },
      sessionBinding: string,
    ): Promise<DiscordManagementResult<DiscordGuild>> {
      return protect(async () => {
        if (!(await authorized(principal))) return failure('forbidden');
        if (!(await settings()).enabled) return failure('not_configured');
        if (!rawState.test(input.state) || !validSession(sessionBinding))
          return failure('invalid_state');
        // A consumed flow stays consumed on refused grants, changed permissions and network failure.
        const consumed = await deps.states.consume({
          stateHash: digest(input.state),
          sessionHash: digest(sessionBinding),
          userId: principal.id,
          now: new Date(now()),
        });
        if (!consumed.ok) return consumed;
        const flow = consumed.value;
        const application = await deps.installations.readApplicationCredentials(flow.applicationId);
        if (!application || application.revision !== flow.applicationRevision)
          return failure('application_changed');
        const [botToken, clientSecret] = await Promise.all([
          deps.decrypt(application.encryptedBotToken),
          deps.decrypt(application.encryptedClientSecret),
        ]);
        if (!(await authorized(principal))) return failure('forbidden');
        if (!(await settings()).enabled) return failure('not_configured');
        const verified = await deps.provider.exchangeGuild({
          application: {
            applicationId: application.applicationId,
            botUserId: application.botUserId,
            publicKey: application.publicKey,
            name: application.name ?? '',
          },
          botToken,
          clientSecret,
          code: input.code,
          issuer: input.issuer,
          ...(flow.guildId ? { expectedGuildId: flow.guildId } : {}),
        });
        if (!(await authorized(principal))) return failure('forbidden');
        if (!(await settings()).enabled) return failure('not_configured');
        if (!verified.ok) return verified;
        return deps.installations.connectGuild({
          actorId: principal.id,
          applicationId: flow.applicationId,
          applicationRevision: flow.applicationRevision,
          guildId: verified.value.guildId,
          guildName: verified.value.guildName,
          ...(flow.installationId
            ? { installationId: flow.installationId, expectedRevision: flow.installationRevision }
            : {}),
        });
      });
    },
    cancel(
      principal: DiscordManagementPrincipal,
      flowId: string,
      sessionBinding: string,
    ): Promise<DiscordManagementResult<boolean>> {
      return protect(async () => {
        if (!(await authorized(principal))) return failure('forbidden');
        if (!stateId.test(flowId) || !validSession(sessionBinding)) return failure('invalid_state');
        await deps.states.cancel({
          stateHash: flowId,
          sessionHash: digest(sessionBinding),
          userId: principal.id,
        });
        return { ok: true, value: true };
      });
    },
    disconnect(
      principal: DiscordManagementPrincipal,
      installationId: string,
      expectedRevision: string,
    ): Promise<DiscordManagementResult<DiscordGuild>> {
      return protect(async () => {
        if (!(await authorized(principal))) return failure('forbidden');
        if (!identifier.test(installationId) || !identifier.test(expectedRevision))
          return failure('invalid_input');
        return deps.installations.disconnectGuild({
          actorId: principal.id,
          installationId,
          expectedRevision,
        });
      });
    },
    applications(
      principal: DiscordManagementPrincipal,
      cursor?: string,
    ): Promise<DiscordManagementResult<{ applications: DiscordApplication[]; next?: string }>> {
      return protect(async () => {
        if (!(await authorized(principal))) return failure('forbidden');
        return { ok: true, value: await deps.installations.listApplications(cursor) };
      });
    },
    guilds(
      principal: DiscordManagementPrincipal,
      cursor?: string,
    ): Promise<DiscordManagementResult<{ guilds: DiscordGuild[]; next?: string }>> {
      return protect(async () => {
        if (!(await authorized(principal))) return failure('forbidden');
        return { ok: true, value: await deps.installations.listGuilds(cursor) };
      });
    },
  };
}
export type DiscordManagementService = ReturnType<typeof createDiscordManagementService>;
