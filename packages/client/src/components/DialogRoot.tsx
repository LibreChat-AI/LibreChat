import { useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { DialogProps } from '@radix-ui/react-dialog';
import type { ReactElement } from 'react';
import { OverlayBack } from '../Providers/Overlay';

/** Observe both controlled and trigger-owned dialogs without changing their content. */
export default function DialogRoot({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: DialogProps): ReactElement {
  const [internalOpen, setInternalOpen] = useState(defaultOpen ?? false);
  const isOpen = open ?? internalOpen;
  const changeOpen = (next: boolean) => {
    if (open === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };

  return (
    <OverlayBack open={isOpen && props.modal !== false} onClose={() => changeOpen(false)}>
      <DialogPrimitive.Root {...props} open={isOpen} onOpenChange={changeOpen} />
    </OverlayBack>
  );
}
