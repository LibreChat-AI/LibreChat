import { Navigate } from 'react-router-dom';
import { Spinner } from '@librechat/client';
import type { NavigationPage } from 'librechat-data-provider';
import { FeatureSlot, useFeaturePresentation } from './Context';

export default function FeaturePage({ page }: { page: NavigationPage }) {
  const presentation = useFeaturePresentation();
  if (presentation && !presentation.ready) {
    return (
      <div role="status" className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!presentation?.canOpenPage(page)) {
    return <Navigate to="/c/new" replace />;
  }
  return (
    <section className="flex h-full min-h-0 flex-col overflow-y-auto">
      <FeatureSlot page={page} view="page" visible />
    </section>
  );
}
