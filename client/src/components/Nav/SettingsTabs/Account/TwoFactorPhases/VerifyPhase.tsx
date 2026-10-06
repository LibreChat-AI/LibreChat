import React from 'react';
import { motion } from 'framer-motion';
import { REGEXP_ONLY_DIGITS } from 'input-otp';
import {
  Button,
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from '@librechat/client';
import { useLocalize } from '~/hooks';

const fadeAnimation = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -20 },
  transition: { duration: 0.2 },
};

interface VerifyPhaseProps {
  token: string;
  onTokenChange: (value: string) => void;
  isVerifying: boolean;
  onNext: () => void;
  onError: (error: Error) => void;
}

export const VerifyPhase: React.FC<VerifyPhaseProps> = ({
  token,
  onTokenChange,
  isVerifying,
  onNext,
}) => {
  const localize = useLocalize();

  return (
    <motion.div {...fadeAnimation} className="text-text-primary space-y-8">
      <div className="flex justify-center">
        <InputOTP
          aria-label={localize('com_ui_2fa_verification_required')}
          value={token}
          onChange={onTokenChange}
          maxLength={6}
          pattern={REGEXP_ONLY_DIGITS}
          className="gap-2"
        >
          <InputOTPGroup>
            {Array.from({ length: 3 }).map((_, i) => (
              <InputOTPSlot key={i} index={i} />
            ))}
          </InputOTPGroup>
          <InputOTPSeparator />
          <InputOTPGroup>
            {Array.from({ length: 3 }).map((_, i) => (
              <InputOTPSlot key={i + 3} index={i + 3} />
            ))}
          </InputOTPGroup>
        </InputOTP>
      </div>
      <Button onClick={onNext} disabled={isVerifying || token.length !== 6} className="w-full">
        {localize('com_ui_verify')}
      </Button>
    </motion.div>
  );
};
