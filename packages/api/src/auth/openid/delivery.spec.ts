import { EventEmitter } from 'node:events';
import type { OpenIDDeliveryResponse } from './delivery';
import { createOpenIDResponseDelivery } from './delivery';

const tokens = {
  publicationFlightKey: 'flight-key',
  publicationFlightOwnerId: 'owner-1',
  publicationFlightCreatedAt: 1,
};
const delivery = { key: 'flight-key', ownerId: 'owner-1', deliveryId: 'delivery-1' };

function createFlight() {
  return {
    assertOpenIDRefreshSessionGenerationAvailable: jest.fn().mockResolvedValue(true),
    claimOpenIDRefreshFlightDelivery: jest.fn().mockResolvedValue({ deliveryId: 'delivery-1' }),
    assertOpenIDRefreshFlightDeliveryAvailable: jest.fn().mockResolvedValue(undefined),
    releaseOpenIDRefreshFlightDelivery: jest.fn().mockResolvedValue(undefined),
  };
}

function createResponse(closed = false): EventEmitter & OpenIDDeliveryResponse {
  return Object.assign(new EventEmitter(), { closed });
}

function setup() {
  const flight = createFlight();
  const logger = { warn: jest.fn() };
  const withDelivery = createOpenIDResponseDelivery({ flight, logger });
  return { flight, logger, withDelivery };
}

describe('createOpenIDResponseDelivery', () => {
  it('releases the lease after the send when the client already disconnected', async () => {
    const { flight, withDelivery } = setup();
    const res = createResponse(true);

    const result = await withDelivery({ res, openidTokens: tokens, context: 'test' }, (send) =>
      send(() => 'sent'),
    );

    expect(result).toBe('sent');
    expect(flight.releaseOpenIDRefreshFlightDelivery).toHaveBeenCalledTimes(1);
    expect(flight.releaseOpenIDRefreshFlightDelivery).toHaveBeenCalledWith(delivery);
    expect(res.listenerCount('finish')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });

  it('releases the lease once when an open response finishes and closes', async () => {
    const { flight, withDelivery } = setup();
    const res = createResponse();

    await withDelivery({ res, openidTokens: tokens, context: 'test' }, (send) =>
      send(() => 'sent'),
    );
    expect(flight.releaseOpenIDRefreshFlightDelivery).not.toHaveBeenCalled();

    res.emit('finish');
    res.emit('close');
    await new Promise(setImmediate);

    expect(flight.releaseOpenIDRefreshFlightDelivery).toHaveBeenCalledTimes(1);
  });

  it('releases the lease when the operation fails before sending', async () => {
    const { flight, withDelivery } = setup();

    await expect(
      withDelivery({ res: createResponse(), openidTokens: tokens, context: 'test' }, async () => {
        throw new Error('preparation failed');
      }),
    ).rejects.toThrow('preparation failed');

    expect(flight.releaseOpenIDRefreshFlightDelivery).toHaveBeenCalledTimes(1);
  });

  it('checks the session generation again at send time without a publication flight', async () => {
    const { flight, withDelivery } = setup();

    await withDelivery({ res: createResponse(), openidTokens: null, context: 'test' }, (send) =>
      send(() => 'sent'),
    );

    expect(flight.claimOpenIDRefreshFlightDelivery).not.toHaveBeenCalled();
    expect(flight.assertOpenIDRefreshSessionGenerationAvailable).toHaveBeenCalledTimes(2);
    expect(flight.releaseOpenIDRefreshFlightDelivery).not.toHaveBeenCalled();
  });

  it('warns after the last failed release attempt', async () => {
    const { flight, logger, withDelivery } = setup();
    flight.releaseOpenIDRefreshFlightDelivery.mockRejectedValue(new Error('store unavailable'));

    await withDelivery(
      { res: createResponse(true), openidTokens: tokens, context: 'test' },
      (send) => send(() => 'sent'),
    );

    expect(flight.releaseOpenIDRefreshFlightDelivery).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith('[test] Failed to release OpenID response delivery', {
      error: 'store unavailable',
    });
  });
});
