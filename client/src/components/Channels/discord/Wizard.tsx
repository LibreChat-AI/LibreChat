import { useEffect, useId, useRef } from 'react';
import { ExternalLink } from 'lucide-react';
import { Alert, Button, Spinner } from '@librechat/client';
import type { UseFormReturn } from 'react-hook-form';
import type { FormEvent } from 'react';
import type { Fields } from './Credentials';
import SetupProgress from '~/components/Channels/SetupProgress';
import { AutoHeight } from '~/components/ui';
import Credentials from './Credentials';
import { useLocalize } from '~/hooks';
import { errorLabel } from './errors';
import Notice from '../Notice';

export type WizardStep = 1 | 2 | 3;

/** First-run setup, one screen at a time: create the app, add its credentials, connect a server. */
export default function Wizard({
  step,
  form,
  disabled,
  busy,
  saving,
  error,
  alertRef,
  onStep,
  onSubmit,
  onConnect,
  onFinish,
  onRefresh,
}: {
  step: WizardStep;
  form: UseFormReturn<Fields>;
  disabled: boolean;
  busy: boolean;
  saving: boolean;
  error: unknown;
  alertRef: (node: HTMLDivElement | null) => void;
  onStep: (step: WizardStep) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onConnect: (trigger: HTMLButtonElement) => void;
  onFinish: () => void;
  onRefresh: () => void;
}) {
  const localize = useLocalize();
  const id = useId();
  const heading = useRef<HTMLHeadingElement | null>(null);
  const first = useRef(true);
  const { errors } = form.formState;
  const steps = [
    { label: localize('com_ui_discord_wizard_create') },
    { label: localize('com_ui_discord_wizard_credentials') },
    { label: localize('com_ui_discord_connect') },
  ];
  /** The button that moved the person on has just unmounted; the new step's heading takes focus. */
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  return (
    <div className="space-y-5">
      <SetupProgress
        steps={steps}
        current={step}
        label={localize('com_ui_channels_setup_progress')}
      />

      <AutoHeight>
        <div
          key={step}
          className="animate-in fade-in-0 space-y-4 duration-200 motion-reduce:animate-none"
        >
          {step === 1 && (
            <>
              <h4 ref={heading} tabIndex={-1} className="text-sm font-medium">
                {localize('com_ui_discord_wizard_create_title')}
              </h4>
              <Button asChild variant="outline">
                <a
                  href="https://discord.com/developers/applications"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {localize('com_ui_discord_wizard_portal')}
                  <ExternalLink className="size-4" aria-hidden="true" />
                </a>
              </Button>
              <ol className="text-text-secondary list-decimal space-y-1 ps-5 text-sm marker:font-medium">
                <li>{localize('com_ui_discord_wizard_create_new')}</li>
                <li>{localize('com_ui_discord_wizard_create_grant')}</li>
                <li>{localize('com_ui_discord_wizard_create_token')}</li>
              </ol>
            </>
          )}

          {step === 2 && (
            <>
              <h4 ref={heading} tabIndex={-1} className="text-sm font-medium">
                {localize('com_ui_discord_wizard_credentials_title')}
              </h4>
              <form id={`${id}-form`} className="space-y-3" onSubmit={onSubmit}>
                <Credentials
                  id={id}
                  form={form}
                  disabled={disabled}
                  editing={false}
                  requireSecrets
                />
                {errors.root && <Alert variant="error">{errors.root.message}</Alert>}
              </form>
              {Boolean(error) && (
                <Notice
                  ref={alertRef}
                  message={localize(errorLabel(error))}
                  action={localize('com_ui_refresh')}
                  disabled={busy}
                  onAction={onRefresh}
                />
              )}
            </>
          )}

          {step === 3 && (
            <div className="space-y-1">
              <h4 ref={heading} tabIndex={-1} className="text-sm font-medium">
                {localize('com_ui_discord_wizard_connect_title')}
              </h4>
              <p className="text-text-secondary text-sm">
                {localize('com_ui_discord_wizard_connect_help')}
              </p>
            </div>
          )}
        </div>
      </AutoHeight>

      <div className="flex gap-2 pt-2">
        {step === 2 && (
          <Button type="button" variant="outline" disabled={busy} onClick={() => onStep(1)}>
            {localize('com_ui_back')}
          </Button>
        )}
        {step === 3 && (
          <Button type="button" variant="outline" disabled={busy} onClick={onFinish}>
            {localize('com_ui_done')}
          </Button>
        )}
        {step === 1 && (
          <Button type="button" className="flex-1" onClick={() => onStep(2)}>
            {localize('com_ui_continue')}
          </Button>
        )}
        {step === 2 && (
          <Button
            type="submit"
            form={`${id}-form`}
            variant="submit"
            className="flex-1"
            disabled={disabled}
          >
            {saving && <Spinner className="size-4" aria-hidden="true" />}
            {localize('com_ui_save')}
          </Button>
        )}
        {step === 3 && (
          <Button
            type="button"
            variant="submit"
            className="flex-1"
            disabled={disabled}
            onClick={(event) => onConnect(event.currentTarget)}
          >
            {localize('com_ui_discord_connect')}
          </Button>
        )}
      </div>
    </div>
  );
}
