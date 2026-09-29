import { memo } from 'react';
import { composerSubmitClasses, TooltipAnchor } from '@librechat/client';
import { useLocalize } from '~/hooks';

export default memo(function StopButton({
  stop,
  setShowStopButton,
}: {
  stop: (e: React.MouseEvent<HTMLButtonElement>) => void;
  setShowStopButton: (value: boolean) => void;
}) {
  const localize = useLocalize();

  return (
    <TooltipAnchor
      description={localize('com_nav_stop_generating')}
      render={
        <button
          type="button"
          data-testid="stop-generation-button"
          className={composerSubmitClasses()}
          aria-label={localize('com_nav_stop_generating')}
          onClick={(e) => {
            setShowStopButton(false);
            stop(e);
          }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="icon-lg text-surface-primary"
          >
            <rect x="7" y="7" width="10" height="10" rx="1.25" fill="currentColor"></rect>
          </svg>
        </button>
      }
    ></TooltipAnchor>
  );
});
