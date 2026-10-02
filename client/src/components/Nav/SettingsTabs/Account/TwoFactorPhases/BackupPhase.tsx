import React from 'react';
import { motion } from 'framer-motion';
import { Download } from 'lucide-react';
import { Button } from '@librechat/client';
import { useLocalize } from '~/hooks';

const fadeAnimation = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -20 },
  transition: { duration: 0.2 },
};

interface BackupPhaseProps {
  onNext: () => void;
  onError: (error: Error) => void;
  backupCodes: string[];
  onDownload: () => void;
  downloaded: boolean;
  isCompleting?: boolean;
}

export const BackupPhase: React.FC<BackupPhaseProps> = ({
  backupCodes,
  onDownload,
  downloaded,
  onNext,
  isCompleting = false,
}) => {
  const localize = useLocalize();

  return (
    <motion.div {...fadeAnimation} className="text-text-primary space-y-6">
      <p className="text-text-primary text-sm break-keep">
        {localize('com_ui_download_backup_tooltip')}
      </p>
      <div className="bg-surface-secondary grid grid-cols-2 gap-4 rounded-xl p-6">
        {backupCodes.map((code, index) => (
          <motion.div
            key={code}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.1 }}
            className="bg-surface-tertiary rounded-lg p-3"
          >
            <div className="flex items-center justify-between">
              <span className="text-text-primary hidden text-sm sm:inline">#{index + 1}</span>
              <span className="text-text-primary font-mono text-lg">{code}</span>
            </div>
          </motion.div>
        ))}
      </div>
      <div className="flex gap-4">
        <Button
          variant="outline"
          onClick={onDownload}
          className="flex-1 gap-2"
          aria-label={localize('com_ui_download_backup')}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">{localize('com_ui_download_backup')}</span>
        </Button>
        <Button onClick={onNext} disabled={!downloaded || isCompleting} className="flex-1">
          {isCompleting ? localize('com_ui_loading') : localize('com_ui_complete_setup')}
        </Button>
      </div>
    </motion.div>
  );
};
