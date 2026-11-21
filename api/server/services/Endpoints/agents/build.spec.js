const mockLoadAgent = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  loadAgent: (...args) => mockLoadAgent(...args),
}));

jest.mock('~/server/services/Config', () => ({
  getMCPServerTools: jest.fn(),
}));

jest.mock('~/models', () => ({
  getAgent: jest.fn(),
}));

const { EModelEndpoint } = require('librechat-data-provider');
const { buildOptions } = require('./build');

describe('agents buildOptions model parameters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadAgent.mockResolvedValue({ id: 'agent_123' });
  });

  it('folds UI generation params into model_parameters and omits model', () => {
    const req = { body: {} };
    const parsedBody = {
      spec: 'claude-sonnet-5',
      iconURL: 'anthropic',
      agent_id: 'agent_123',
      chatProjectId: 'project-1',
      model: 'claude-sonnet-5',
      greeting: 'Hello',
      instructions: 'Be brief',
      maxContextTokens: 1000000,
      temperature: 0.3,
      topP: 0.9,
      thinking: true,
      thinkingDisplay: 'summarized',
      effort: 'high',
    };

    const result = buildOptions(req, EModelEndpoint.agents, parsedBody);

    expect(result.model_parameters).toEqual(
      expect.objectContaining({
        greeting: 'Hello',
        instructions: 'Be brief',
        maxContextTokens: 1000000,
        temperature: 0.3,
        topP: 0.9,
        thinking: true,
        thinkingDisplay: 'summarized',
        effort: 'high',
      }),
    );
    expect(result.model_parameters).not.toHaveProperty('model');
    expect(result.spec).toBe('claude-sonnet-5');
    expect(result.agent_id).toBe('agent_123');
    expect(result.chatProjectId).toBe('project-1');

    expect(mockLoadAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        req,
        spec: 'claude-sonnet-5',
        agent_id: 'agent_123',
        endpoint: EModelEndpoint.agents,
        model_parameters: expect.objectContaining({
          maxContextTokens: 1000000,
          temperature: 0.3,
          topP: 0.9,
          thinking: true,
          thinkingDisplay: 'summarized',
          effort: 'high',
        }),
      }),
      expect.any(Object),
    );
    expect(mockLoadAgent.mock.calls[0][0].model_parameters).not.toHaveProperty('model');
  });
});
