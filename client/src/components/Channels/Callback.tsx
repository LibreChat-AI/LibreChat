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
    <div className="flex items-center gap-2">
      <Input id={id} readOnly value={value} onFocus={(event) => event.target.select()} />
      <CopyButton isCopied={copied} onClick={() => copy(setCopied)} iconOnly label={copyLabel} />
    </div>
  );
}
