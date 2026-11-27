import { Suspense } from 'react';
import { Spinner } from '@librechat/client';
import { useDeploymentThemeOverride } from '~/Providers/DeploymentTheme';
import { lazyWithRecovery } from '~/lib/assets/lazy';

const ShareRoute = lazyWithRecovery(() => import('./ShareRoute'));

/**
 * Holds back the viewer's deployment theme until the shared view loads and reads the link's
 * own, as `ShareView` does once mounted. Its layout effect is released in the same commit that
 * mounts the view, so no frame paints the viewer's theme on the link.
 */
function ShareLoading() {
  useDeploymentThemeOverride(false, undefined);
  return (
    <div className="flex h-screen items-center justify-center">
      <Spinner />
    </div>
  );
}

/**
 * The shared-link route, mounted as soon as the router reaches it. A `lazy` route would keep
 * the previous page (and the viewer's theme) on screen while the view's code loads.
 */
export default function ShareEntry() {
  return (
    <Suspense fallback={<ShareLoading />}>
      <ShareRoute />
    </Suspense>
  );
}
