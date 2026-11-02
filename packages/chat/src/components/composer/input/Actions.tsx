import type { MouseEvent, ReactNode, RefObject } from 'react';
import type { SteeringControls } from '../../../react/steering/useSteering';
import DuringRunSendButton from '../DuringRunSendButton';
import SendButton from '../SendButton';
import StopButton from '../StopButton';

export interface ComposerActionsProps {
  /** The draft, so the slot can tell an empty composer from one with a steer to send. */
  text: string;
  /** The button the composer's form submits through, shared by send and the during-run send. */
  submitButtonRef: RefObject<HTMLButtonElement>;
  /** A turn is running in this conversation. */
  isSubmitting: boolean;
  /** The composer is the answer box of a paused ask, so it sends even while a turn runs. */
  answersAsk: boolean;
  /** Nothing to send to: no endpoint is selected. */
  hasEndpoint: boolean;
  steering: SteeringControls;
  isNewConversation: boolean;
  getText: () => string;
  /** The during-run send consumed the draft. */
  onConsumed: () => void;
  enterToSend: boolean;
  /** Files ready to go with the next message. */
  fileCount: number;
  /** Send is unavailable for a reason other than a running turn (loading files, locked, ...). */
  sendDisabled: boolean;
  /** The during-run send is unavailable (loading files, preparing from a URL). */
  duringRunDisabled: boolean;
  showStopButton: boolean;
  setShowStopButton: (value: boolean) => void;
  stop: (e: MouseEvent<HTMLButtonElement>) => void;
  canStop: boolean;
  /** Keeps Stop visible over the during-run send while a URL prepares the turn. */
  isPreparingFromUrl: boolean;
}

/** The composer's single action slot: send when idle; while a turn runs, Stop, or the steer and
 *  queue send once there is text, with Stop kept mounted behind it so its shortcut still resolves
 *  against this form. */
export default function ComposerActions({
  text,
  submitButtonRef,
  isSubmitting,
  answersAsk,
  hasEndpoint,
  steering,
  isNewConversation,
  getText,
  onConsumed,
  enterToSend,
  fileCount,
  sendDisabled,
  duringRunDisabled,
  showStopButton,
  setShowStopButton,
  stop,
  canStop,
  isPreparingFromUrl,
}: ComposerActionsProps): ReactNode {
  const sendOwnsSlot = steering.duringRunActive && text.trim() !== '';

  const stopButton = showStopButton ? (
    <StopButton
      stop={stop}
      setShowStopButton={setShowStopButton}
      canStop={canStop}
      hidden={sendOwnsSlot && !isPreparingFromUrl}
    />
  ) : null;

  const duringRunSlot = sendOwnsSlot ? (
    <>
      <DuringRunSendButton
        ref={submitButtonRef}
        text={text}
        steering={steering}
        isNewConversation={isNewConversation}
        getText={getText}
        onConsumed={onConsumed}
        disabled={duringRunDisabled}
        enterToSend={enterToSend}
      />
      {stopButton}
    </>
  ) : (
    stopButton
  );

  if (isSubmitting && !answersAsk && duringRunSlot != null) {
    return duringRunSlot;
  }
  if (!hasEndpoint) {
    return null;
  }
  return (
    <SendButton
      ref={submitButtonRef}
      text={text}
      fileCount={fileCount}
      disabled={sendDisabled || (isSubmitting && !answersAsk)}
    />
  );
}
