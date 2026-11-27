import type { FiltersConfig } from 'librechat-data-provider';
import type { Response } from 'express';
import { blockFilteredActionProjection } from './protection';

const filters: FiltersConfig = {
  actionMetadata: {
    pii: {
      fields: ['domain'],
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private domain', regex: 'private\\.test' }],
    },
  },
};

function createResponse(): jest.Mocked<Response> {
  const response = {
    status: jest.fn(),
    json: jest.fn(),
  } as unknown as jest.Mocked<Response>;
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response;
}

describe('action projection protection', () => {
  it('blocks selected action metadata through the shared typed boundary', () => {
    const res = createResponse();

    expect(
      blockFilteredActionProjection(filters, res, {
        metadata: { domain: 'private.test' },
      }),
    ).toBe(true);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'content_filter_block', source: 'action_metadata' }),
    );
  });

  it('allows safe action projections without writing a response', () => {
    const res = createResponse();

    expect(
      blockFilteredActionProjection(filters, res, {
        metadata: { domain: 'public.test' },
      }),
    ).toBe(false);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('does not traverse action data when no relevant policy is active', () => {
    const res = createResponse();
    const functions = new Proxy([], {
      getOwnPropertyDescriptor() {
        throw new Error('must not traverse');
      },
    });

    expect(blockFilteredActionProjection({ messages: { pii: {} } }, res, { functions })).toBe(
      false,
    );
    expect(res.status).not.toHaveBeenCalled();
  });
});
