import { z } from 'zod';
import { isIP } from 'node:net';
import { channelGatewayPolicySchema, tenantIdSchema } from 'librechat-data-provider';
import type { ChannelGatewayPolicy } from 'librechat-data-provider';

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^/\\?#\s:]+$/);
const positive = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const environment = z.object({
  PORT: positive(8080).refine((value) => value <= 65535),
  LISTEN_HOST: z
    .string()
    .refine((value) => value === 'localhost' || !!isIP(value))
    .default('0.0.0.0'),
  LIBRECHAT_INTERNAL_URL: z.url().default('http://localhost:3080'),
  CHANNEL_SERVICE_TOKEN: z.string().min(1),
  CHANNEL_TENANT_ID: tenantIdSchema,
  CHANNEL_ID: identifier,
  APP_TITLE: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[^<>|\p{Cc}]+$/u)
    .default('LibreChat'),
  /** Optional deployment assertion; the service policy selects the actual ingress. */
  SLACK_TRANSPORT: z.enum(['socket_mode', 'webhook']).optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_API_BASE_URL: z.url().default('https://slack.com/api/'),
  API_CALL_TIMEOUT_MS: positive(10000),
  AGENT_INVOKE_TIMEOUT_MS: positive(120000),
});
export type GatewayConfig = z.infer<typeof environment>;
export type GatewayRuntimeConfig = GatewayConfig & {
  SLACK_TRANSPORT: ChannelGatewayPolicy['transport'];
  socketReconnectDelayMs: number;
};

export type SharedGatewayConfig = Omit<
  GatewayConfig,
  'CHANNEL_TENANT_ID' | 'CHANNEL_ID' | 'SLACK_APP_TOKEN'
>;
export type GatewayBootstrap =
  | { mode: 'single'; config: GatewayConfig }
  | { mode: 'shared'; config: SharedGatewayConfig };

function validateServiceURLs(
  config: Pick<GatewayConfig, 'LIBRECHAT_INTERNAL_URL' | 'SLACK_API_BASE_URL'>,
): void {
  for (const value of [config.LIBRECHAT_INTERNAL_URL, config.SLACK_API_BASE_URL]) {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid gateway service URL');
  }
}

function validatePolicyEnvironment(env: NodeJS.ProcessEnv): void {
  if (
    ['SLACK_NATIVE_SESSIONS', 'SLACK_LIFECYCLE_REACTIONS', 'SLACK_SIGNATURE_TOLERANCE_SECS'].some(
      (key) => env[key] !== undefined,
    )
  )
    throw new Error(
      'Configure gateway features and signature policy in librechat.yaml channel settings',
    );
}

export function loadConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  validatePolicyEnvironment(env);
  const input = env;
  const parsed = environment.safeParse(input);
  if (!parsed.success)
    throw new Error(
      `Invalid gateway configuration: ${[...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].join(', ')}`,
    );
  const config = parsed.data;
  validateServiceURLs(config);
  return config;
}

/** A bound gateway supplies both IDs; otherwise the server must authorize shared app bootstrap. */
export function loadBootstrap(env: NodeJS.ProcessEnv): GatewayBootstrap {
  if (env.CHANNEL_ID?.trim()) return { mode: 'single', config: loadConfig(env) };
  if (env.CHANNEL_TENANT_ID?.trim() && env.CHANNEL_TENANT_ID !== '_')
    throw new Error('CHANNEL_ID is required for a tenant-bound gateway');
  validatePolicyEnvironment(env);
  const parsed = environment
    .omit({ CHANNEL_TENANT_ID: true, CHANNEL_ID: true, SLACK_APP_TOKEN: true })
    .safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid gateway configuration: ${[
        ...new Set(parsed.error.issues.map((issue) => String(issue.path[0]))),
      ].join(', ')}`,
    );
  validateServiceURLs(parsed.data);
  return { mode: 'shared', config: parsed.data };
}

/** Bootstrap settings cannot override the server's current installation/ingress policy. */
export function resolveGatewayConfig(
  config: GatewayConfig,
  value: z.input<typeof channelGatewayPolicySchema>,
): GatewayRuntimeConfig {
  const parsed = channelGatewayPolicySchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid channel gateway policy');
  const policy = parsed.data;
  if (config.SLACK_TRANSPORT && config.SLACK_TRANSPORT !== policy.transport)
    throw new Error('Gateway transport does not match channel policy');
  if (policy.transport === 'socket_mode' && !config.SLACK_APP_TOKEN)
    throw new Error('SLACK_APP_TOKEN is required for Socket Mode');
  return {
    ...config,
    SLACK_TRANSPORT: policy.transport,
    socketReconnectDelayMs: policy.socketReconnectDelayMs,
  };
}
