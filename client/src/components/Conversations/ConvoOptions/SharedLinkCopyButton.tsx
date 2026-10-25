import { useState } from 'react';
import { Input } from '@librechat/client';
import CopyButton from '~/components/Messages/Content/CopyButton';
import { useCopyToClipboard, useLocalize } from '~/hooks';
import { useLiveAnnouncer } from '~/Providers';

export default function SharedLinkCopyButton({ sharedLink }: { sharedLink: string }) {
  const localize = useLocalize();
  const { announcePolite } = useLiveAnnouncer();
  const [isCopied, setIsCopied] = useState(false);
  const copyLink = useCopyToClipboard({ text: sharedLink });

  const handleCopy = () => {
    if (isCopied) {
      return;
    }

    if (!copyLink(setIsCopied)) {
      return;
    }

    announcePolite({ message: localize('com_ui_link_copied'), isStatus: true });
  };

  return (
    /** The URL is an LTR island in either direction, and the copy button sits at its end. */
    <div className="relative" dir="ltr">
      <Input
        type="text"
        readOnly
        value={sharedLink}
        aria-label={localize('com_ui_shared_link')}
        onFocus={(event) => event.currentTarget.select()}
        className="bg-surface-secondary text-text-primary h-11 rounded-xl pr-12 text-end text-sm"
        data-testid="shared-link-url"
      />
      <CopyButton
        iconOnly
        isCopied={isCopied}
        label={localize('com_ui_copy_link')}
        copiedLabel={localize('com_ui_copied')}
        onClick={handleCopy}
        className="absolute inset-e-1.5 top-1/2 size-8 -translate-y-1/2"
      />
    </div>
  );
}
