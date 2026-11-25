import { GraphEvents } from '@librechat/agents';
import type { EventHandler } from '@librechat/agents';
import { createContentIndexOffsetHandlers } from '~/agents/hitl/resume';
import { createSteerIndexOffsetHandlers } from '../offset';

type CapturedCall = { event: string; data: unknown };

function captureHandler(calls: CapturedCall[]): EventHandler {
  return {
    handle: (event, data) => {
      calls.push({ event: event as string, data });
    },
  };
}

describe('createSteerIndexOffsetHandlers', () => {
  it('returns undefined handlers untouched', () => {
    expect(createSteerIndexOffsetHandlers(undefined, { offset: 0 })).toBeUndefined();
  });

  it('passes indices through at offset 0 and shifts after increments (read at handle time)', () => {
    const calls: CapturedCall[] = [];
    const state = { offset: 0 };
    const wrapped = createSteerIndexOffsetHandlers(
      { [GraphEvents.ON_RUN_STEP]: captureHandler(calls) },
      state,
    );

    const handler = wrapped![GraphEvents.ON_RUN_STEP];
    handler.handle(
      GraphEvents.ON_RUN_STEP,
      { id: 'step-1', index: 0 } as never,
      undefined,
      undefined,
    );
    state.offset = 1;
    handler.handle(
      GraphEvents.ON_RUN_STEP,
      { id: 'step-2', index: 1 } as never,
      undefined,
      undefined,
    );
    state.offset = 2;
    handler.handle(
      GraphEvents.ON_RUN_STEP,
      { id: 'step-3', index: 2 } as never,
      undefined,
      undefined,
    );

    expect(calls.map((c) => (c.data as { index: number }).index)).toEqual([0, 2, 4]);
  });

  it('shifts ON_AGENT_UPDATE inline indices by the live offset', () => {
    const calls: CapturedCall[] = [];
    const state = { offset: 0 };
    const wrapped = createSteerIndexOffsetHandlers(
      { [GraphEvents.ON_AGENT_UPDATE]: captureHandler(calls) },
      state,
    );

    const handler = wrapped![GraphEvents.ON_AGENT_UPDATE];
    handler.handle(
      GraphEvents.ON_AGENT_UPDATE,
      { agent_update: { index: 3, runId: 'run-1' } } as never,
      undefined,
      undefined,
    );
    state.offset = 2;
    handler.handle(
      GraphEvents.ON_AGENT_UPDATE,
      { agent_update: { index: 4, runId: 'run-1' } } as never,
      undefined,
      undefined,
    );

    expect(
      calls.map((c) => (c.data as { agent_update: { index: number } }).agent_update.index),
    ).toEqual([3, 6]);
  });

  it('leaves index-less payloads and other handlers untouched', () => {
    const calls: CapturedCall[] = [];
    const state = { offset: 5 };
    const passthrough = captureHandler(calls);
    const wrapped = createSteerIndexOffsetHandlers(
      {
        [GraphEvents.ON_RUN_STEP]: captureHandler(calls),
        [GraphEvents.ON_MESSAGE_DELTA]: passthrough,
      },
      state,
    );

    expect(wrapped![GraphEvents.ON_MESSAGE_DELTA]).toBe(passthrough);
    wrapped![GraphEvents.ON_RUN_STEP].handle(
      GraphEvents.ON_RUN_STEP,
      { id: 'step-x' } as never,
      undefined,
      undefined,
    );
    expect(calls[0].data).toEqual({ id: 'step-x' });
  });

  it('composes over the resume offset wrapper: seed shift + live steer shift', () => {
    const calls: CapturedCall[] = [];
    const seedContent = [{ type: 'text' }, { type: 'text' }];
    const state = { offset: 0 };
    const wrapped = createSteerIndexOffsetHandlers(
      createContentIndexOffsetHandlers(
        { [GraphEvents.ON_RUN_STEP]: captureHandler(calls) },
        seedContent,
      ),
      state,
    );

    const handler = wrapped![GraphEvents.ON_RUN_STEP];
    handler.handle(
      GraphEvents.ON_RUN_STEP,
      { id: 'step-1', index: 0 } as never,
      undefined,
      undefined,
    );
    state.offset = 1;
    handler.handle(
      GraphEvents.ON_RUN_STEP,
      { id: 'step-2', index: 1 } as never,
      undefined,
      undefined,
    );

    // seed offset (2) applies inside; steer offset applies on top
    expect(calls.map((c) => (c.data as { index: number }).index)).toEqual([2, 4]);
  });
});
