const buildEndpointOption = require('../buildEndpointOption');

describe('buildEndpointOption user endpoint access', () => {
  it('rejects a disallowed provider before building a provider request', async () => {
    const req = {
      body: { endpoint: 'Restricted Provider', endpointType: 'custom', model: 'restricted-model' },
      user: { id: 'restricted-user-id', username: 'restricted-user' },
      config: {
        endpoints: {
          userAccess: [{ username: 'restricted-user', allowedEndpoints: ['Allowed Provider'] }],
        },
      },
      baseUrl: '/api/agents/chat',
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    await buildEndpointOption(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'This endpoint is not available for your account.',
    });
    expect(next).not.toHaveBeenCalled();
  });
});
