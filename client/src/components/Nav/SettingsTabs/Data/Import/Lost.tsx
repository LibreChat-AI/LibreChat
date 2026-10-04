import { Button } from '@librechat/client';
import useAutoFocus from './useAutoFocus';
import { useLocalize } from '~/hooks';

interface LostProps {
  onReset: () => void;
}

/**
 * Shown when the job status request fails, most often a 404 after the job
 * TTL expired or the cache was evicted. Without it the panel sits on a
 * spinner forever while polling a job that will never appear.
 */
export default function Lost({ onReset }: LostProps) {
  const localize = useLocalize();
  const ref = useAutoFocus<HTMLDivElement, boolean>(true);

  return (
    <section className="flex flex-col gap-3">
      <div
        ref={ref}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className="text-text-primary text-sm focus:outline-none"
      >
        {localize('com_ui_import_lost')}
      </div>
      <div className="flex justify-start">
        <Button variant="submit" onClick={onReset}>
          {localize('com_ui_import_another')}
        </Button>
      </div>
    </section>
  );
}
