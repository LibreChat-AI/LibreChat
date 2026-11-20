import { Chip } from '@librechat/client';
import { discordCredentialHealthSchema } from 'librechat-data-provider';
import type { DiscordApplication, DiscordCredentialState } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';

/** The last bot-token observation, or null when it is absent, legacy or malformed. */
function observation(
  app: DiscordApplication,
): { state: DiscordCredentialState; checked: Date } | null {
  const health = discordCredentialHealthSchema.safeParse(app.credentialHealth);
  if (!health.success) return null;
  const checked = new Date(health.data.checkedAt);
  return Number.isNaN(checked.getTime()) ? null : { state: health.data.state, checked };
}

/** The header summary of the recorded bot-token check. */
export function HealthChip({ app }: { app: DiscordApplication }) {
  const localize = useLocalize();
  const state = observation(app)?.state;
  if (state === 'valid')
    return <Chip tone="success">{localize('com_ui_discord_token_valid')}</Chip>;
  if (state === 'invalid')
    return <Chip tone="error">{localize('com_ui_discord_token_invalid')}</Chip>;
  return <Chip tone="neutral">{localize('com_ui_discord_token_unknown')}</Chip>;
}

/** An absolute server time, never aged against the browser clock. */
export function CredentialHealth({ app }: { app: DiscordApplication }) {
  const localize = useLocalize();
  const health = observation(app);
  let key: TranslationKeys = 'com_ui_discord_health_unknown';
  if (health) {
    key =
      health.state === 'valid' ? 'com_ui_discord_health_valid' : 'com_ui_discord_health_invalid';
  }
  return (
    <div className="space-y-0.5 text-xs">
      <p
        role="status"
        className={health?.state === 'invalid' ? 'text-text-destructive' : 'text-text-secondary'}
      >
        {localize(key)}
      </p>
      {health && (
        <p className="text-text-secondary">
          {localize('com_ui_discord_health_checked')}{' '}
          <time dateTime={health.checked.toISOString()}>{health.checked.toLocaleString()}</time>
        </p>
      )}
      <p className="text-text-secondary">{localize('com_ui_discord_health_help')}</p>
    </div>
  );
}
