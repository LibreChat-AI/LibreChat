import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { Alert, Button, Textarea } from '@librechat/client';
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
    <main className="bg-surface-primary text-text-primary flex min-h-screen flex-col items-center justify-center px-4 py-8">
      <section
        aria-labelledby={`${id}-title`}
        className="border-border-light bg-surface-secondary w-full max-w-sm space-y-5 overflow-hidden rounded-2xl border p-6 shadow-sm sm:p-7"
      >
        <header className="space-y-3">
          <h1 id={`${id}-title`} className="text-2xl font-semibold tracking-tight">
            {localize(
              ticket ? 'com_ui_channel_handoff_title' : 'com_ui_channel_link_unusable_title',
            )}
          </h1>
        </header>
        {!ticket ? (
          <>
            <Alert variant="warning">{localize('com_ui_channel_link_invalid')}</Alert>
            <Button asChild variant="outline">
              <Link to="/">{localize('com_ui_channel_link_go_home')}</Link>
            </Button>
          </>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={onContinue}
                aria-describedby={!canResume ? `${id}-storage` : undefined}
              >
                {localize('com_ui_channel_handoff_continue')}
              </Button>
              {!localOnly && (
                <Button
                  type="button"
                  variant="ghost"
                  aria-expanded={phone}
                  aria-controls={phone ? `${id}-phone` : undefined}
                  onClick={() => setPhone((value) => !value)}
                >
                  {localize('com_ui_channel_handoff_phone')}
                </Button>
              )}
            </div>
            {!canResume && (
              <p id={`${id}-storage`} className="text-text-secondary text-sm">
                {localize('com_ui_channel_handoff_storage')}
              </p>
            )}
            {phone && !localOnly && (
              <div id={`${id}-phone`} className="space-y-3 text-center">
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
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setCopied(false);
                    setCopyFailed(!copy(setCopied));
                  }}
                >
                  {localize(copied ? 'com_ui_copied' : 'com_ui_copy_link')}
                </Button>
                <span role="status" className="sr-only">
                  {copyFailed && localize('com_ui_channel_handoff_copy_failed')}
                  {!copyFailed && copied && localize('com_ui_copied')}
                </span>
                {copyFailed && (
                  <div className="space-y-2 text-left">
                    <p id={`${id}-copy-error`} className="text-text-secondary text-sm">
                      {localize('com_ui_channel_handoff_copy_failed')}
                    </p>
                    <Textarea
                      rows={3}
                      readOnly
                      autoComplete="off"
                      spellCheck={false}
                      dir="ltr"
                      value={handoffUrl}
                      aria-label={localize('com_ui_channel_handoff_private_link')}
                      aria-describedby={`${id}-copy-error`}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  </div>
                )}
                <p className="text-text-secondary text-sm">
                  {localize('com_ui_channel_handoff_privacy')}
                </p>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
