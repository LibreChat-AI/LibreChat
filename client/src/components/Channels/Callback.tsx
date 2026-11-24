import { useState } from 'react';
import { Input } from '@librechat/client';
import { CopyButton } from '@librechat/chat/components';
import { useCopyToClipboard } from '~/hooks';

/** A read-only setting the administrator pastes into the provider's developer portal. */
export default function Callback({
  id,
  value,
  copyLabel,
}: {
  id: string;
  value: string;
  copyLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = useCopyToClipboard({ text: value });
  return (
    /** The URL is an LTR island in either direction, and the copy button sits inside its end. */
    <div className="relative" dir="ltr">
      <Input
        id={id}
        readOnly
        value={value}
        onFocus={(event) => event.target.select()}
        variant="trailing"
      />
      <CopyButton
        isCopied={copied}
        onClick={() => copy(setCopied)}
        iconOnly
        label={copyLabel}
        className="absolute inset-e-1.5 top-1/2 size-8 -translate-y-1/2"
      />
    </div>
  );
}
