import { Spinner } from '@librechat/client';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';

/** A spinner on its own is silent to a screen reader; this announces what is loading. */
export default function Loading({ label = 'com_ui_loading' }: { label?: TranslationKeys }) {
  const localize = useLocalize();
  return (
    <div role="status" className="text-text-secondary flex items-center gap-2 text-sm">
      <Spinner className="size-4" aria-hidden="true" />
      <span>{localize(label)}</span>
    </div>
  );
}
