import React from 'react';
import { motion } from 'framer-motion';
import { QRCodeSVG } from 'qrcode.react';
import { Button, SecretInput } from '@librechat/client';
import { useLocalize } from '~/hooks';

const fadeAnimation = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -20 },
  transition: { duration: 0.2 },
};

interface QRPhaseProps {
  secret: string;
  otpauthUrl: string;
  onNext: () => void;
  onSuccess?: () => void;
  onError?: (error: Error) => void;
}

export const QRPhase: React.FC<QRPhaseProps> = ({ secret, otpauthUrl, onNext }) => {
  const localize = useLocalize();

  return (
    <motion.div {...fadeAnimation} className="text-text-primary space-y-6">
      <div className="flex flex-col items-center space-y-6">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="bg-surface-fixed max-w-full min-w-0 rounded-2xl p-4 shadow-lg"
        >
          <QRCodeSVG
            value={otpauthUrl}
            size={240}
            className="h-auto w-60 max-w-full"
            title={localize('com_ui_2fa_scan_qr')}
          />
        </motion.div>
        <div className="w-full space-y-3">
          <p className="text-text-primary text-sm font-medium">{localize('com_ui_secret_key')}</p>
          <SecretInput
            value={secret}
            readOnly
            showCopy
            controlsOnHover
            aria-label={localize('com_ui_secret_key')}
            className="font-mono text-lg tracking-wider"
          />
        </div>
      </div>
      <Button onClick={onNext} className="w-full">
        {localize('com_ui_continue')}
      </Button>
    </motion.div>
  );
};
