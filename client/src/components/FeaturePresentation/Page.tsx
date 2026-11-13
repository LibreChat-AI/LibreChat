import { Navigate } from 'react-router-dom';
import { Spinner } from '@librechat/client';
import type { NavigationPage } from 'librechat-data-provider';
import { FeatureSlot, useFeaturePresentation } from './Context';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import useDrawerViewport from '~/hooks/Nav/useDrawerViewport';
import CollectionError from '~/components/ui/CollectionError';
import { useLocalize } from '~/hooks';

export default function FeaturePage({ page }: { page: NavigationPage }) {
  const presentation = useFeaturePresentation();
  const isSmallScreen = useDrawerViewport();
  const localize = useLocalize();
  const availability = presentation?.availability[page];
  if (presentation?.startupError) {
    return <CollectionError onRetry={presentation.startupError} />;
  }
  if (presentation && (!presentation.ready || availability?.status === 'loading')) {
    return (
      <div
        role="status"
        aria-label={localize('com_ui_loading')}
        className="flex h-full items-center justify-center"
      >
        <Spinner />
      </div>
    );
  }
  if (availability?.status === 'error') {
    return <CollectionError onRetry={availability.retry} />;
  }
  if (!presentation?.canOpenPage(page)) {
    return <Navigate to="/c/new" replace />;
  }
  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col overflow-y-auto">
      {isSmallScreen && (
        <div className="shrink-0 px-3 pt-2">
          <OpenSidebar />
        </div>
      )}
      <FeatureSlot page={page} view="page" visible />
    </section>
  );
}
