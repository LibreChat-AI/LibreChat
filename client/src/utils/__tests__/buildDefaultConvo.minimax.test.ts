import { EModelEndpoint } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import { getLocalStorageItems } from '../localStorage';
import buildDefaultConvo from '../buildDefaultConvo';

jest.mock('../localStorage', () => ({
  getLocalStorageItems: jest.fn(() => ({ lastSelectedModel: {}, lastSelectedTools: [] })),
}));

const models = ['MiniMax-M3.1-Flash', 'MiniMax-M3'];
const conversation = {
  conversationId: 'test',
  title: 'Test',
  createdAt: '2026-10-20T00:00:00Z',
  updatedAt: '2026-10-20T00:00:00Z',
  endpoint: 'MiniMax',
  endpointType: EModelEndpoint.custom,
} as TConversation;

const build = (model?: string, endpoint = 'MiniMax') =>
  buildDefaultConvo({
    models,
    conversation,
    endpoint: endpoint as EModelEndpoint,
    lastConversationSetup: model ? { ...conversation, model } : null,
  });

describe('MiniMax saved model selection', () => {
  afterEach(() => jest.clearAllMocks());

  it('defaults a fresh conversation to Flash', () => {
    expect(build().model).toBe('MiniMax-M3.1-Flash');
  });

  it.each(['MiniMax-M3', 'MiniMax-M2.7', 'my-minimax-deployment'])(
    'preserves the saved model %s without adding it to the ordinary catalog',
    (model) => {
      expect(build(model).model).toBe(model);
      expect(models).toEqual(['MiniMax-M3.1-Flash', 'MiniMax-M3']);
    },
  );

  it('preserves a legacy model stored in local storage', () => {
    jest.mocked(getLocalStorageItems).mockReturnValueOnce({
      lastSelectedModel: { MiniMax: 'MiniMax-M2.5' },
      lastSelectedTools: [],
    } as ReturnType<typeof getLocalStorageItems>);
    expect(build().model).toBe('MiniMax-M2.5');
  });

  it('leaves unrelated endpoint fallback behavior unchanged', () => {
    expect(build('unavailable', 'OtherProvider').model).toBe('MiniMax-M3.1-Flash');
  });
});
