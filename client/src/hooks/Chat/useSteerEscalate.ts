import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { useToastContext } from '@librechat/client';
import { useRecoilValue, useRecoilCallback } from 'recoil';
import { supportsGenerationProtocolV2, useArmSteerMutation } from '~/data-provider';
import { escalatingSteerFamily } from '~/store/steer';
import useLocalize from '~/hooks/useLocalize';
import store from '~/store';

/** Axios has no default request timeout. Bound the UI lock while preserving an
 *  honest unknown outcome; the idempotent arm may still complete server-side. */
const ARM_CONFIRM_TIMEOUT_MS = 10_000;

type ArmFailure = {
  name?: string;
  response?: { data?: { code?: string } };
};

/** Only a failure without an HTTP response leaves the server-side outcome
 * unknown. An HTTP rejection is a known response and must not replay the arm. */
const isAmbiguousArmFailure = (error: unknown): boolean => {
  const failure = error as ArmFailure | null | undefined;
  return failure?.name !== 'AbortError' && failure?.response == null;
};

const armFailureCode = (error: unknown): string | undefined =>
  (error as ArmFailure | null | undefined)?.response?.data?.code;

export interface EscalateTarget {
  steerId: string;
  /** The generation that owns this steer receipt; falls back to the active one. */
  generationCreatedAt?: number;
}

/**
 * Escalates a waiting steer to an interrupt: one idempotent server op flips
 * `preempt` on the EXISTING queued item, so its FIFO position, id, and
 * timestamp survive and there is no reclaim window to race. A transport
 * failure is retried once because the first request may have committed even
 * though its response was lost. Every "too late" interleaving (drained,
 * cancelled, run ended or replaced) is the same honest `armed: false`, and the
 * chip is only relabelled on a confirmed durable arm.
 *
 * Extracted from the surfaces so the queue rail and the in-thread pending
 * steers escalate through identical race rules rather than two approximations.
 * `onArmed` lets a caller move focus off a control the success state removes.
 */
export default function useSteerEscalate(conversationId: string) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { mutateAsync: armSteer } = useArmSteerMutation();
  const setEscalating = useSetAtom(escalatingSteerFamily(conversationId));
  const activeGenerationCreatedAt = useRecoilValue(
    store.activeGenerationCreatedAtByConvoId(conversationId),
  );
  const activeGenerationProtocolVersion = useRecoilValue(
    store.activeGenerationProtocolVersionByConvoId(conversationId),
  );

  /** Relabels the chip in place once the server confirms the durable arm:
   *  same steerId, same position, only the `preempt` flag flips. */
  const markSteerPreempt = useRecoilCallback(
    ({ set }) =>
      (steerId: string, revision: number) =>
        set(store.pendingSteersByConvoId(conversationId), (prev) =>
          prev.map((item) =>
            item.steerId === steerId && revision >= (item.preemptRevision ?? 0)
              ? { ...item, preempt: true, preemptRevision: revision }
              : item,
          ),
        ),
    [conversationId],
  );

  return useCallback(
    (target: EscalateTarget, onArmed?: () => void) => {
      const generationCreatedAt = target.generationCreatedAt ?? activeGenerationCreatedAt;
      if (generationCreatedAt == null) {
        return;
      }
      setEscalating(true);
      const params = { conversationId, steerId: target.steerId, generationCreatedAt };
      const requestArm = async () => {
        let firstResponseWasLost = false;
        let acceptingRetry = true;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const firstAttempt = armSteer(params);
          const attempts =
            activeGenerationProtocolVersion === 2
              ? firstAttempt.catch((error) => {
                  /** If the overall confirmation window already closed, do not let a
                   *  very late rejection launch a detached retry behind the user's
                   *  back. The first request itself may still have committed. */
                  if (!acceptingRetry) {
                    throw error;
                  }
                  if (!isAmbiguousArmFailure(error)) {
                    throw error;
                  }
                  firstResponseWasLost = true;
                  return armSteer(params);
                })
              : firstAttempt;
          const response = await Promise.race([
            attempts,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () => reject(new Error('Steer arm confirmation timed out')),
                ARM_CONFIRM_TIMEOUT_MS,
              );
            }),
          ]);
          const responseSupportsNegotiatedProtocol =
            activeGenerationProtocolVersion === 1 || supportsGenerationProtocolV2(response);
          if (responseSupportsNegotiatedProtocol && response.armed === true) {
            markSteerPreempt(target.steerId, response.preemptRevision ?? 0);
            onArmed?.();
            return;
          }
          if (!responseSupportsNegotiatedProtocol) {
            showToast({ message: localize('com_ui_steer_arm_unconfirmed'), status: 'warning' });
            return;
          }
          /** Once a response was lost, a later `armed: false` cannot prove the
           *  first request did not commit: the steer may have drained or the job
           *  may have paused between attempts. Keep the chip event-driven and
           *  report the result as unknown instead of claiming a lost race. */
          if (firstResponseWasLost) {
            showToast({ message: localize('com_ui_steer_arm_unconfirmed'), status: 'warning' });
            return;
          }
          /* `armed: false` is deliberately ambiguous (injected, cancelled,
           * re-homed, or run over), so the message only says the escalation
           * lost, and the chip defers to the events for what happened. */
          showToast({
            message: localize(
              response.code === 'PREEMPT_UNSUPPORTED'
                ? 'com_ui_steer_preempt_unsupported'
                : 'com_ui_steer_arm_lost_race',
            ),
            status: 'info',
          });
        } catch (error) {
          if (isAmbiguousArmFailure(error)) {
            showToast({ message: localize('com_ui_steer_arm_unconfirmed'), status: 'warning' });
            return;
          }
          showToast({
            message: localize(
              armFailureCode(error) === 'PREEMPT_UNSUPPORTED'
                ? 'com_ui_steer_preempt_unsupported'
                : 'com_ui_steer_arm_lost_race',
            ),
            status: 'info',
          });
        } finally {
          acceptingRetry = false;
          clearTimeout(timeout);
        }
      };
      void requestArm().finally(() => setEscalating(false));
    },
    [
      armSteer,
      conversationId,
      activeGenerationCreatedAt,
      activeGenerationProtocolVersion,
      setEscalating,
      markSteerPreempt,
      showToast,
      localize,
    ],
  );
}
