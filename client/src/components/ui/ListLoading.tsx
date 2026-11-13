import { memo } from 'react';
import { Spinner } from '@librechat/client';
import { useLocalize } from '~/hooks';

/** The list footer shown while the next page loads: a spinner beside a shimmering "Loading...". */
const ListLoading = memo(function ListLoading() {
  const localize = useLocalize();

  return (
    <div
      role="status"
      className="text-text-primary mx-auto mt-2 flex items-center justify-center gap-2"
    >
      <Spinner className="m-0" />
      <span className="shimmer">{localize('com_ui_loading')}</span>
    </div>
  );
});

export default ListLoading;
