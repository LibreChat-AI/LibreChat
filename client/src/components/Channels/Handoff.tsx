import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { Alert, Button, Input } from '@librechat/client';
import { useLocalize, useCopyToClipboard } from '~/hooks';

/** The private fragment is rendered locally and never sent to a QR service or preview API. */
export default function Handoff({
  ticket,
  canResume,
  onContinue,
}: {
  ticket: string;
  canResume: boolean;
  onContinue: () => void;
}) {
  const localize = useLocalize();
  const id = useId();
  const [phone, setPhone] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const handoffUrl = ticket ? `${window.location.origin}${window.location.pathname}#${ticket}` : '';
  const copy = useCopyToClipboard({ text: handoffUrl });
  const hostname = window.location.hostname;
  const localOnly =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.startsWith('127.') ||
    hostname === '[::1]';

  return (
    <main className="bg-surface-primary text-text-primary flex min-h-screen items-center justify-center p-6">
      <section aria-labelledby={`${id}-title`} className="w-full max-w-lg space-y-5">
        <h1 id={`${id}-title`} className="text-2xl font-semibold">
          {localize(ticket ? 'com_ui_channel_handoff_title' : 'com_ui_channel_link_unusable_title')}
        </h1>
        {!ticket ? (
          <>
            <Alert variant="warning">{localize('com_ui_channel_link_invalid')}</Alert>
            <Button asChild variant="outline">
              <Link to="/">{localize('com_ui_channel_link_go_home')}</Link>
            </Button>
          </>
        ) : (
          <>
            <p className="text-text-secondary text-sm">
              {localize('com_ui_channel_handoff_description')}
            </p>
            {!canResume && (
              <Alert variant="warning">{localize('com_ui_channel_handoff_storage')}</Alert>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={onContinue}>
                {localize('com_ui_channel_handoff_continue')}
              </Button>
              <Button
                type="button"
                variant="outline"
                aria-expanded={phone}
                aria-controls={phone ? `${id}-phone` : undefined}
                onClick={() => setPhone((value) => !value)}
              >
                {localize('com_ui_channel_handoff_phone')}
              </Button>
            </div>
            {phone && (
              <div id={`${id}-phone`} className="space-y-3">
                {localOnly && (
                  <Alert variant="warning">{localize('com_ui_channel_handoff_localhost')}</Alert>
                )}
                <p className="text-text-secondary text-sm">
                  {localize('com_ui_channel_handoff_scan')}
                </p>
                <div className="bg-surface-qr mx-auto w-fit max-w-full rounded-2xl p-4">
                  <QRCodeSVG
                    value={handoffUrl}
                    size={180}
                    marginSize={2}
                    className="h-auto w-[11.25rem] max-w-full"
                    title={localize('com_ui_channel_handoff_qr')}
                  />
                </div>
                <Input
                  readOnly
                  autoComplete="off"
                  spellCheck={false}
                  dir="ltr"
                  value={handoffUrl}
                  aria-label={localize('com_ui_channel_handoff_private_link')}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setCopied(false);
                    setCopyFailed(!copy(setCopied));
                  }}
                >
                  {localize('com_ui_copy_link')}
                </Button>
                <p role="status" className="text-text-secondary text-sm">
                  {copied ? localize('com_ui_copied') : ''}
                </p>
                {copyFailed && (
                  <Alert variant="warning">{localize('com_ui_channel_handoff_copy_failed')}</Alert>
                )}
                <p className="text-text-secondary text-sm">
                  {localize('com_ui_channel_handoff_privacy')}
                </p>
              </div>
            )}
            <p className="text-text-secondary text-sm">
              {localize('com_ui_channel_handoff_expiry')}
            </p>
            <p className="text-text-secondary text-sm">
              {localize('com_ui_channel_handoff_confirmation')}
            </p>
          </>
        )}
      </section>
    </main>
  );
}
