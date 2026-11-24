import type { TranslationKeys } from '~/hooks';

export type DiscordErrorContext = 'read' | 'write';

type Overrides = {
  /** Wording for a failed read that is not a known code, such as "Couldn't load your Direct messages." */
  read?: TranslationKeys;
  /** Wording for a write whose outcome is unknown. */
  write?: TranslationKeys;
  /** Surface-specific wording for a status (`403`, `404`) or a code. */
  known?: Partial<Record<string, TranslationKeys>>;
};

const known: Record<string, TranslationKeys> = {
  '403': 'com_ui_discord_admin',
  '404': 'com_ui_discord_disabled',
  forbidden: 'com_ui_discord_admin',
  not_configured: 'com_ui_discord_disabled',
  disabled: 'com_ui_discord_disabled',
  transactions_unavailable: 'com_ui_channels_transaction_required',
  application_changed: 'com_ui_discord_changed',
  installation_changed: 'com_ui_discord_changed',
  installation_unavailable: 'com_ui_discord_changed',
  route_changed: 'com_ui_discord_changed',
  guild_changed: 'com_ui_discord_changed',
  changed: 'com_ui_discord_changed',
  provider_refused: 'com_ui_discord_refused',
  unsupported_installation: 'com_ui_discord_code_grant',
  application_in_use: 'com_ui_discord_in_use',
  missing_permissions: 'com_ui_discord_binding_permissions',
  unsupported_channel: 'com_ui_discord_binding_unsupported',
  rate_limited: 'com_ui_discord_rate_limited',
  provider_unavailable: 'com_ui_discord_provider_unavailable',
  timeout: 'com_ui_discord_timeout',
  capacity: 'com_ui_discord_dm_capacity',
  invalid_code: 'com_ui_discord_dm_invalid_code',
  invalid_input: 'com_ui_discord_invalid',
  invalid_state: 'com_ui_discord_oauth_restart',
};

function field(error: unknown, name: 'code' | 'status'): unknown {
  return error instanceof Error && name in error
    ? (error as Error & Record<string, unknown>)[name]
    : undefined;
}

/**
 * Whether LibreChat itself could not be reached: the data layer saw no HTTP response (code
 * `unavailable`, no status), or a gateway answered for it. A named Discord failure is never this,
 * even when it also has no status.
 */
export function isUnreachable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = field(error, 'code');
  if (code !== undefined && code !== 'unavailable') return false;
  const status = field(error, 'status');
  const gateway = status === 502 || status === 503 || status === 504;
  return gateway || (code === 'unavailable' && typeof status !== 'number');
}

/**
 * Safe codes only; error messages are never shown. A failure with no named cause is worded by what
 * the person was doing: a read that did not load, or a write whose outcome is not known.
 */
export function discordErrorLabel(
  error: unknown,
  context: DiscordErrorContext,
  overrides: Overrides = {},
): TranslationKeys {
  const code = field(error, 'code');
  const status = field(error, 'status');
  const named = [status === 403 || status === 404 ? String(status) : undefined, code]
    .filter((item): item is string => typeof item === 'string')
    .map((item) => overrides.known?.[item] ?? known[item])
    .find(Boolean);
  if (named) return named;
  if (isUnreachable(error)) return 'com_ui_discord_unreachable';
  if (context === 'read') return overrides.read ?? 'com_ui_discord_load_failed';
  return overrides.write ?? 'com_ui_discord_error';
}
