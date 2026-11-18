import { Button } from '@librechat/client';
import { useLocalize } from '~/hooks';

export default function CollectionError({ onRetry }: { onRetry: () => void }) {
  const localize = useLocalize();
  return (
    <div role="alert" className="flex flex-col items-center gap-3 p-4 text-center">
      <p className="text-text-secondary text-sm">{localize('com_ui_collection_load_error')}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {localize('com_ui_retry')}
      </Button>
    </div>
  );
}
