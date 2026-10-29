export type ComposerSubmitRoute = {
  answerMode: { active: boolean; submitText: (text: string) => boolean };
  steering: { duringRunActive: boolean; submitDuringRun: (text: string) => boolean };
  submitMessage: (data: { text: string }) => false | void;
  reset: () => void;
};

/**
 * One route for every submission that originates in the composer, whether
 * typed, dictated, or bound to a shortcut. Answer mode takes the text for the
 * paused run; during a run, or while a queued follow-up is about to start, the
 * text steers or queues per the effective action instead of starting a turn
 * that would race the one already owed. `false` means the composer keeps the
 * text, exactly as a refused send does.
 */
export function submitFromComposer(
  route: ComposerSubmitRoute,
  data: { text: string },
): false | void {
  if (route.answerMode.active && route.answerMode.submitText(data.text)) {
    return;
  }
  if (route.steering.duringRunActive) {
    if (!route.steering.submitDuringRun(data.text)) {
      return false;
    }
    route.reset();
    return;
  }
  return route.submitMessage(data);
}
