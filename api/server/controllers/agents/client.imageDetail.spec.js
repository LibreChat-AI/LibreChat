const mockEncodeAndFormat = jest.fn().mockResolvedValue({ files: [], image_urls: [] });

jest.mock('~/server/services/Files/images/encode', () => ({
  encodeAndFormat: (...args) => mockEncodeAndFormat(...args),
}));

const AgentClient = require('./client');

describe('AgentClient.addImageURLs - image detail', () => {
  const buildClient = (options) => {
    const client = Object.create(AgentClient.prototype);
    client.options = {
      req: { body: {} },
      endpoint: 'agents',
      agent: { id: 'agent_1', provider: 'openai' },
      ...options,
    };
    return client;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("forwards the agent's configured detail to the encoder", async () => {
    const client = buildClient({ imageDetail: 'high' });

    await client.addImageURLs({}, [{ file_id: 'f_1' }]);

    expect(mockEncodeAndFormat).toHaveBeenCalledTimes(1);
    expect(mockEncodeAndFormat.mock.calls[0][2]).toEqual(
      expect.objectContaining({ imageDetail: 'high' }),
    );
  });

  it('leaves the detail undefined when the agent configures none, so the encoder falls back', async () => {
    const client = buildClient({});

    await client.addImageURLs({}, [{ file_id: 'f_1' }]);

    expect(mockEncodeAndFormat.mock.calls[0][2].imageDetail).toBeUndefined();
  });

  it('still passes the provider and endpoint alongside the detail', async () => {
    const client = buildClient({ imageDetail: 'low' });

    await client.addImageURLs({}, [{ file_id: 'f_1' }]);

    expect(mockEncodeAndFormat.mock.calls[0][2]).toEqual({
      provider: 'openai',
      endpoint: 'agents',
      imageDetail: 'low',
    });
  });
});
