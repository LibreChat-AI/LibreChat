import React from 'react';
import { ZapOff } from 'lucide-react';
import * as Ariakit from '@ariakit/react';
import type { SteeringControls } from '~/hooks/Chat/useSteering';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type InterruptSteerButtonProps = {
  steering: SteeringControls;
  isNewConversation: boolean;
  getText: () => string;
  onConsumed: () => void;
  /** External hold (e.g. uploads in flight), mirroring the send button. */
  disabled?: boolean;
};

/**
 * Always-visible composer control for earlier steering. Before a conversation
 * exists, steering cannot reach the run, so this control instead stops the
 * response and sends a new turn. Its label must reflect that fallback.
 *
 * `type="button"`: the composer footer sits inside the chat form, and only
 * `DuringRunSendButton` may receive Enter's synthetic submit.
 */
const InterruptSteerButton = React.memo((props: InterruptSteerButtonProps) => {
  const localize = useLocalize();
  const { steering } = props;
  const label = localize(
    props.isNewConversation ? 'com_ui_steer_first_turn_stop' : 'com_ui_interrupt_steer_button',
  );
  /** Pre-empts the server's 409: a paused run cannot accept a steer. */
  const disabled =
    props.disabled === true || steering.pausedOnApproval || !steering.canControlGeneration;

  const onClick = () => {
    const text = props.getText().trim();
    if (text.length === 0) {
      return;
    }
    if (steering.interruptSteer(text) !== false) {
      props.onConsumed();
    }
  };

  return (
    <Ariakit.TooltipProvider placement="top" timeout={300}>
      <Ariakit.TooltipAnchor
        render={
          <button
            type="button"
            aria-label={label}
            data-testid="interrupt-steer-button"
            disabled={disabled}
            onClick={onClick}
            className={cn(
              'border-border-light size-theme-control rounded-theme-control-round flex items-center justify-center border',
              'text-text-secondary duration-theme-normal transition-colors',
              'hover:bg-surface-composer-hover hover:text-text-primary',
              'focus-visible:ring-border-xheavy focus-visible:ring-2 focus-visible:outline-hidden',
              'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
            )}
          >
            <ZapOff className="size-4" aria-hidden="true" />
          </button>
        }
      />
      <Ariakit.Tooltip className="bg-surface-tertiary text-text-primary z-50 rounded-lg px-2 py-1 text-xs shadow-lg">
        {localize(
          props.isNewConversation
            ? 'com_ui_steer_first_turn_stop_info'
            : 'com_ui_interrupt_steer_desc',
        )}
      </Ariakit.Tooltip>
    </Ariakit.TooltipProvider>
  );
});

InterruptSteerButton.displayName = 'InterruptSteerButton';

export default InterruptSteerButton;
