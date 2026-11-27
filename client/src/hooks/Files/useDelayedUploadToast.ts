import { useToastContext } from '@librechat/client';
import useLocalize from '~/hooks/useLocalize';

export const useDelayedUploadToast = () => {
  const localize = useLocalize();
  const { showToast } = useToastContext();

  return (fileName: string, fileSize: number): (() => void) => {
    const delay = 5000 + Math.floor(fileSize / 1000000) * 2000;
    const timer = window.setTimeout(() => {
      dismiss = showToast({
        message: localize('com_ui_upload_delay', { 0: fileName }),
        status: 'warning',
        duration: 10000,
      });
    }, delay);
    let dismiss: (() => void) | undefined = () => window.clearTimeout(timer);

    return () => {
      dismiss?.();
      dismiss = undefined;
    };
  };
};
