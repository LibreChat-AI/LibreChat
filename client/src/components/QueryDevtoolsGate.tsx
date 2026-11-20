import { Suspense } from 'react';
import { importWithRecovery, lazyWithRecovery } from '~/lib/assets/lazy';

interface QueryDevtoolsConfig {
  enableQueryDevtools?: boolean;
}

interface QueryDevtoolsGateProps {
  config?: QueryDevtoolsConfig;
  isDevelopment?: boolean;
}

const LazyReactQueryDevtools = lazyWithRecovery(() =>
  importWithRecovery(() => import('@tanstack/react-query-devtools/production')).then(
    ({ ReactQueryDevtools }) => ({ default: ReactQueryDevtools }),
  ),
);

export const shouldEnableQueryDevtools = ({
  isDevelopment = import.meta.env.DEV,
  config = typeof window === 'undefined' ? undefined : window.__LIBRECHAT_CONFIG__,
}: QueryDevtoolsGateProps = {}) => isDevelopment || config?.enableQueryDevtools === true;

export default function QueryDevtoolsGate({ isDevelopment, config }: QueryDevtoolsGateProps = {}) {
  if (!shouldEnableQueryDevtools({ isDevelopment, config })) {
    return null;
  }

  return (
    <Suspense fallback={null}>
      <LazyReactQueryDevtools initialIsOpen={false} position="top-right" />
    </Suspense>
  );
}
