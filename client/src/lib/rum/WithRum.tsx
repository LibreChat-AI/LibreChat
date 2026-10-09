import type { ReactNode } from 'react';
import useRum from './useRum';

export default function WithRum({ children }: { children: ReactNode }) {
  useRum();

  return <>{children}</>;
}
