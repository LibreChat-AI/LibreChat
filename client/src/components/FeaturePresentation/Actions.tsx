import { Button } from '@librechat/client';
import type { NavigationPage } from 'librechat-data-provider';
import { useFeaturePresentation } from './Context';
import { useLocalize } from '~/hooks';

export default function PresentationActions({ page }: { page: NavigationPage }) {
  const presentation = useFeaturePresentation();
  const localize = useLocalize();
  if (
    !presentation?.canOpenPage(page) ||
    (presentation.relatedPage === page && presentation.page !== page)
  ) {
    return null;
  }
  const fullPage = presentation.page === page;
  return (
    <div className="flex shrink-0 justify-end px-3 pt-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => (fullPage ? presentation.minimize(page) : presentation.expand(page))}
      >
        {localize(fullPage ? 'com_ui_minimize' : 'com_ui_expand')}
      </Button>
    </div>
  );
}
