const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
const mockCreate = jest.fn();
const mockGetOpenAIClient = jest.fn();
const mockUpdateAssistantDoc = jest.fn();

jest.mock('@librechat/data-schemas', () => ({ logger: mockLogger }));
jest.mock('@librechat/api', () => ({
  resolveAssistantToolPermissions: jest.fn(async () => () => true),
}));
jest.mock('librechat-data-provider', () => ({
  FileContext: { avatar: 'avatar' },
  ToolCallTypes: {},
}));
jest.mock('~/models', () => ({
  deleteFileByFilter: jest.fn(),
  updateAssistantDoc: mockUpdateAssistantDoc,
  getAssistants: jest.fn(),
}));
jest.mock('~/server/services/Files/process', () => ({
  uploadImageBuffer: jest.fn(),
  filterFile: jest.fn(),
}));
jest.mock('~/server/middleware/assistants/validateAuthor', () => jest.fn());
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(),
}));
jest.mock('~/server/services/ActionService', () => ({
  deleteAssistantActions: jest.fn(),
  validateAndUpdateTool: jest.fn(),
}));
jest.mock('~/server/controllers/assistants/helpers', () => ({
  getOpenAIClient: mockGetOpenAIClient,
  fetchAssistants: jest.fn(),
}));
jest.mock('~/server/services/Config', () => ({
  getCachedTools: jest.fn().mockResolvedValue({}),
}));
jest.mock('~/server/services/MCP', () => ({
  healMcpToolNames: jest.fn(({ tools }) => tools),
  getAssistantToolDefinitions: jest.fn().mockResolvedValue({}),
  toProviderToolDefinition: jest.fn((tool) => tool),
}));
jest.mock('~/app/clients/tools', () => ({
  manifestToolMap: {},
  isAgentsOnlyTool: jest.fn((tool) => typeof tool === 'object'),
}));

const controllers = [require('./v1').createAssistant, require('./v2').createAssistant];

describe.each(controllers)('assistant create logging', (createAssistant) => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate.mockImplementation(async (data) => ({ id: 'assistant-1', ...data }));
    mockGetOpenAIClient.mockResolvedValue({
      openai: {
        locals: {},
        beta: { assistants: { create: mockCreate } },
      },
    });
    mockUpdateAssistantDoc.mockResolvedValue({
      conversation_starters: ['PRIVATE-SENTINEL'],
    });
  });

  it('does not log submitted assistant content or tool names', async () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    await createAssistant(
      {
        user: { id: 'user-1' },
        body: {
          endpoint: 'assistants',
          name: 'PRIVATE-SENTINEL',
          instructions: 'PRIVATE-SENTINEL',
          conversation_starters: ['PRIVATE-SENTINEL'],
          tools: [{ type: 'function', function: { name: 'PRIVATE-SENTINEL' } }],
        },
      },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(201);
    expect(
      JSON.stringify([...mockLogger.warn.mock.calls, ...mockLogger.debug.mock.calls]),
    ).not.toContain('PRIVATE-SENTINEL');
  });
});
