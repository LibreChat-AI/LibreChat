import { EventEmitter } from 'node:events';
import { resolveMediaConfig } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { IEventTransport } from '~/stream/interfaces/IJobStore';
import { MediaActivityStream, mediaActivityChanged, mediaActivityStreamId } from './events';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';

const scope = { ownerId: 'owner:{unsafe-hash-tag}', tenantId: 'tenant' };
const config = resolveMediaConfig({}).events;
function socket() {
  const request = new EventEmitter();
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    set: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(() => true),
    end: jest.fn(() => {
      response.writableEnded = true;
    }),
  });
  return { req: request as Request, res: response as unknown as Response, response };
}

test('delivers only to a demanded owner/tenant and closes local sockets without destroying the injected transport', async () => {
  const transport = new InMemoryEventTransport();
  const emit = jest.spyOn(transport, 'emitChunk');
  const destroy = jest.spyOn(transport, 'destroy');
  const activity = new MediaActivityStream(transport, config);
  await activity.publish(scope, { threadId: 'thread', version: 1 });
  expect(emit).not.toHaveBeenCalled();
  const socketA = socket();
  await activity.open(scope, socketA.req, socketA.res);
  expect(socketA.response.write).toHaveBeenCalledWith('data: {"ready":true}\n\n');
  await activity.publish({ ...scope, tenantId: 'foreign' }, { threadId: 'secret', version: 1 });
  expect(emit).not.toHaveBeenCalled();
  await activity.publish(scope, { threadId: 'thread', version: 2 });
  expect(socketA.response.write).toHaveBeenCalledWith(
    expect.stringContaining('"threadId":"thread"'),
  );
  expect(emit.mock.calls[0]).toHaveLength(2);
  expect(mediaActivityStreamId(scope)).not.toMatch(/[{}]/);
  activity.close();
  await Promise.resolve();
  expect(socketA.response.end).toHaveBeenCalled();
  expect(transport.getSubscriberCount(mediaActivityStreamId(scope))).toBe(0);
  expect(destroy).not.toHaveBeenCalled();
  transport.destroy();
});

test('captures and synchronizes a fresh Redis-style frontier before renewing demand', async () => {
  const transport: IEventTransport = new InMemoryEventTransport();
  const order: string[] = [];
  const subscribe = transport.subscribe.bind(transport);
  const subscribeSpy = jest.spyOn(transport, 'subscribe').mockImplementation((...args) => ({
    ...subscribe(...args),
    ready: Promise.resolve(),
    syncReorderBuffer: () => {
      order.push('frontier');
    },
  }));
  transport.renewDemand = jest.fn(async () => {
    order.push('demand');
  });
  const activity = new MediaActivityStream(transport, config);
  const opened = socket();
  await activity.open(scope, opened.req, opened.res);
  expect(subscribeSpy).toHaveBeenCalledWith(mediaActivityStreamId(scope), expect.anything(), {
    deferSequenceDelivery: true,
    captureSequenceFrontier: true,
  });
  expect(order).toEqual(['frontier', 'demand']);
  activity.close();
  transport.destroy();
});

test('progress repeats do not nudge; phase changes and newly ready outputs do', () => {
  const previous = { phase: 'ingesting' as const, outputs: [] };
  expect(mediaActivityChanged(previous, previous)).toBe(false);
  expect(mediaActivityChanged(previous, { ...previous, phase: 'succeeded' })).toBe(true);
  const next = {
    ...previous,
    outputs: [{ kind: 'text' as const, outputId: 'text', ordinal: 0, text: 'caption' }],
  };
  expect(mediaActivityChanged(previous, next)).toBe(true);
  expect(mediaActivityChanged(next, next)).toBe(false);
});
