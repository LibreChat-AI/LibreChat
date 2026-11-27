import { GraphEvents } from '@librechat/agents';
import type { EventHandler } from '@librechat/agents';

/**
 * Shared mutable offset. The host increments `offset` each time a steer part
 * is spliced into the live content array; the wrapped handlers read it at
 * handle time so every SDK-emitted content index that arrives AFTER an
 * injection lands past the inserted part.
 */
export interface SteerOffsetState {
  offset: number;
}

/**
 * Wrap a run's event handlers so content indices shift by the CURRENT steer
 * offset. The mid-run analog of `createContentIndexOffsetHandlers` (HITL
 * resume): that wrapper closes over a fixed seed length, while this one reads
 * a mutable counter because steers arrive while the run is streaming.
 *
 * The index enters the pipeline at exactly one point: `ON_RUN_STEP`'s payload
 * (whose `index` every subsequent delta resolves through the aggregator's
 * step map). `ON_AGENT_UPDATE` carries its own inline index and is shifted
 * likewise. All other handlers pass through untouched. Installed even at
 * offset 0 — the first steer can arrive at any time. Steps the aggregator has
 * ALREADY indexed are unaffected (deltas/completions resolve by step id), so
 * injection at a tool-batch boundary never re-shifts the current batch.
 *
 * Composes with the resume wrapper: apply this OVER its output so a resumed
 * run shifts by seed + live steer offset.
 */
export function createSteerIndexOffsetHandlers(
  handlers: Record<string, EventHandler> | undefined,
  state: SteerOffsetState,
): Record<string, EventHandler> | undefined {
  if (handlers == null) {
    return handlers;
  }

  const wrapped: Record<string, EventHandler> = { ...handlers };

  const runStepHandler = handlers[GraphEvents.ON_RUN_STEP];
  if (runStepHandler) {
    wrapped[GraphEvents.ON_RUN_STEP] = {
      handle: (event, data, metadata, graph) => {
        const runStep = data as { index?: number } | undefined;
        if (runStep == null || typeof runStep.index !== 'number' || state.offset === 0) {
          return runStepHandler.handle(event, data, metadata, graph);
        }
        const shifted = { ...runStep, index: runStep.index + state.offset };
        return runStepHandler.handle(event, shifted as typeof data, metadata, graph);
      },
    };
  }

  const agentUpdateHandler = handlers[GraphEvents.ON_AGENT_UPDATE];
  if (agentUpdateHandler) {
    wrapped[GraphEvents.ON_AGENT_UPDATE] = {
      handle: (event, data, metadata, graph) => {
        const update = data as { agent_update?: { index?: number } } | undefined;
        const shifted =
          update?.agent_update != null &&
          typeof update.agent_update.index === 'number' &&
          state.offset > 0
            ? {
                ...update,
                agent_update: {
                  ...update.agent_update,
                  index: update.agent_update.index + state.offset,
                },
              }
            : data;
        return agentUpdateHandler.handle(event, shifted as typeof data, metadata, graph);
      },
    };
  }

  return wrapped;
}
