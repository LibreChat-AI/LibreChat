import { useState } from 'react';
import { CopyButton } from '@librechat/chat/components';
import { Info, ChevronDown, ExternalLink } from 'lucide-react';
import {
  Alert,
  Button,
  Input,
  Label,
  Textarea,
  SecretInput,
  InfoHoverCard,
} from '@librechat/client';
import type { TranslationKeys } from '~/hooks';
import { AutoHeight, Collapse } from '~/components/ui';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export type SetupStep = 1 | 2 | 3;

const STEPS: { step: SetupStep; label: TranslationKeys }[] = [
  { step: 1, label: 'com_ui_channels_step_create' },
  { step: 2, label: 'com_ui_channels_step_credentials' },
  { step: 3, label: 'com_ui_channels_step_activate' },
];

/** Slack opens its app-creation screen with this manifest already filled in. */
const slackCreateUrl = (manifestText: string): string => {
  try {
    const compact = JSON.stringify(JSON.parse(manifestText));
    return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(compact)}`;
  } catch {
    return 'https://api.slack.com/apps?new_app=1';
  }
};

interface ManifestViewProps {
  id: string;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  text: string;
  copied: boolean;
  onCopy: () => void;
  /** Whether the manifest starts expanded; the setup steps keep it tucked away. */
  defaultOpen?: boolean;
  /** Labels the toggle as a manual fallback for when the prefilled link does not work. */
  fallback?: boolean;
  /** Classes for the Copy control's wrapper, e.g. to sit flush inside a padded box. */
  copyClassName?: string;
}

/**
 * The Slack app manifest: read-only, with a Copy control that stays on the header row. The
 * fallback variant sits inside the wizard's AutoHeight, which already eases the height, so it
 * only mounts the box; elsewhere the box reveals through Collapse so the dialog grows with it.
 */
export function ManifestView({
  id,
  loading,
  failed,
  onRetry,
  text,
  copied,
  onCopy,
  defaultOpen = true,
  fallback = false,
  copyClassName,
}: ManifestViewProps) {
  const localize = useLocalize();
  const [open, setOpen] = useState(defaultOpen);
  const field = (
    <div className="space-y-2 pt-3">
      <Label className="sr-only" htmlFor={`${id}-manifest`}>
        {localize('com_ui_channels_manifest')}
      </Label>
      <Textarea id={`${id}-manifest`} rows={fallback ? 8 : 14} value={text} readOnly />
    </div>
  );
  return (
    <>
      {loading && <p role="status">{localize('com_ui_channels_loading')}</p>}
      {failed && (
        <div className="flex flex-col items-start gap-2">
          <Alert variant="error">{localize('com_ui_channels_manifest_error')}</Alert>
          <Button type="button" variant="outline" onClick={onRetry}>
            {localize('com_ui_channels_retry')}
          </Button>
        </div>
      )}
      {text !== '' && (
        <div className="text-sm">
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="inline-link"
              aria-expanded={open}
              aria-controls={`${id}-manifest-panel`}
              onClick={() => setOpen((value) => !value)}
            >
              <ChevronDown
                className={cn('size-4 transition-transform duration-200', !open && '-rotate-90')}
                aria-hidden="true"
              />
              {localize(
                fallback ? 'com_ui_channels_manifest_fallback' : 'com_ui_channels_manifest',
              )}
            </Button>
            <div className={copyClassName}>
              <CopyButton
                isCopied={copied}
                onClick={onCopy}
                iconOnly
                label={localize('com_ui_channels_copy_manifest')}
              />
            </div>
          </div>
          <div id={`${id}-manifest-panel`}>
            {fallback ? open && field : <Collapse open={open}>{field}</Collapse>}
          </div>
        </div>
      )}
    </>
  );
}

interface ChannelSetupProps {
  id: string;
  step: SetupStep;
  manifest: Omit<ManifestViewProps, 'id'>;
  /** The bot's name in Slack, once the manifest has loaded. */
  botName?: string;
  /** Admins see what the deployment must run before Slack can reach LibreChat. */
  isAdmin?: boolean;
  appId: string;
  onAppId: (value: string) => void;
  botToken: string;
  onBotToken: (value: string) => void;
  signingSecret: string;
  onSigningSecret: (value: string) => void;
  signingLabel: TranslationKeys;
  needsSigningSecret: boolean;
  busy: boolean;
}

/** Setting up a connection by hand, one screen at a time: create the app, add its credentials, activate. */
export default function ChannelSetup({
  id,
  step,
  manifest,
  botName,
  isAdmin = false,
  appId,
  onAppId,
  botToken,
  onBotToken,
  signingSecret,
  onSigningSecret,
  signingLabel,
  needsSigningSecret,
  busy,
}: ChannelSetupProps) {
  const localize = useLocalize();
  const progress = ((step - 1) / (STEPS.length - 1)) * 100;

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div
          role="progressbar"
          aria-label={localize('com_ui_channels_setup_progress')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
          className="bg-surface-tertiary h-1.5 overflow-hidden rounded-full"
        >
          <div
            className="bg-surface-inverted h-full rounded-full transition-all duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${progress}%` }}
          />
        </div>
        <ol className="flex justify-between text-xs">
          {STEPS.map((item) => (
            <li
              key={item.step}
              aria-current={item.step === step ? 'step' : undefined}
              className={
                item.step <= step ? 'text-text-primary font-medium' : 'text-text-secondary'
              }
            >
              {localize(item.label)}
            </li>
          ))}
        </ol>
      </div>

      <AutoHeight>
        <div
          key={step}
          className="animate-in fade-in-0 space-y-4 duration-200 motion-reduce:animate-none"
        >
          {step === 1 && (
            <>
              <h4 className="text-sm font-medium">{localize('com_ui_channels_install_step')}</h4>
              {manifest.text !== '' && (
                <Button asChild variant="outline">
                  <a href={slackCreateUrl(manifest.text)} target="_blank" rel="noopener noreferrer">
                    {localize('com_ui_channels_create_in_slack')}
                    <ExternalLink className="size-4" aria-hidden="true" />
                  </a>
                </Button>
              )}
              <ol className="text-text-secondary list-decimal space-y-1 ps-5 text-sm marker:font-medium">
                <li>{localize('com_ui_channels_create_step_workspace')}</li>
                <li>{localize('com_ui_channels_create_step_install')}</li>
              </ol>
              <ManifestView id={id} {...manifest} defaultOpen={false} fallback />
            </>
          )}

          {step === 2 && (
            <>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <h4 className="text-sm font-medium">
                    {localize('com_ui_channels_credentials_step')}
                  </h4>
                  <InfoHoverCard text={localize('com_ui_channels_credentials_where')}>
                    <Info className="text-text-tertiary size-3.5" aria-hidden="true" />
                  </InfoHoverCard>
                </div>
                <Button asChild variant="inline-link">
                  <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">
                    {localize('com_ui_slack_apps_dashboard')}
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                  </a>
                </Button>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-app`}>{localize('com_ui_channels_app_id')}</Label>
                <Input
                  id={`${id}-app`}
                  placeholder={localize('com_ui_channels_app_id_example')}
                  autoComplete="off"
                  value={appId}
                  disabled={busy}
                  onChange={(event) => onAppId(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-token`}>{localize('com_ui_channels_bot_token')}</Label>
                <SecretInput
                  id={`${id}-token`}
                  placeholder={localize('com_ui_channels_bot_token_example')}
                  autoComplete="new-password"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  value={botToken}
                  disabled={busy}
                  onChange={(event) => onBotToken(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-secret`}>{localize(signingLabel)}</Label>
                <SecretInput
                  id={`${id}-secret`}
                  placeholder={localize('com_ui_channels_signing_secret_example')}
                  required={needsSigningSecret}
                  aria-required={needsSigningSecret}
                  autoComplete="new-password"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  value={signingSecret}
                  disabled={busy}
                  onChange={(event) => onSigningSecret(event.target.value)}
                />
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <h4 className="text-sm font-medium">{localize('com_ui_channels_review_step')}</h4>
                  {isAdmin && (
                    <InfoHoverCard text={localize('com_ui_channels_gateway_admin_note')}>
                      <Info className="text-text-tertiary size-3.5" aria-hidden="true" />
                    </InfoHoverCard>
                  )}
                </div>
                <p className="text-text-secondary text-sm">
                  {botName
                    ? localize('com_ui_channels_review_named_help', { 0: botName })
                    : localize('com_ui_channels_review_help')}
                </p>
              </div>
              <dl className="border-border-light divide-border-light divide-y rounded-xl border text-sm">
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <dt className="text-text-secondary">{localize('com_ui_channels_app_id')}</dt>
                  <dd className="text-text-primary font-mono text-xs break-all">{appId}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <dt className="text-text-secondary">{localize('com_ui_channels_bot_token')}</dt>
                  <dd className="text-text-primary font-mono text-xs">{'\u2022'.repeat(10)}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <dt className="text-text-secondary">{localize(signingLabel)}</dt>
                  <dd className="text-text-primary text-xs">
                    {localize(signingSecret === '' ? 'com_ui_unset' : 'com_ui_set')}
                  </dd>
                </div>
              </dl>
            </>
          )}
        </div>
      </AutoHeight>
    </div>
  );
}

/** The setup navigation, drawn in the dialog footer: back, then forward or the final Activate. */
export function SetupActions({
  step,
  onStep,
  busy,
  canActivate,
  alreadyActive,
  onActivate,
}: {
  step: SetupStep;
  onStep: (step: SetupStep) => void;
  busy: boolean;
  /** Whether the entered credentials are complete enough to try. */
  canActivate: boolean;
  alreadyActive: boolean;
  onActivate: () => void;
}) {
  const localize = useLocalize();
  return (
    <>
      {step > 1 && (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => onStep((step - 1) as SetupStep)}
        >
          {localize('com_ui_back')}
        </Button>
      )}
      {step < 3 ? (
        <Button
          type="button"
          className="flex-1"
          disabled={busy || (step === 2 && !canActivate)}
          onClick={() => onStep((step + 1) as SetupStep)}
        >
          {localize('com_ui_continue')}
        </Button>
      ) : (
        <Button
          type="button"
          variant="submit"
          className="flex-1"
          disabled={busy || alreadyActive || !canActivate}
          onClick={onActivate}
        >
          {localize('com_ui_channels_activate')}
        </Button>
      )}
    </>
  );
}
