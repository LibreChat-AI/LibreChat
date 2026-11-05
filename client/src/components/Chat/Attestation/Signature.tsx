import { useState, useCallback, memo } from 'react';
import { ShieldAlert, ShieldCheck, ShieldHalf, ShieldQuestion } from 'lucide';
import { Button, MorphIcon, OGDialog, OGDialogTrigger, TooltipAnchor } from '@librechat/client';
import type { TMessage, TNearAIReceipt } from 'librechat-data-provider';
import Verification from './Verification';
import { getReceipts } from './reports';
import { useLocalize } from '~/hooks';

const states = {
  model: [ShieldCheck, 'com_ui_nearai_signature_model', 'text-status-success'],
  gateway: [ShieldHalf, 'com_ui_nearai_signature_gateway', 'text-status-warning'],
  unverified: [ShieldQuestion, 'com_ui_nearai_signature_unverified', 'text-text-secondary'],
  failed: [ShieldAlert, 'com_ui_nearai_signature_failed', 'text-status-error'],
} as const;

function getState(receipts: TNearAIReceipt[]): keyof typeof states {
  const unverified = receipts.filter((receipt) => receipt.status !== 'verified');
  // A timeout or missing evidence is not a rejected signature.
  if (unverified.some((receipt) => receipt.report?.status !== 'unverifiable')) {
    return 'failed';
  }
  if (unverified.length > 0) {
    return 'unverified';
  }
  if (receipts.some((receipt) => receipt.signatureKind !== 'provider_tee')) {
    return 'gateway';
  }
  return 'model';
}

function Signature({ message, isLast }: { message: TMessage; isLast: boolean }) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const receipts = getReceipts(message);
  if (receipts.length === 0) {
    return null;
  }

  const state = getState(receipts);
  const [Icon, labelKey, color] = states[state];
  const label = localize(labelKey);

  return (
    <OGDialog open={open} onOpenChange={setOpen}>
      <OGDialogTrigger asChild>
        <TooltipAnchor
          description={label}
          render={
            <Button
              type="button"
              aria-label={label}
              data-testid="nearai-signature-button"
              variant={isLast ? 'message-hover' : 'message-hover-reveal'}
              data-hover-active={open || undefined}
            >
              <span className={color}>
                <MorphIcon icon={Icon} size="1.1875rem" aria-hidden="true" />
              </span>
            </Button>
          }
        />
      </OGDialogTrigger>
      {open && <Verification endpoint={message.endpoint} receipts={receipts} onClose={close} />}
    </OGDialog>
  );
}

export default memo(Signature);
