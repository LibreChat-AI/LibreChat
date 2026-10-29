import { z } from 'zod';
import { isIP } from 'node:net';

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^/\\?#\s:]+$/);
const positive = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');
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
  SLACK_TRANSPORT: z.enum(['socket_mode', 'webhook']).default('webhook'),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_API_BASE_URL: z.url().default('https://slack.com/api/'),
  SLACK_NATIVE_SESSIONS: flag,
  SLACK_LIFECYCLE_REACTIONS: flag,
  API_CALL_TIMEOUT_MS: positive(10000),
  AGENT_INVOKE_TIMEOUT_MS: positive(120000),
  SLACK_SIGNATURE_TOLERANCE_SECS: positive(300),
});
export type GatewayConfig = z.infer<typeof environment>;

export function loadConfig(env: NodeJS.ProcessEnv): GatewayConfig {
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
  if (config.SLACK_TRANSPORT === 'socket_mode' && !config.SLACK_APP_TOKEN)
    throw new Error('SLACK_APP_TOKEN is required for Socket Mode');
  return config;
}
