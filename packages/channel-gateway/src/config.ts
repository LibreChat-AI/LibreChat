import { z } from 'zod';
import { isIP } from 'node:net';
import { channelGatewayPolicySchema } from 'librechat-data-provider';
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
  CHANNEL_TENANT_ID: identifier,
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

export function loadConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  if (
    ['SLACK_NATIVE_SESSIONS', 'SLACK_LIFECYCLE_REACTIONS', 'SLACK_SIGNATURE_TOLERANCE_SECS'].some(
      (key) => env[key] !== undefined,
    )
  )
    throw new Error(
      'Configure gateway features and signature policy in librechat.yaml channel settings',
    );
  const input = {
    ...env,
    CHANNEL_TENANT_ID: env.CHANNEL_TENANT_ID ?? env.SLACK_SOCKET_TENANT_ID,
    CHANNEL_ID: env.CHANNEL_ID ?? env.SLACK_SOCKET_CHANNEL_ID,
  };
  for (const [name, alias] of [
    ['CHANNEL_TENANT_ID', 'SLACK_SOCKET_TENANT_ID'],
    ['CHANNEL_ID', 'SLACK_SOCKET_CHANNEL_ID'],
  ]) {
    if (env[name] !== undefined && env[alias] && env[name] !== env[alias])
      throw new Error('Conflicting channel bindings');
  }
  if (env.DURABLE_RUNS_ENABLED === 'false')
    throw new Error('Actor-bound durable execution is required');
  const parsed = environment.safeParse(input);
  if (!parsed.success)
    throw new Error(
      `Invalid gateway configuration: ${[...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].join(', ')}`,
    );
  const config = parsed.data;
  const backend = new URL(config.LIBRECHAT_INTERNAL_URL);
  const slack = new URL(config.SLACK_API_BASE_URL);
  for (const url of [backend, slack]) {
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid gateway service URL');
  }
  return config;
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
