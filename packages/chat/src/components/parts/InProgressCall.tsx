import type { ReactNode } from 'react';
import CancelledIcon from './CancelledIcon';

export default function InProgressCall({
  error,
  isSubmitting,
  progress,
  children,
}: {
  error?: boolean;
  isSubmitting: boolean;
  progress: number;
  children: ReactNode;
}): ReactNode {
  if ((!isSubmitting && progress < 1) || error === true) {
    return <CancelledIcon />;
  }

  return <>{children}</>;
}
