import { z } from 'zod';
import {
  channelSnowflakeSchema,
  discordPublicKeySchema,
  DISCORD_COMMAND_MANIFEST_VERSION,
} from 'librechat-data-provider';
import type { DiscordCommandRegistration } from 'librechat-data-provider';
import { discordCommandManifest, registeredDiscordCommandSchema } from './registration';

const api = 'https://discord.com/api/v10';
const scopes = ['bot', 'applications.commands', 'guilds'] as const;
const manageGuildOrAdministrator = BigInt(32) | BigInt(8);
const permissions = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine((value) => value.length < 20 || value <= '18446744073709551615');
const guildSchema = z.object({ id: channelSnowflakeSchema, name: z.string().min(1).max(256) });
const applicationSchema = z.object({
  id: channelSnowflakeSchema,
  name: z.string().min(1).max(100),
  bot: z.object({ id: channelSnowflakeSchema, bot: z.literal(true).optional() }).optional(),
  verify_key: discordPublicKeySchema,
  bot_require_code_grant: z.boolean(),
});
const botSchema = z.object({ id: channelSnowflakeSchema, bot: z.literal(true) });
const grantSchema = z.object({
  access_token: z.string().min(1).max(4096),
  token_type: z.literal('Bearer'),
  scope: z.string().max(8192),
  guild: guildSchema,
});
const authorizationSchema = z.object({
  application: z.object({ id: channelSnowflakeSchema }),
  scopes: z.array(z.string()).max(100),
});
const userGuildsSchema = z
  .array(
    z.object({
      id: channelSnowflakeSchema,
      owner: z.boolean(),
      permissions,
    }),
  )
  .max(200);

export interface DiscordProviderConfig {
  redirectUri: string;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  /** Requested bot permissions, selected by the host's enabled capabilities. */
  botPermissions: string;
}

export interface VerifiedDiscordApplication {
  applicationId: string;
  botUserId: string;
  publicKey: string;
  name: string;
}

export interface VerifiedDiscordGuildInstallation {
  application: VerifiedDiscordApplication;
  guildId: string;
  guildName: string;
}
export interface InspectDiscordChannel {
  application: VerifiedDiscordApplication;
  botToken: string;
  guildId: string;
  externalChannelId: string;
}
export interface VerifiedDiscordChannel {
  externalChannelId: string;
  guildId: string;
  name: string;
}

export type DiscordProviderError =
  | 'invalid_input'
  | 'application_changed'
  | 'unsupported_installation'
  | 'unsupported_channel'
  | 'invalid_grant'
  | 'guild_changed'
  | 'missing_permissions'
  | 'provider_refused'
  | 'provider_unavailable'
  | 'rate_limited'
  | 'timeout'
  | 'malformed_response'
  | 'response_too_large';
export type DiscordProviderResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: DiscordProviderError } };

export interface VerifyDiscordApplication {
  applicationId: string;
  botToken: string;
  expectedBotUserId?: string;
  expectedPublicKey?: string;
}

export interface ExchangeDiscordGuild {
  application: VerifiedDiscordApplication;
  botToken: string;
  clientSecret: string;
  code: string;
  issuer: string;
  /** Trusted reconnect scope from stored state, never a callback guild_id hint. */
  expectedGuildId?: string;
}

export interface DiscordProviderClient {
  registerCommands(input: {
    application: VerifiedDiscordApplication;
    botToken: string;
  }): Promise<DiscordProviderResult<DiscordCommandRegistration>>;
  verifyApplication(
    input: VerifyDiscordApplication,
  ): Promise<DiscordProviderResult<VerifiedDiscordApplication>>;
  authorizationURL(input: {
    applicationId: string;
    state: string;
    guildId?: string;
  }): DiscordProviderResult<string>;
  exchangeGuild(
    input: ExchangeDiscordGuild,
  ): Promise<DiscordProviderResult<VerifiedDiscordGuildInstallation>>;
  inspectChannel(
    input: InspectDiscordChannel,
  ): Promise<DiscordProviderResult<VerifiedDiscordChannel>>;
}

class ProviderFailure extends Error {
  constructor(readonly code: DiscordProviderError) {
    super(code);
  }
}
function failure(code: DiscordProviderError): never {
  throw new ProviderFailure(code);
}
const resultError = (error: unknown): { ok: false; error: { code: DiscordProviderError } } => ({
  ok: false,
  error: { code: error instanceof ProviderFailure ? error.code : 'provider_unavailable' },
});
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  return result.success ? result.data : failure('malformed_response');
}
function credential(value: string): void {
  if (!value || value.length > 4096 || /[\r\n]/.test(value)) failure('invalid_input');
}
function snowflake(value: string): void {
  if (!channelSnowflakeSchema.safeParse(value).success) failure('invalid_input');
}
function trustedRedirect(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new TypeError('Discord requires a trusted callback URL');
  return url.toString();
}

/**
 * The service host must check active LibreChat organization administrator authority
 * before and after network work, and bind/claim OAuth state before exchanging a code.
 * Discord guild management rights do not grant a LibreChat execution identity.
 */
export function createDiscordProviderClient(deps: {
  config: DiscordProviderConfig;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}): DiscordProviderClient {
  const { requestTimeoutMs, maxResponseBytes, botPermissions } = deps.config;
  const redirectUri = trustedRedirect(deps.config.redirectUri);
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    !permissions.safeParse(botPermissions).success
  )
    throw new TypeError('Invalid Discord provider configuration');

  async function request(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    let rejectTimeout: (reason: ProviderFailure) => void = () => {};
    const expired = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      rejectTimeout(new ProviderFailure('timeout'));
      controller.abort();
    }, requestTimeoutMs);
    async function read(): Promise<unknown> {
      const response = await deps.fetch(`${api}${path}`, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        failure('timeout');
      }
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {});
        failure('provider_refused');
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 429) failure('rate_limited');
        if (response.status >= 500) failure('provider_unavailable');
        failure('provider_refused');
      }
      const declaredLength = response.headers.get('content-length');
      if (declaredLength && Number(declaredLength) > maxResponseBytes) {
        void response.body?.cancel().catch(() => {});
        failure('response_too_large');
      }
      const reader = response.body?.getReader();
      if (!reader) failure('malformed_response');
      const abort = () => {
        void reader.cancel().catch(() => {});
      };
      controller.signal.addEventListener('abort', abort, { once: true });
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > maxResponseBytes) failure('response_too_large');
          chunks.push(value);
        }
        if (controller.signal.aborted) failure('timeout');
        try {
          return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return failure('malformed_response');
        }
      } finally {
        controller.signal.removeEventListener('abort', abort);
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    try {
      return await Promise.race([read(), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function verifiedApplication(
    input: VerifyDiscordApplication,
  ): Promise<VerifiedDiscordApplication> {
    snowflake(input.applicationId);
    credential(input.botToken);
    const headers = { Authorization: `Bot ${input.botToken}` };
    const [app, bot] = await Promise.all([
      request('/applications/@me', { headers }).then((value) => parse(applicationSchema, value)),
      request('/users/@me', { headers }).then((value) => parse(botSchema, value)),
    ]);
    if (
      app.id !== input.applicationId ||
      (app.bot !== undefined && app.bot.id !== bot.id) ||
      (input.expectedBotUserId !== undefined && bot.id !== input.expectedBotUserId) ||
      (input.expectedPublicKey !== undefined &&
        app.verify_key.toLowerCase() !== input.expectedPublicKey.toLowerCase())
    )
      failure('application_changed');
    if (!app.bot_require_code_grant) failure('unsupported_installation');
    return {
      applicationId: app.id,
      botUserId: bot.id,
      publicKey: app.verify_key.toLowerCase(),
      name: app.name,
    };
  }

  return {
    async registerCommands(input) {
      try {
        const application = await verifiedApplication({
          applicationId: input.application.applicationId,
          botToken: input.botToken,
          expectedBotUserId: input.application.botUserId,
          expectedPublicKey: input.application.publicKey,
        });
        const command = parse(
          registeredDiscordCommandSchema,
          await request(`/applications/${application.applicationId}/commands`, {
            method: 'POST',
            headers: { Authorization: `Bot ${input.botToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(discordCommandManifest),
          }),
        );
        if (command.application_id !== application.applicationId) failure('application_changed');
        return {
          ok: true,
          value: {
            applicationId: application.applicationId,
            commandId: command.id,
            providerVersion: command.version,
            manifestVersion: DISCORD_COMMAND_MANIFEST_VERSION,
          },
        };
      } catch (error) {
        return resultError(error);
      }
    },
    async inspectChannel(input) {
      try {
        snowflake(input.guildId);
        snowflake(input.externalChannelId);
        const application = await verifiedApplication({
          applicationId: input.application.applicationId,
          botToken: input.botToken,
          expectedBotUserId: input.application.botUserId,
          expectedPublicKey: input.application.publicKey,
        });
        const headers = { Authorization: `Bot ${input.botToken}` };
        const [channel, effective] = await Promise.all([
          request(`/channels/${input.externalChannelId}`, { headers }).then((value) =>
            parse(
              z.object({
                id: channelSnowflakeSchema,
                guild_id: channelSnowflakeSchema,
                type: z.number().int(),
                name: z.string().min(1).max(100),
                flags: z.number().int().nonnegative().optional(),
              }),
              value,
            ),
          ),
          // Discord computes roles and channel/member overwrites, including administrator bypass.
          request(
            `/channels/${input.externalChannelId}/permissions/member/${application.botUserId}`,
            { headers },
          ).then((value) => parse(z.object({ permissions }), value)),
        ]);
        if (channel.id !== input.externalChannelId || channel.guild_id !== input.guildId)
          failure('guild_changed');
        if (channel.type !== 0) failure('unsupported_channel');
        if ((BigInt(channel.flags ?? 0) & BigInt(1 << 17)) !== BigInt(0))
          failure('missing_permissions');
        const required = BigInt(1024 | 2048 | 65536);
        const granted = BigInt(effective.permissions);
        if ((granted & BigInt(8)) === BigInt(0) && (granted & required) !== required)
          failure('missing_permissions');
        return {
          ok: true,
          value: { externalChannelId: channel.id, guildId: channel.guild_id, name: channel.name },
        };
      } catch (error) {
        return resultError(error);
      }
    },
    async verifyApplication(input) {
      try {
        return { ok: true, value: await verifiedApplication(input) };
      } catch (error) {
        return resultError(error);
      }
    },
    authorizationURL(input) {
      try {
        snowflake(input.applicationId);
        if (!/^[A-Za-z0-9_-]{43}$/.test(input.state)) failure('invalid_input');
        if (input.guildId !== undefined) snowflake(input.guildId);
        const url = new URL('https://discord.com/oauth2/authorize');
        url.search = new URLSearchParams({
          client_id: input.applicationId,
          response_type: 'code',
          redirect_uri: redirectUri,
          scope: scopes.join(' '),
          state: input.state,
          integration_type: '0',
          permissions: botPermissions,
          ...(input.guildId ? { guild_id: input.guildId, disable_guild_select: 'true' } : {}),
        }).toString();
        return { ok: true, value: url.toString() };
      } catch (error) {
        return resultError(error);
      }
    },
    async exchangeGuild(input) {
      try {
        if (input.issuer !== 'https://discord.com') failure('invalid_grant');
        if (!input.code || input.code.length > 2048) failure('invalid_input');
        credential(input.clientSecret);
        if (input.expectedGuildId !== undefined) snowflake(input.expectedGuildId);
        const application = await verifiedApplication({
          applicationId: input.application.applicationId,
          botToken: input.botToken,
          expectedBotUserId: input.application.botUserId,
          expectedPublicKey: input.application.publicKey,
        });
        const grant = parse(
          grantSchema,
          await request('/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              code: input.code,
              client_id: application.applicationId,
              client_secret: input.clientSecret,
              redirect_uri: redirectUri,
            }),
          }),
        );
        credential(grant.access_token);
        const grantedScopes = new Set(grant.scope.split(/\s+/));
        // Discord may report only user scopes here; bot access is verified against the guild below.
        if (!grantedScopes.has('guilds')) failure('invalid_grant');
        if (input.expectedGuildId !== undefined && grant.guild.id !== input.expectedGuildId)
          failure('guild_changed');
        const headers = { Authorization: `Bearer ${grant.access_token}` };
        const authorization = parse(authorizationSchema, await request('/oauth2/@me', { headers }));
        if (
          authorization.application.id !== application.applicationId ||
          !authorization.scopes.includes('guilds')
        )
          failure('invalid_grant');
        // guilds is the only additional scope needed to prove the installer's effective rights.
        const guilds = parse(
          userGuildsSchema,
          await request('/users/@me/guilds?limit=200', { headers }),
        );
        const managed = guilds.find((guild) => guild.id === grant.guild.id);
        if (
          !managed ||
          (!managed.owner &&
            (BigInt(managed.permissions) & manageGuildOrAdministrator) === BigInt(0))
        )
          failure('missing_permissions');
        const guild = parse(
          guildSchema,
          await request(`/guilds/${grant.guild.id}`, {
            headers: { Authorization: `Bot ${input.botToken}` },
          }),
        );
        if (guild.id !== grant.guild.id) failure('guild_changed');
        // OAuth user tokens and provider payloads never leave this private exchange.
        return { ok: true, value: { application, guildId: guild.id, guildName: guild.name } };
      } catch (error) {
        return resultError(error);
      }
    },
  };
}
