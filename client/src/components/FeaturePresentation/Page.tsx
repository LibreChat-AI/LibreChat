import { Navigate } from 'react-router-dom';
import { Spinner } from '@librechat/client';
import type { NavigationPage } from 'librechat-data-provider';
import { FeatureSlot, useFeaturePresentation } from './Context';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import useDrawerViewport from '~/hooks/Nav/useDrawerViewport';
import { useLocalize } from '~/hooks';

export default function FeaturePage({ page }: { page: NavigationPage }) {
  const presentation = useFeaturePresentation();
  const isSmallScreen = useDrawerViewport();
  const localize = useLocalize();
  if (presentation && !presentation.ready) {
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
